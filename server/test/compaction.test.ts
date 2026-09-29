import { describe, it, expect, vi } from 'vitest';
import { Hub } from '../src/api/hub.js';
import { Runner, compactTriggerOf, type CompactionEvent } from '../src/runner/runner.js';
import { entriesToMessages, parseTranscript } from '../src/transcript/parser.js';
import { mergeCompactionFailures, type CompactionFailureRecord } from '../src/transcript/compaction.js';
import type { ChatMessage } from '../src/types.js';

/**
 * Context compaction (spec 2026-09-28-context-compaction-design): the live
 * state the runner derives from `system/status`, the mark it builds from
 * `compact_boundary`, and the same mark read back from a transcript file.
 */

/** A transcript file holding one compaction, in the CLI's real field names. */
function transcriptWith(meta: Record<string, unknown>, summary = 'This session is being continued. Summary: X.') {
  return [
    { type: 'user', uuid: 'u1', timestamp: '2026-09-28T10:00:00.000Z', message: { role: 'user', content: 'hi' } },
    {
      type: 'system', subtype: 'compact_boundary', uuid: 'b1', isSidechain: false,
      timestamp: '2026-09-28T10:05:14.351Z', content: 'Conversation compacted', level: 'info',
      compactMetadata: meta,
    },
    // The real summary entry is stamped a few ms BEFORE its boundary, and
    // written after it; order in the file is what counts.
    {
      type: 'user', uuid: 's1', isCompactSummary: true, isVisibleInTranscriptOnly: true,
      timestamp: '2026-09-28T10:05:14.032Z', message: { role: 'user', content: summary },
    },
    {
      type: 'assistant', uuid: 'a1', timestamp: '2026-09-28T10:05:20.000Z',
      message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'Continuing.' }] },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
}

describe('the compaction mark from a transcript', () => {
  it('is one item carrying the summary, and the summary is no user bubble', () => {
    const messages = entriesToMessages(
      parseTranscript(transcriptWith({ trigger: 'manual', preTokens: 186_000, postTokens: 22_000, durationMs: 38_000 })),
    );
    expect(messages.map((m) => m.role)).toEqual(['user', 'compaction', 'assistant']);
    expect(messages[1]).toEqual({
      id: 'b1:0', role: 'compaction', timestamp: '2026-09-28T10:05:14.351Z', uuid: 'b1',
      compaction: {
        outcome: 'success', trigger: 'manual', preTokens: 186_000, postTokens: 22_000, durationMs: 38_000,
        summary: 'This session is being continued. Summary: X.',
      },
    });
  });

  it('reports what is missing as null rather than estimating it', () => {
    const [, mark] = entriesToMessages(parseTranscript(transcriptWith({ trigger: 'auto', preTokens: 967_508 })));
    expect(mark.compaction).toMatchObject({ trigger: 'auto', preTokens: 967_508, postTokens: null, durationMs: null });
  });

  it("leaves a subagent's own compaction out", () => {
    const text = JSON.stringify({
      type: 'system', subtype: 'compact_boundary', uuid: 'b9', isSidechain: true,
      compactMetadata: { trigger: 'auto', preTokens: 1 },
    });
    expect(entriesToMessages(parseTranscript(text))).toEqual([]);
  });
});

