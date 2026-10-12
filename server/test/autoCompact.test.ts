import { describe, expect, it, vi } from 'vitest';
import { Hub } from '../src/api/hub.js';
import { Runner, compactTriggerOf } from '../src/runner/runner.js';
import {
  autoCompactPrompt,
  parseAutoCompactSettings,
  shouldAutoCompact,
  type AutoCompactCandidate,
} from '../src/runner/autoCompact.js';
import { entriesToMessages } from '../src/transcript/parser.js';

/** Auto-compact between turns (spec 2026-10-10-auto-compact-between-turns-design). */

const on = { thresholdTokens: 200_000, quietMs: 0 };
const due: AutoCompactCandidate = {
  status: 'needs_input', hasDecision: false, compacting: false, blocked: false, contextUsedTokens: 200_000,
};

describe('shouldAutoCompact', () => {
  it('compacts a quiet session at or above the threshold', () => {
    expect(shouldAutoCompact(due, on)).toBe(true);
  });

  it('is held back by every condition on its own', () => {
    expect(shouldAutoCompact(due, null)).toBe(false);
    expect(shouldAutoCompact({ ...due, status: 'working' }, on)).toBe(false);
    expect(shouldAutoCompact({ ...due, status: 'idle' }, on)).toBe(false);
    expect(shouldAutoCompact({ ...due, hasDecision: true }, on)).toBe(false);
    expect(shouldAutoCompact({ ...due, compacting: true }, on)).toBe(false);
    expect(shouldAutoCompact({ ...due, blocked: true }, on)).toBe(false);
    expect(shouldAutoCompact({ ...due, contextUsedTokens: null }, on)).toBe(false);
    expect(shouldAutoCompact({ ...due, contextUsedTokens: 199_999 }, on)).toBe(false);
  });
});

describe('parseAutoCompactSettings', () => {
  const from = (values: Record<string, string>) => (key: string) => values[key] ?? '';

  it('is null while the switch is off', () => {
    expect(parseAutoCompactSettings(from({}))).toBeNull();
    expect(parseAutoCompactSettings(from({ auto_compact_enabled: 'false' }))).toBeNull();
  });

  it('falls back to the defaults on missing or garbage values', () => {
    const expected = { thresholdTokens: 200_000, quietMs: 120_000 };
    expect(parseAutoCompactSettings(from({ auto_compact_enabled: 'true' }))).toEqual(expected);
    expect(
      parseAutoCompactSettings(
        from({ auto_compact_enabled: 'true', auto_compact_threshold_tokens: 'lots', auto_compact_quiet_seconds: ' ' }),
      ),
    ).toEqual(expected);
  });

  it('clamps the threshold and keeps the quiet delay under the sleep timer', () => {
    expect(
      parseAutoCompactSettings(
        from({ auto_compact_enabled: 'true', auto_compact_threshold_tokens: '1000', auto_compact_quiet_seconds: '-5' }),
      ),
    ).toEqual({ thresholdTokens: 50_000, quietMs: 0 });
    expect(
      parseAutoCompactSettings(
        from({ auto_compact_enabled: 'true', auto_compact_threshold_tokens: '5000000', auto_compact_quiet_seconds: '7200' }),
      ),
    ).toEqual({ thresholdTokens: 900_000, quietMs: 1_500_000 });
  });
});

describe('compactTriggerOf for Orbital\'s own /compact', () => {
  it('is orbital for the tagged prompt and manual for any other /compact', () => {
    expect(compactTriggerOf(autoCompactPrompt(200_000))).toBe('orbital');
    expect(compactTriggerOf('/compact')).toBe('manual');
    expect(compactTriggerOf('/compact keep the plan')).toBe('manual');
    expect(compactTriggerOf('look at <orbital-auto-compact>')).toBe('auto');
  });
});

/** A fake SDK that answers every prompt with one finished turn and records the prompts. */
function answering() {
  const prompts: string[] = [];
  const fn = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
    async function* gen() {
      for await (const m of prompt) {
        if (m === null) return;
        prompts.push(m.message.content.at(-1)?.text ?? '');
        yield { session_id: options.sessionId, type: 'result', subtype: 'success', usage: {} };
      }
    }
    return gen() as any;
  };
  return { fn, prompts };
}

async function runner(contextUsed: number, quietMs = 10) {
  const sdk = answering();
  const r = new Runner({
    hub: new Hub(),
    queryFn: sdk.fn,
    newSessionId: () => 'web-1',
    readContextUsed: () => contextUsed,
    autoCompact: () => ({ thresholdTokens: 200_000, quietMs }),
  });
  await r.start({ cwd: '/w', prompt: 'go', permissionMode: 'acceptEdits' });
  return { runner: r, prompts: sdk.prompts };
}

