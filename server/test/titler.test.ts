import { describe, it, expect, vi } from 'vitest';
import {
  MAX_PROMPT_CHARS,
  SessionTitler,
  buildTitlePrompt,
  parseTitleReply,
} from '../src/titler/titler.js';
import type { ChatMessage } from '../src/types.js';

const userMsg = (text: string): ChatMessage => ({ id: text, role: 'user', text });

const MESSAGES = [
  userMsg('the space map zoom feels wrong'),
  userMsg('planets are too small when zoomed out'),
  userMsg('counter-zoom the bodies below the default'),
];

/** Fake SDK: one assistant message carrying `reply`, then a result. */
function fakeQueryFn(reply: string) {
  return vi.fn(({ options }: { prompt: string; options: Record<string, unknown> }) => {
    async function* gen() {
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } };
      yield { type: 'result', subtype: 'success' };
    }
    void options;
    return gen();
  });
}

function makeTitler(opts: { reply?: string; title?: string }) {
  const queryFn = fakeQueryFn(opts.reply ?? 'Space map counter-zoom');
  const applyTitle = vi.fn();
  const titler = new SessionTitler({
    queryFn: queryFn as never,
    readSession: () => ({ title: opts.title ?? 'Tag rules ordering' }),
    applyTitle,
  });
  return { titler, queryFn, applyTitle };
}

/**
 * A transcript is arbitrary text, and so is a model's reply to it. Everything
 * the prompt asks for is re-checked here, because a prompt is a request and
 * this is the enforcement.
 */
describe('parseTitleReply', () => {
  it('returns the name from a plain reply', () => {
    expect(parseTitleReply('Auto-title sessions')).toBe('Auto-title sessions');
  });

  it('trims surrounding whitespace and a trailing newline', () => {
    expect(parseTitleReply('  Tag rules ordering\n')).toBe('Tag rules ordering');
  });

  it('returns null for KEEP, whatever its case', () => {
    expect(parseTitleReply('KEEP')).toBeNull();
    expect(parseTitleReply(' keep ')).toBeNull();
  });

  it('strips matching surrounding quotes', () => {
    expect(parseTitleReply('"Space map zoom"')).toBe('Space map zoom');
    expect(parseTitleReply("'Space map zoom'")).toBe('Space map zoom');
  });

  it('drops a trailing period rather than the whole reply', () => {
    expect(parseTitleReply('Space map zoom.')).toBe('Space map zoom');
  });

  it('returns null for a reply longer than 48 characters', () => {
    expect(parseTitleReply('x'.repeat(49))).toBeNull();
  });

  it('returns null for an empty or whitespace reply', () => {
    expect(parseTitleReply('')).toBeNull();
    expect(parseTitleReply('   ')).toBeNull();
  });

  it('returns null when the model explained itself over several lines', () => {
    expect(parseTitleReply('Space map zoom\n\nI chose this because…')).toBeNull();
  });
});

describe('buildTitlePrompt', () => {
  it('names the current title and quotes the session back', () => {
    const prompt = buildTitlePrompt('Tag rules ordering', [userMsg('fix the rule order')]);
    expect(prompt).toContain('Current name: Tag rules ordering');
    expect(prompt).toContain('fix the rule order');
  });

  it('renders a tool call as a one-liner, not as its input JSON', () => {
    const prompt = buildTitlePrompt('x', [
      { id: '1', role: 'tool_use', toolName: 'Bash', toolInput: { command: 'npm test' } },
    ]);
    expect(prompt).toContain('Bash: npm test');
    expect(prompt).not.toContain('{');
  });

  it('cuts a long message rather than sending the whole essay', () => {
    const prompt = buildTitlePrompt('x', [userMsg('a'.repeat(500))]);
    expect(prompt).not.toContain('a'.repeat(300));
  });

  it('keeps the newest messages when the block would run over the cap', () => {
    const many = Array.from({ length: 200 }, (_, i) => userMsg(`message number ${i}`));
    const prompt = buildTitlePrompt('x', many);
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(prompt).toContain('message number 199');
    expect(prompt).not.toContain('message number 150');
  });
});