describe('mergeCompactionFailures', () => {
  const failure = (id: string, at: string): CompactionFailureRecord => ({
    id, at: Date.parse(at), error: 'boom', preTokens: 164_000, trigger: 'manual', durationMs: 12_000,
  });
  const row = (id: string, timestamp?: string): ChatMessage => ({ id, role: 'assistant', text: id, timestamp });

  it('places each failure at its timestamp, and the newest at the end', () => {
    const merged = mergeCompactionFailures(
      [row('a', '2026-09-28T10:00:00Z'), row('b'), row('c', '2026-09-28T10:10:00Z')],
      [failure('late', '2026-09-28T11:00:00Z'), failure('mid', '2026-09-28T10:05:00Z')],
    );
    expect(merged.map((m) => m.id)).toEqual(['a', 'b', 'mid', 'c', 'late']);
    expect(merged[2]).toMatchObject({
      role: 'compaction', timestamp: '2026-09-28T10:05:00.000Z',
      compaction: { outcome: 'failed', trigger: 'manual', preTokens: 164_000, postTokens: null, durationMs: 12_000, error: 'boom' },
    });
  });

  it('keeps a message stamped at the same instant ahead of the failure it produced', () => {
    const merged = mergeCompactionFailures([row('a', '2026-09-28T10:00:00Z')], [failure('f', '2026-09-28T10:00:00Z')]);
    expect(merged.map((m) => m.id)).toEqual(['a', 'f']);
  });
});

describe('compactTriggerOf', () => {
  it('is manual only for a turn started by /compact, with or without arguments', () => {
    expect(compactTriggerOf('/compact')).toBe('manual');
    expect(compactTriggerOf('  /compact keep the plan  ')).toBe('manual');
    expect(compactTriggerOf('/compactor')).toBe('auto');
    expect(compactTriggerOf('please /compact')).toBe('auto');
    expect(compactTriggerOf(null)).toBe('auto');
  });
});

/** A fake SDK whose stream the test writes message by message. */
function scripted() {
  const queue: any[] = [];
  let wake: (() => void) | null = null;
  const prompts: string[] = [];
  const fn = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
    const sid = options.sessionId;
    // Drains the input so the Runner's sends are observable.
    void (async () => {
      for await (const m of prompt) prompts.push(m.message.content.at(-1)?.text ?? '');
    })();
    async function* gen() {
      for (;;) {
        while (queue.length) yield { session_id: sid, ...queue.shift() };
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    }
    return gen() as any;
  };
  return {
    fn,
    push(...msgs: Record<string, unknown>[]) {
      queue.push(...msgs);
      const w = wake;
      wake = null;
      w?.();
    },
  };
}

const compactingStatus = { type: 'system', subtype: 'status', status: 'compacting' };
const statusEnd = (result: 'success' | 'failed', error?: string) => ({
  type: 'system', subtype: 'status', status: null, compact_result: result,
  ...(error === undefined ? {} : { compact_error: error }),
});

async function running(prompt = 'go', contextUsed: number | null = 150_000) {
  const sdk = scripted();
  const hub = new Hub();
  const published: any[] = [];
  const origPublish = hub.publish.bind(hub);
  hub.publish = (topic: string, payload: any) => {
    if (topic === 'session:web-1' && payload.event === 'message') published.push(payload.message);
    return origPublish(topic, payload);
  };
  const events: CompactionEvent[] = [];
  const runner = new Runner({
    hub, queryFn: sdk.fn, newSessionId: () => 'web-1',
    onCompaction: (_id, event) => events.push(event),
    readContextUsed: () => contextUsed,
  });
  await runner.start({ cwd: '/w', prompt, permissionMode: 'acceptEdits' });
  return { runner, sdk, events, published };
}