const settle = () => new Promise((r) => setTimeout(r, 60));

describe('Runner auto-compact', () => {
  it('sends the tagged /compact once after the quiet delay, and again only after a user turn', async () => {
    const { runner: r, prompts } = await runner(250_000);
    await vi.waitFor(() => expect(prompts.filter((p) => p.startsWith('/compact'))).toHaveLength(1));
    expect(compactTriggerOf(prompts[1])).toBe('orbital');
    // The summary is still above the threshold: no loop.
    await settle();
    expect(prompts).toHaveLength(2);

    r.send('web-1', 'next');
    await vi.waitFor(() => expect(prompts.filter((p) => p.startsWith('/compact'))).toHaveLength(2));
    await r.stop('web-1');
  });

  it('leaves a session below the threshold alone', async () => {
    const { runner: r, prompts } = await runner(150_000);
    await settle();
    expect(prompts).toEqual(['go']);
    await r.stop('web-1');
  });

  it('is cancelled by a send inside the quiet delay', async () => {
    const { runner: r, prompts } = await runner(250_000, 1_000);
    await vi.waitFor(() => expect(r.status('web-1')).toBe('needs_input'));
    r.send('web-1', 'quick reply');
    await vi.waitFor(() => expect(prompts).toEqual(['go', 'quick reply']));
    await r.stop('web-1');
    await new Promise((res) => setTimeout(res, 1_100));
    expect(prompts).toEqual(['go', 'quick reply']);
  });
});

describe('a message sent while Orbital compacts', () => {
  it('does not rename the turn, so the compaction stays Orbital\'s', async () => {
    const queue: any[] = [];
    let wake: (() => void) | null = null;
    const push = (...msgs: any[]) => { queue.push(...msgs); const w = wake; wake = null; w?.(); };
    const prompts: string[] = [];
    const fn = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
      void (async () => { for await (const m of prompt) if (m) prompts.push(m.message.content.at(-1)?.text ?? ''); })();
      async function* gen() {
        for (;;) {
          while (queue.length) yield { session_id: options.sessionId, ...queue.shift() };
          await new Promise<void>((resolve) => { wake = resolve; });
        }
      }
      return gen() as any;
    };
    const r = new Runner({
      hub: new Hub(), queryFn: fn as any, newSessionId: () => 'web-1',
      readContextUsed: () => 250_000,
      autoCompact: () => ({ thresholdTokens: 200_000, quietMs: 0 }),
    });
    await r.start({ cwd: '/w', prompt: 'go', permissionMode: 'acceptEdits' });
    push({ type: 'result', subtype: 'success', usage: {} });
    await vi.waitFor(() => expect(prompts.some((p) => p.startsWith('/compact'))).toBe(true));
    push({ type: 'system', subtype: 'status', status: 'compacting' });
    await vi.waitFor(() => expect(r.compacting('web-1')).toMatchObject({ trigger: 'orbital' }));
    r.send('web-1', 'meanwhile');
    push({ type: 'system', subtype: 'status', status: null, compact_result: 'failed' });
    await vi.waitFor(() => expect(r.compacting('web-1')).toBeNull());
    expect(compactTriggerOf((r as any).sessions.get('web-1').turnPrompt)).toBe('orbital');
    await r.stop('web-1');
  });
});

describe('an Orbital compaction read back from the transcript', () => {
  const boundary = {
    type: 'system', subtype: 'compact_boundary', uuid: 'b1', isSidechain: false,
    timestamp: '2026-10-10T10:05:00.000Z', compactMetadata: { trigger: 'manual', preTokens: 250_000, postTokens: 30_000 },
  };
  const prompt = (content: string) => ({
    type: 'user', uuid: 'u1', timestamp: '2026-10-10T10:00:00.000Z', message: { role: 'user', content },
  });
  const triggerOf = (entries: any[]) => entriesToMessages(entries).find((m) => m.role === 'compaction')?.compaction?.trigger;

  it('reads orbital when the /compact before the boundary carries the tag', () => {
    const tagged = `<command-name>/compact</command-name><command-args>${autoCompactPrompt(200_000).slice('/compact '.length)}</command-args>`;
    expect(triggerOf([prompt(tagged), boundary])).toBe('orbital');
    expect(triggerOf([prompt(autoCompactPrompt(200_000)), boundary])).toBe('orbital');
  });

  it('stays manual for the user\'s own /compact', () => {
    expect(triggerOf([prompt('<command-name>/compact</command-name><command-args></command-args>'), boundary])).toBe('manual');
  });

  it('folds the tag away from the human text', () => {
    const message = entriesToMessages([prompt(autoCompactPrompt(200_000))]).find((m) => m.role === 'user');
    expect(message?.text).toBe('/compact');
  });
});