/** The ⟳ beside the name in the detail panel. */
describe('SessionTitler.retitleNow', () => {
  it('renames the session from the messages it is handed', async () => {
    const { titler, queryFn, applyTitle } = makeTitler({ reply: 'Space map counter-zoom' });

    const result = await titler.retitleNow('s1', [userMsg('rewrite the tag rule matcher')]);

    expect(queryFn.mock.calls[0][0].prompt).toContain('rewrite the tag rule matcher');
    expect(applyTitle).toHaveBeenCalledWith('s1', 'Space map counter-zoom');
    expect(result).toEqual({ title: 'Space map counter-zoom', changed: true });
  });

  it('hands the title back to the titler even when the model answers KEEP', async () => {
    const { titler, applyTitle } = makeTitler({ reply: 'KEEP' });

    const result = await titler.retitleNow('s1', MESSAGES);

    // `applyTitle` is what writes `auto`, so a `manual` name has to fall
    // whether or not the name itself moved.
    expect(applyTitle).toHaveBeenCalledWith('s1', 'Tag rules ordering');
    expect(result).toEqual({ title: 'Tag rules ordering', changed: false });
  });

  it('asks with the session prompt, not with the repo instructions', async () => {
    const { titler, queryFn } = makeTitler({});

    await titler.retitleNow('s1', MESSAGES);

    const { options } = queryFn.mock.calls[0][0];
    expect(options.settingSources).toEqual([]);
    expect(options.allowedTools).toEqual([]);
    expect(options.maxTurns).toBe(1);
  });

  // A persisted title query lands in `~/.claude/projects/` as an ordinary
  // transcript, and the watcher — which cannot tell it from a real session —
  // indexes it as a planet named after the prompt. See
  // `docs/decisions/ephemeral-title-queries.md`.
  it('asks without leaving a transcript behind', async () => {
    const { titler, queryFn } = makeTitler({});

    await titler.retitleNow('s1', MESSAGES);

    expect(queryFn.mock.calls[0][0].options.persistSession).toBe(false);
  });

  it('throws a failed query at its caller — someone is waiting on this one', async () => {
    const titler = new SessionTitler({
      queryFn: () => {
        throw new Error('spawn ENOENT');
      },
      readSession: () => ({ title: 'Tag rules ordering' }),
      applyTitle: vi.fn(),
    });

    await expect(titler.retitleNow('s1', MESSAGES)).rejects.toThrow('spawn ENOENT');
  });

  // The packaged app ships without the SDK's bundled binary (spec
  // 2026-09-16-electron-wrapper-design § 2), so a title query that omits the
  // option fails there with "Native CLI binary for darwin-arm64 not found"
  // while the rest of the app works. Mirrors the same case in runner.test.ts
  // and catalog.test.ts.
  it('hands the title query an explicit claude executable when it was given one, and omits the option otherwise', async () => {
    const capture = (claudeExecutablePath?: string) => {
      let captured: Record<string, unknown> | undefined;
      const queryFn = vi.fn(({ options }: { prompt: string; options: Record<string, unknown> }) => {
        captured = options;
        async function* gen() {
          yield { type: 'result', subtype: 'success' };
        }
        return gen();
      });
      const titler = new SessionTitler({
        queryFn: queryFn as never,
        readSession: () => ({ title: 'Tag rules ordering' }),
        applyTitle: vi.fn(),
        claudeExecutablePath,
      });
      return { titler, options: () => captured! };
    };

    const withPath = capture('/x/claude');
    await withPath.titler.retitleNow('s1', MESSAGES);
    expect(withPath.options().pathToClaudeCodeExecutable).toBe('/x/claude');

    const without = capture();
    await without.titler.retitleNow('s1', MESSAGES);
    expect(without.options()).not.toHaveProperty('pathToClaudeCodeExecutable');
  });
});