describe('Runner compaction status', () => {
  it('starts on compacting and ends on a success status; requesting and a bare null are ignored', async () => {
    const { runner, sdk, events } = await running('/compact');
    sdk.push(compactingStatus);
    await vi.waitFor(() => expect(runner.compacting('web-1')).toMatchObject({ trigger: 'manual' }));
    sdk.push(
      { type: 'system', subtype: 'status', status: 'requesting' },
      { type: 'system', subtype: 'status', status: null },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(runner.compacting('web-1')).not.toBeNull();
    sdk.push(statusEnd('success'));
    await vi.waitFor(() => expect(runner.compacting('web-1')).toBeNull());
    expect(events.map((e) => e.type)).toEqual(['started', 'succeeded']);
  });

  it('is cleared by the turn ending, and never outlives the session', async () => {
    const { runner, sdk } = await running();
    sdk.push(compactingStatus);
    await vi.waitFor(() => expect(runner.compacting('web-1')).not.toBeNull());
    sdk.push({ type: 'result', subtype: 'success', usage: {} });
    await vi.waitFor(() => expect(runner.compacting('web-1')).toBeNull());

    sdk.push(compactingStatus);
    await vi.waitFor(() => expect(runner.compacting('web-1')).not.toBeNull());
    await runner.stop('web-1');
    expect(runner.compacting('web-1')).toBeNull();
  });

  it('publishes a failure mark and reports it, attributed to the /compact that started the turn', async () => {
    const { runner, sdk, events, published } = await running('/compact focus on the tests', 164_000);
    sdk.push(compactingStatus);
    await vi.waitFor(() => expect(runner.compacting('web-1')).not.toBeNull());
    sdk.push(statusEnd('failed', 'API Error 529 · Overloaded'));
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('failed'));
    const failure = (events.at(-1) as Extract<CompactionEvent, { type: 'failed' }>).failure;
    expect(failure).toMatchObject({ trigger: 'manual', preTokens: 164_000, error: 'API Error 529 · Overloaded' });
    expect(failure.durationMs).toBeGreaterThanOrEqual(0);
    const mark = published.find((m) => m.role === 'compaction');
    expect(mark).toMatchObject({
      id: failure.id,
      compaction: { outcome: 'failed', trigger: 'manual', preTokens: 164_000, error: 'API Error 529 · Overloaded' },
    });
    expect(runner.compacting('web-1')).toBeNull();
  });

  it('calls a failure in a turn not started by /compact auto, and an empty reason no reason', async () => {
    const { sdk, events } = await running('fix the tests');
    sdk.push(compactingStatus, statusEnd('failed', '  '));
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('failed'));
    expect((events.at(-1) as any).failure).toMatchObject({ trigger: 'auto', error: null });
  });

  it('builds the same mark live as the transcript file gives on reload', async () => {
    const { sdk, published } = await running('/compact');
    sdk.push(
      compactingStatus,
      statusEnd('success'),
      {
        type: 'system', subtype: 'compact_boundary', uuid: 'b1',
        compact_metadata: { trigger: 'manual', pre_tokens: 186_000, post_tokens: 22_000, duration_ms: 38_000 },
      },
      {
        type: 'user', parent_tool_use_id: null, isSynthetic: true,
        message: { role: 'user', content: 'This session is being continued. Summary: X.' },
      },
    );
    await vi.waitFor(() => expect(published.some((m) => m.role === 'compaction')).toBe(true));
    const live = published.find((m) => m.role === 'compaction');
    const [, reloaded] = entriesToMessages(
      parseTranscript(transcriptWith({ trigger: 'manual', preTokens: 186_000, postTokens: 22_000, durationMs: 38_000 })),
    );
    expect(live.compaction).toEqual(reloaded.compaction);
    expect(Object.keys(live).sort()).toEqual(Object.keys(reloaded).sort());
    // The summary frame is consumed by the mark, never shown as a user row.
    expect(published.filter((m) => m.role === 'user')).toEqual([]);
  });

  it('takes the measured duration when the boundary has none, and publishes without a summary when none follows', async () => {
    const { sdk, published } = await running('/compact');
    sdk.push(compactingStatus);
    await new Promise((r) => setTimeout(r, 30));
    sdk.push(
      statusEnd('success'),
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 186_000 } },
      { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'next' }] } },
    );
    await vi.waitFor(() => expect(published.some((m) => m.role === 'compaction')).toBe(true));
    const mark = published.find((m) => m.role === 'compaction');
    expect(mark.compaction.postTokens).toBeNull();
    expect(mark.compaction.durationMs).toBeGreaterThanOrEqual(25);
    expect(mark.compaction.summary).toBeUndefined();
    // Ahead of the frame that pushed it out.
    expect(published.map((m) => m.role)).toEqual(['compaction', 'assistant']);
  });
});
