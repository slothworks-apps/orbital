import { describe, it, expect, vi } from 'vitest';
import {
  MAX_PROMPT_CHARS,
  RETITLE_COOLDOWN_MS,
  SessionTitler,
  buildTitlePrompt,
  parseTitleReply,
  shouldRetitle,
} from '../src/titler/titler.js';
import type { ChatMessage } from '../src/types.js';

const userMsg = (text: string): ChatMessage => ({ id: text, role: 'user', text });

/** Enough user turns, on a subject far from the title, to clear every guard. */
const MOVED_ON = [
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

function makeTitler(opts: {
  reply?: string;
  title?: string;
  titleSource?: 'derived' | 'auto' | 'manual';
  enabled?: boolean;
  now?: () => number;
}) {
  const queryFn = fakeQueryFn(opts.reply ?? 'Space map counter-zoom');
  const applyTitle = vi.fn();
  const titler = new SessionTitler({
    queryFn: queryFn as never,
    readSession: () => ({
      title: opts.title ?? 'Tag rules ordering',
      titleSource: opts.titleSource ?? 'derived',
    }),
    applyTitle,
    isEnabled: () => opts.enabled ?? true,
    now: opts.now ?? (() => 1_000_000),
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

/**
 * The gate that decides whether a model is worth asking. It sees only
 * vocabulary — the message count, the cooldown and a manually typed title are
 * the titler's guards, not this function's.
 */
describe('shouldRetitle', () => {
  it('stays quiet while the session is still about its title', () => {
    expect(
      shouldRetitle(
        ['fix the tag rules ordering', 'the rules list drops the last rule'],
        'Tag rules ordering'
      )
    ).toBe(false);
  });

  it('fires once the session has moved on to something else', () => {
    expect(
      shouldRetitle(
        ['the space map zoom feels wrong', 'planets are too small when zoomed out'],
        'Tag rules ordering'
      )
    ).toBe(true);
  });

  it('fires when there is no title yet', () => {
    expect(shouldRetitle(['fix the tag rules ordering'], '')).toBe(true);
  });

  it('stays quiet when the new messages carry no subject at all', () => {
    expect(shouldRetitle(['ok', 'thanks', 'yes please'], 'Tag rules ordering')).toBe(false);
  });

  it('reads Czech as one vocabulary with the title, diacritics and all', () => {
    expect(
      shouldRetitle(
        ['přejmenování sessions podle obsahu', 'ať se to mění průběžně'],
        'Přejmenování sessions'
      )
    ).toBe(false);
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

describe('SessionTitler', () => {
  it('renames a session once its subject has moved away from its title', async () => {
    const { titler, applyTitle } = makeTitler({ reply: 'Space map counter-zoom' });
    titler.feed('s1', MOVED_ON);

    await titler.considerTurnEnd('s1');

    expect(applyTitle).toHaveBeenCalledWith('s1', 'Space map counter-zoom');
  });

  it('never asks the model while the session is still about its title', async () => {
    const { titler, queryFn, applyTitle } = makeTitler({ title: 'Space map zoom' });
    titler.feed('s1', MOVED_ON);

    await titler.considerTurnEnd('s1');

    expect(queryFn).not.toHaveBeenCalled();
    expect(applyTitle).not.toHaveBeenCalled();
  });

  it('leaves a title a human typed alone, however far the session moves', async () => {
    const { titler, queryFn, applyTitle } = makeTitler({ titleSource: 'manual' });
    titler.feed('s1', MOVED_ON);

    await titler.considerTurnEnd('s1');

    expect(queryFn).not.toHaveBeenCalled();
    expect(applyTitle).not.toHaveBeenCalled();
  });

  it('does nothing at all while the setting is off', async () => {
    const { titler, queryFn, applyTitle } = makeTitler({ enabled: false });
    titler.feed('s1', MOVED_ON);

    await titler.considerTurnEnd('s1');

    expect(queryFn).not.toHaveBeenCalled();
    expect(applyTitle).not.toHaveBeenCalled();
  });

  it('waits out the cooldown before renaming the same session again', async () => {
    let clock = 1_000_000;
    const { titler, applyTitle } = makeTitler({ now: () => clock });
    titler.feed('s1', MOVED_ON);
    await titler.considerTurnEnd('s1');
    expect(applyTitle).toHaveBeenCalledTimes(1);

    clock += RETITLE_COOLDOWN_MS - 1;
    titler.feed('s1', MOVED_ON);
    await titler.considerTurnEnd('s1');
    expect(applyTitle).toHaveBeenCalledTimes(1);

    clock += 2;
    titler.feed('s1', MOVED_ON);
    await titler.considerTurnEnd('s1');
    expect(applyTitle).toHaveBeenCalledTimes(2);
  });

  it('keeps the current title when the model answers KEEP', async () => {
    const { titler, queryFn, applyTitle } = makeTitler({ reply: 'KEEP' });
    titler.feed('s1', MOVED_ON);

    await titler.considerTurnEnd('s1');

    expect(queryFn).toHaveBeenCalled();
    expect(applyTitle).not.toHaveBeenCalled();
  });

  it('records a failed title query instead of throwing it at the turn', async () => {
    const onError = vi.fn();
    const titler = new SessionTitler({
      queryFn: () => {
        throw new Error('spawn ENOENT');
      },
      readSession: () => ({ title: 'Tag rules ordering', titleSource: 'derived' }),
      applyTitle: vi.fn(),
      isEnabled: () => true,
      onError,
    });
    titler.feed('s1', MOVED_ON);

    await expect(titler.considerTurnEnd('s1')).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith('s1', expect.any(Error));
  });

  it('forgets a session that has ended', async () => {
    const { titler, queryFn } = makeTitler({});
    titler.feed('s1', MOVED_ON);
    titler.forget('s1');

    await titler.considerTurnEnd('s1');

    expect(queryFn).not.toHaveBeenCalled();
  });

  it('asks with the session prompt, not with the repo instructions', async () => {
    const { titler, queryFn } = makeTitler({});
    titler.feed('s1', MOVED_ON);

    await titler.considerTurnEnd('s1');

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
    titler.feed('s1', MOVED_ON);

    await titler.considerTurnEnd('s1');

    expect(queryFn.mock.calls[0][0].options.persistSession).toBe(false);
  });
});

/**
 * The button next to the name in the detail panel. Everything
 * `considerTurnEnd` weighs is deliberately not weighed here: a click is a
 * decision, and the only thing left to decide is what the session should be
 * called (spec 2026-09-18-auto-title-design § Renaming on demand).
 */
describe('SessionTitler.retitleNow', () => {
  it('names a session with every automatic guard shut against it', async () => {
    const { titler, applyTitle } = makeTitler({
      titleSource: 'manual',
      enabled: false,
      reply: 'Space map counter-zoom',
    });

    const result = await titler.retitleNow('s1', MOVED_ON);

    expect(applyTitle).toHaveBeenCalledWith('s1', 'Space map counter-zoom');
    expect(result).toEqual({ title: 'Space map counter-zoom', changed: true });
  });

  it('describes the session from the messages it is handed, not from the buffer', async () => {
    const { titler, queryFn } = makeTitler({});

    await titler.retitleNow('never-fed', [userMsg('rewrite the tag rule matcher')]);

    expect(queryFn.mock.calls[0][0].prompt).toContain('rewrite the tag rule matcher');
  });

  it('hands the title back to the titler even when the model answers KEEP', async () => {
    const { titler, applyTitle } = makeTitler({ reply: 'KEEP', titleSource: 'manual' });

    const result = await titler.retitleNow('s1', MOVED_ON);

    // The click is consent to being renamed again later, so `manual` has to
    // fall whether or not the name itself moved: `applyTitle` is what writes
    // `auto`, and it is called with the name the session already has.
    expect(applyTitle).toHaveBeenCalledWith('s1', 'Tag rules ordering');
    expect(result).toEqual({ title: 'Tag rules ordering', changed: false });
  });

  it('starts the cooldown, so the next turn does not ask all over again', async () => {
    const { titler, queryFn } = makeTitler({});
    titler.feed('s1', MOVED_ON);

    await titler.retitleNow('s1', MOVED_ON);
    expect(queryFn).toHaveBeenCalledTimes(1);

    titler.feed('s1', MOVED_ON);
    await titler.considerTurnEnd('s1');
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('throws a failed query at its caller — someone is waiting on this one', async () => {
    const onError = vi.fn();
    const titler = new SessionTitler({
      queryFn: () => {
        throw new Error('spawn ENOENT');
      },
      readSession: () => ({ title: 'Tag rules ordering', titleSource: 'derived' }),
      applyTitle: vi.fn(),
      isEnabled: () => true,
      onError,
    });

    await expect(titler.retitleNow('s1', MOVED_ON)).rejects.toThrow('spawn ENOENT');
    expect(onError).not.toHaveBeenCalled();
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
        readSession: () => ({ title: 'Tag rules ordering', titleSource: 'derived' }),
        applyTitle: vi.fn(),
        isEnabled: () => true,
        claudeExecutablePath,
      });
      return { titler, options: () => captured! };
    };

    const withPath = capture('/x/claude');
    await withPath.titler.retitleNow('s1', MOVED_ON);
    expect(withPath.options().pathToClaudeCodeExecutable).toBe('/x/claude');

    const without = capture();
    await without.titler.retitleNow('s1', MOVED_ON);
    expect(without.options()).not.toHaveProperty('pathToClaudeCodeExecutable');
  });
});
