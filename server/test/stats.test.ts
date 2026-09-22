import { describe, it, expect } from 'vitest';
import { computeStats, toolKind } from '../src/stats/compute.js';
import {
  CACHE_BURN_MIN_TURNS,
  CHARS_PER_TOKEN,
  ERROR_LOOP_MIN_REPEATS,
  HIST_BUCKET_BOUNDS_MS,
  HIST_BUCKET_COUNT,
  OBESE_RESULT_TOKENS,
} from '../src/stats/constants.js';
import type { TranscriptEntry } from '../src/transcript/parser.js';

const T0 = Date.parse('2026-09-20T10:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

interface UsageParts {
  input?: number;
  output?: number;
  cacheRead?: number;
  create5m?: number;
  create1h?: number;
  thinking?: number;
}

function usage(p: UsageParts) {
  return {
    input_tokens: p.input ?? 0,
    output_tokens: p.output ?? 0,
    cache_read_input_tokens: p.cacheRead ?? 0,
    cache_creation_input_tokens: (p.create5m ?? 0) + (p.create1h ?? 0),
    cache_creation: {
      ephemeral_5m_input_tokens: p.create5m ?? 0,
      ephemeral_1h_input_tokens: p.create1h ?? 0,
    },
    output_tokens_details: { thinking_tokens: p.thinking ?? 0 },
  };
}

function human(atMs: number, uuid = `h-${atMs}`): TranscriptEntry {
  return { type: 'user', uuid, timestamp: at(atMs), message: { role: 'user', content: 'do it' } };
}

function assistant(opts: {
  at?: number;
  uuid?: string;
  requestId?: string;
  content?: Array<Record<string, unknown>>;
  usage?: UsageParts;
  sidechain?: boolean;
  model?: string;
}): TranscriptEntry {
  return {
    type: 'assistant',
    ...(opts.uuid ? { uuid: opts.uuid } : {}),
    ...(opts.at === undefined ? {} : { timestamp: at(opts.at) }),
    ...(opts.requestId ? { requestId: opts.requestId } : {}),
    ...(opts.sidechain ? { isSidechain: true } : {}),
    message: {
      role: 'assistant',
      content: opts.content ?? [{ type: 'text', text: 'ok' }],
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.usage ? { usage: usage(opts.usage) } : {}),
    },
  };
}

const toolUse = (id: string, name: string, input: unknown = {}) => ({
  type: 'tool_use',
  id,
  name,
  input,
});

function toolResult(opts: {
  at?: number;
  useId: string;
  result?: unknown;
  isError?: boolean;
  uuid?: string;
  sidechain?: boolean;
}): TranscriptEntry {
  return {
    type: 'user',
    ...(opts.uuid ? { uuid: opts.uuid } : {}),
    ...(opts.at === undefined ? {} : { timestamp: at(opts.at) }),
    ...(opts.sidechain ? { isSidechain: true } : {}),
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: opts.useId,
          ...(opts.isError ? { is_error: true } : {}),
        },
      ],
    },
    toolUseResult: opts.result ?? 'ok',
  };
}

/** One local tool call of the given duration, as its own turn. */
function toolCallPair(startMs: number, durationMs: number, i: number, name = 'Read') {
  return [
    assistant({ at: startMs, requestId: `req-${i}`, content: [toolUse(`use-${i}`, name)] }),
    toolResult({ at: startMs + durationMs, useId: `use-${i}` }),
  ];
}

describe('computeStats — empty and degenerate input', () => {
  it('returns a zeroed rollup for no entries', () => {
    const { rollup, turns } = computeStats([]);
    expect(turns).toEqual([]);
    expect(rollup.turns).toBe(0);
    expect(rollup.apiMs + rollup.localToolMs + rollup.mcpMs + rollup.subagentMs).toBe(0);
    expect(rollup.inputTokens + rollup.outputTokens + rollup.subagentTokens).toBe(0);
    expect(rollup.toolCalls).toBe(0);
    expect(rollup.toolBreakdown).toEqual({});
    expect(rollup.findings).toEqual([]);
  });

  it('does not throw on malformed entries', () => {
    const junk: TranscriptEntry[] = [
      { type: 'summary' },
      { type: 'assistant' },
      { type: 'assistant', message: { role: 'assistant', content: 'plain string' } },
      { type: 'assistant', timestamp: 'not-a-date', message: { role: 'assistant', content: [] } },
      { type: 'user', message: { role: 'user', content: [null as never, 7 as never] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result' }] } },
      { type: 'assistant', requestId: 'r', message: { role: 'assistant', content: [toolUse('x', 'Read')] } },
      { type: 'user', toolUseResult: { self: undefined }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x' }] } },
      { type: 'assistant', requestId: 'r2', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'y', name: 42 }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'y' }] } },
    ];
    expect(() => computeStats(junk)).not.toThrow();
    const { rollup } = computeStats(junk);
    expect(rollup.turns).toBeGreaterThan(0);
    // A block with no usable name must not open a nameless breakdown row.
    expect(Object.keys(rollup.toolBreakdown)).not.toContain('');
  });

  it('serializes a circular toolUseResult without throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const entries: TranscriptEntry[] = [
      assistant({ at: 0, requestId: 'r1', content: [toolUse('u1', 'Read')] }),
      { ...toolResult({ at: 10, useId: 'u1' }), toolUseResult: circular },
    ];
    expect(() => computeStats(entries)).not.toThrow();
    expect(computeStats(entries).rollup.toolBreakdown.Read.resultChars).toBe(0);
  });
});

describe('computeStats — turns and usage dedupe', () => {
  it('counts one turn and one usage for entries sharing a requestId', () => {
    const entries: TranscriptEntry[] = [
      human(0),
      assistant({ at: 1000, requestId: 'req-a', uuid: 'a1', usage: { input: 10, output: 5, cacheRead: 100, create5m: 20, create1h: 30, thinking: 3 } }),
      assistant({ at: 1010, requestId: 'req-a', uuid: 'a2', usage: { input: 10, output: 5, cacheRead: 100, create5m: 20, create1h: 30, thinking: 3 } }),
      assistant({ at: 1020, requestId: 'req-a', uuid: 'a3', usage: { input: 10, output: 5, cacheRead: 100, create5m: 20, create1h: 30, thinking: 3 } }),
    ];
    const { rollup, turns } = computeStats(entries);
    expect(rollup.turns).toBe(1);
    expect(turns).toHaveLength(1);
    expect(turns[0].requestId).toBe('req-a');
    expect(turns[0].startTs).toBe(T0 + 1000);
    expect(rollup.inputTokens).toBe(10);
    expect(rollup.outputTokens).toBe(5);
    expect(rollup.cacheReadTokens).toBe(100);
    expect(rollup.cacheCreationTokens).toBe(50);
    expect(rollup.cacheCreation5mTokens).toBe(20);
    expect(rollup.cacheCreation1hTokens).toBe(30);
    expect(rollup.thinkingTokens).toBe(3);
    expect(turns[0].tokens).toEqual({ input: 10, output: 5, cacheRead: 100, cacheCreation: 50 });
  });

  it('treats each assistant entry as its own turn in transcripts without requestId', () => {
    const entries: TranscriptEntry[] = [
      human(0),
      assistant({ at: 1000, usage: { input: 10 } }),
      assistant({ at: 1005, usage: { input: 10 } }),
      assistant({ at: 1010, usage: { input: 10 } }),
    ];
    const { rollup, turns } = computeStats(entries);
    expect(rollup.turns).toBe(3);
    expect(turns.map((t) => t.requestId)).toEqual(['turn-1', 'turn-2', 'turn-3']);
    expect(rollup.inputTokens).toBe(30);
    // Each turn measures from the one before it, not from the human prompt
    // all three share: 1000 + 5 + 5, not 1000 + 1005 + 1010.
    expect(turns.map((t) => t.apiMs)).toEqual([1000, 5, 5]);
    expect(rollup.apiMs).toBe(1010);
  });
});

describe('computeStats — gap classification', () => {
  it('counts the gap from a human prompt to the turn as API wait', () => {
    const { rollup, turns } = computeStats([human(0), assistant({ at: 1500, requestId: 'r1' })]);
    expect(rollup.apiMs).toBe(1500);
    expect(turns[0].apiMs).toBe(1500);
  });

  it('counts the gap from a tool_result to the next turn as API wait', () => {
    const entries: TranscriptEntry[] = [
      human(0),
      assistant({ at: 100, requestId: 'r1', content: [toolUse('u1', 'Read')] }),
      toolResult({ at: 600, useId: 'u1' }),
      assistant({ at: 900, requestId: 'r2' }),
    ];
    const { rollup } = computeStats(entries);
    expect(rollup.apiMs).toBe(100 + 300);
    expect(rollup.localToolMs).toBe(500);
  });

  it('discards the think-time gap between a finished turn and the next human prompt', () => {
    const entries: TranscriptEntry[] = [
      human(0),
      assistant({ at: 100, requestId: 'r1' }),
      human(60_000, 'h2'),
      assistant({ at: 60_200, requestId: 'r2' }),
    ];
    const { rollup } = computeStats(entries);
    expect(rollup.apiMs).toBe(100 + 200);
  });

  it('clamps a backwards gap to zero', () => {
    const entries: TranscriptEntry[] = [human(5000), assistant({ at: 1000, requestId: 'r1' })];
    expect(computeStats(entries).rollup.apiMs).toBe(0);
  });

  it('skips the gap but keeps the tokens when a timestamp is missing', () => {
    const entries: TranscriptEntry[] = [
      human(0),
      assistant({ requestId: 'r1', usage: { input: 42 } }),
    ];
    const { rollup, turns } = computeStats(entries);
    expect(rollup.apiMs).toBe(0);
    expect(turns[0].startTs).toBe(0);
    expect(rollup.inputTokens).toBe(42);
  });

  it('scores no API wait for a turn with nothing before it', () => {
    expect(computeStats([assistant({ at: 9000, requestId: 'r1' })]).rollup.apiMs).toBe(0);
  });

  it('measures back-to-back turns from each other, not from a shared anchor', () => {
    const entries: TranscriptEntry[] = [
      human(0),
      assistant({ at: 1000, requestId: 'r1' }),
      assistant({ at: 1400, requestId: 'r2' }),
    ];
    const { rollup, turns } = computeStats(entries);
    expect(turns.map((t) => t.apiMs)).toEqual([1000, 400]);
    expect(rollup.apiMs).toBe(1400);
  });

  it('keeps busy time inside the wall clock on a sequential session', () => {
    const entries: TranscriptEntry[] = [
      human(0),
      assistant({ at: 500, requestId: 'r1', content: [toolUse('u1', 'Read')] }),
      toolResult({ at: 900, useId: 'u1' }),
      assistant({ at: 1200, requestId: 'r2', content: [toolUse('u2', 'mcp__s__t')] }),
      toolResult({ at: 2000, useId: 'u2' }),
      assistant({ at: 2400, requestId: 'r3' }),
      assistant({ at: 2600, requestId: 'r4' }),
    ];
    const { rollup } = computeStats(entries);
    const busy = rollup.apiMs + rollup.localToolMs + rollup.mcpMs + rollup.subagentMs;
    expect(busy).toBe(2600);
  });
});

describe('computeStats — tool runs', () => {
  it('ignores a tool_use that never got a result', () => {
    const entries: TranscriptEntry[] = [
      human(0),
      assistant({ at: 100, requestId: 'r1', content: [toolUse('u1', 'Bash')] }),
    ];
    const { rollup, turns } = computeStats(entries);
    expect(rollup.toolCalls).toBe(0);
    expect(rollup.localToolMs).toBe(0);
    expect(rollup.toolBreakdown).toEqual({});
    expect(turns[0].tools).toEqual([]);
  });

  it('splits local, MCP and subagent tools into their own lanes', () => {
    const entries: TranscriptEntry[] = [
      human(0),
      assistant({ at: 0, requestId: 'r1', content: [toolUse('u1', 'Read')] }),
      toolResult({ at: 100, useId: 'u1' }),
      assistant({ at: 100, requestId: 'r2', content: [toolUse('u2', 'mcp__atlas__docs_read')] }),
      toolResult({ at: 400, useId: 'u2' }),
      assistant({ at: 400, requestId: 'r3', content: [toolUse('u3', 'Agent')] }),
      toolResult({ at: 1400, useId: 'u3' }),
    ];
    const { rollup, turns } = computeStats(entries);
    expect(rollup.localToolMs).toBe(100);
    expect(rollup.mcpMs).toBe(300);
    expect(rollup.subagentMs).toBe(1000);
    expect(rollup.toolCalls).toBe(3);
    expect(turns.flatMap((t) => t.tools).map((t) => t.kind)).toEqual(['local', 'mcp', 'subagent']);
    expect(turns[0].tools[0]).toMatchObject({ name: 'Read', useId: 'u1', ms: 100, isError: false });
  });

  it('classifies both names the CLI has used for the subagent tool', () => {
    expect(toolKind('Agent')).toBe('subagent');
    expect(toolKind('Task')).toBe('subagent');
    expect(toolKind('mcp__server__thing')).toBe('mcp');
    expect(toolKind('Bash')).toBe('local');
  });

  it('accumulates calls, errors, ms and result size per tool', () => {
    const entries: TranscriptEntry[] = [
      human(0),
      assistant({ at: 0, requestId: 'r1', content: [toolUse('u1', 'Bash', { cmd: 'a' })] }),
      toolResult({ at: 200, useId: 'u1', result: 'x'.repeat(12) }),
      assistant({ at: 200, requestId: 'r2', content: [toolUse('u2', 'Bash', { cmd: 'b' })] }),
      toolResult({ at: 500, useId: 'u2', result: { out: 'y' }, isError: true }),
    ];
    const { rollup } = computeStats(entries);
    const bash = rollup.toolBreakdown.Bash;
    expect(bash.calls).toBe(2);
    expect(bash.errors).toBe(1);
    expect(bash.ms).toBe(500);
    expect(bash.resultChars).toBe(12 + JSON.stringify({ out: 'y' }).length);
    expect(rollup.toolErrors).toBe(1);
  });

  it('counts an untimed call but keeps it out of the histogram', () => {
    const entries: TranscriptEntry[] = [
      human(0),
      assistant({ requestId: 'r1', content: [toolUse('u1', 'Read')] }),
      toolResult({ at: 100, useId: 'u1', result: 'abc' }),
    ];
    const read = computeStats(entries).rollup.toolBreakdown.Read;
    expect(read.calls).toBe(1);
    expect(read.ms).toBe(0);
    expect(read.resultChars).toBe(3);
    // No duration was measurable, so nothing may vote in the p50 the
    // window-level slow-mcp rule reads off these counts.
    expect(read.buckets.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('ignores a tool_use with no usable name', () => {
    const entries: TranscriptEntry[] = [
      human(0),
      assistant({ at: 0, requestId: 'r1', content: [{ type: 'tool_use', id: 'u1', input: {} }] }),
      toolResult({ at: 100, useId: 'u1' }),
    ];
    const { rollup, turns } = computeStats(entries);
    expect(rollup.toolBreakdown).toEqual({});
    expect(rollup.toolCalls).toBe(0);
    expect(rollup.localToolMs).toBe(0);
    expect(turns[0].tools).toEqual([]);
  });

  it('records parallel tool calls from one turn against that turn', () => {
    const entries: TranscriptEntry[] = [
      human(0),
      assistant({ at: 0, requestId: 'r1', content: [toolUse('u1', 'Read')] }),
      assistant({ at: 0, requestId: 'r1', content: [toolUse('u2', 'Grep')] }),
      toolResult({ at: 300, useId: 'u1' }),
      toolResult({ at: 300, useId: 'u2' }),
    ];
    const { turns } = computeStats(entries);
    expect(turns).toHaveLength(1);
    expect(turns[0].tools.map((t) => t.name)).toEqual(['Read', 'Grep']);
  });
});

describe('computeStats — duration histogram', () => {
  it('has one bucket below the first bound, one between each pair and one above the last', () => {
    expect(HIST_BUCKET_COUNT).toBe(HIST_BUCKET_BOUNDS_MS.length + 1);
  });

  it('puts a duration in the bucket its bound opens', () => {
    const first = HIST_BUCKET_BOUNDS_MS[0];
    const last = HIST_BUCKET_BOUNDS_MS[HIST_BUCKET_BOUNDS_MS.length - 1];
    const durations = [0, first - 1, first, last - 1, last, last * 2];
    const entries: TranscriptEntry[] = [human(0)];
    let clock = 0;
    durations.forEach((d, i) => {
      entries.push(...toolCallPair(clock, d, i));
      clock += d + 1;
    });
    const { buckets } = computeStats(entries).rollup.toolBreakdown.Read;
    expect(buckets).toHaveLength(HIST_BUCKET_COUNT);
    expect(buckets[0]).toBe(2);
    expect(buckets[1]).toBe(1);
    expect(buckets[HIST_BUCKET_BOUNDS_MS.length - 1]).toBe(1);
    expect(buckets[HIST_BUCKET_BOUNDS_MS.length]).toBe(2);
    expect(buckets.reduce((a, b) => a + b, 0)).toBe(durations.length);
  });
});

describe('computeStats — sidechain', () => {
  it('keeps subagent traffic out of the lanes and turns, and sums its tokens', () => {
    const entries: TranscriptEntry[] = [
      human(0),
      assistant({ at: 0, requestId: 'r1', content: [toolUse('u1', 'Task')] }),
      assistant({ at: 10, requestId: 's1', sidechain: true, usage: { input: 1, output: 2, cacheRead: 3, create5m: 4 }, content: [toolUse('su1', 'Read')] }),
      assistant({ at: 20, requestId: 's1', sidechain: true, usage: { input: 1, output: 2, cacheRead: 3, create5m: 4 } }),
      toolResult({ at: 30, useId: 'su1', sidechain: true }),
      assistant({ at: 40, requestId: 's2', sidechain: true, usage: { input: 5 } }),
      toolResult({ at: 5000, useId: 'u1' }),
    ];
    const { rollup, turns } = computeStats(entries);
    expect(rollup.turns).toBe(1);
    expect(turns).toHaveLength(1);
    expect(rollup.subagentMs).toBe(5000);
    expect(rollup.localToolMs).toBe(0);
    expect(rollup.toolCalls).toBe(1);
    expect(rollup.subagentTokens).toBe(1 + 2 + 3 + 4 + 5);
    expect(rollup.inputTokens).toBe(0);
  });

  it('breaks sidechain usage down by the subagent\'s own model id, deduped by requestId', () => {
    const entries: TranscriptEntry[] = [
      human(0),
      assistant({ at: 0, requestId: 'r1', content: [toolUse('u1', 'Task')] }),
      // Two entries share requestId 's1' (one content block each) — usage
      // must count once, exactly like the parent-thread dedup.
      assistant({
        at: 10, requestId: 's1', sidechain: true, model: 'claude-haiku-4-5',
        usage: { input: 10, output: 20, cacheRead: 30, create5m: 5, create1h: 1 },
        content: [toolUse('su1', 'Read')],
      }),
      assistant({
        at: 20, requestId: 's1', sidechain: true, model: 'claude-haiku-4-5',
        usage: { input: 10, output: 20, cacheRead: 30, create5m: 5, create1h: 1 },
      }),
      toolResult({ at: 30, useId: 'su1', sidechain: true }),
      // A second subagent turn on a different model — subagents often run a
      // cheaper model than the parent, so this must land in its own bucket.
      assistant({ at: 40, requestId: 's2', sidechain: true, model: 'claude-opus-5', usage: { input: 7, output: 3 } }),
      toolResult({ at: 5000, useId: 'u1' }),
    ];
    const { rollup } = computeStats(entries);
    expect(rollup.subagentUsage).toEqual({
      'claude-haiku-4-5': { input: 10, output: 20, cacheRead: 30, cacheCreation: 6, cacheCreation5m: 5, cacheCreation1h: 1 },
      'claude-opus-5': { input: 7, output: 3, cacheRead: 0, cacheCreation: 0, cacheCreation5m: 0, cacheCreation1h: 0 },
    });
  });

  it('buckets a sidechain entry with no model under the empty-string key', () => {
    const entries: TranscriptEntry[] = [
      human(0),
      assistant({ at: 0, requestId: 'r1', content: [toolUse('u1', 'Task')] }),
      assistant({ at: 10, requestId: 's1', sidechain: true, usage: { input: 9 } }),
      toolResult({ at: 5000, useId: 'u1' }),
    ];
    const { rollup } = computeStats(entries);
    expect(rollup.subagentUsage['']).toMatchObject({ input: 9 });
  });
});

describe('computeStats — findings', () => {
  function cacheBurnEntries(turnCount: number, cacheRead: number): TranscriptEntry[] {
    const entries: TranscriptEntry[] = [human(0)];
    for (let i = 0; i < turnCount; i++) {
      entries.push(
        assistant({ at: i * 10, requestId: `req-${i}`, uuid: `a-${i}`, usage: { input: 1000, cacheRead } }),
      );
    }
    return entries;
  }

  it('fires cache-burn when the hit ratio stays below the threshold', () => {
    const { rollup } = computeStats(cacheBurnEntries(CACHE_BURN_MIN_TURNS, 100));
    const finding = rollup.findings.find((f) => f.rule === 'cache-burn');
    expect(finding).toBeDefined();
    expect(finding?.evidence.uncachedInputTokens).toBe(1000 * CACHE_BURN_MIN_TURNS);
    expect(finding?.evidence.turnsAffected).toBe(CACHE_BURN_MIN_TURNS);
    expect(finding?.evidence.totalTurns).toBe(CACHE_BURN_MIN_TURNS);
    expect(finding?.evidence.firstTurnUuid).toBe('a-0');
  });

  // The drilldown highlights the turn a rule blames by matching the evidence
  // uuid against the timeline's own (ADR `a-rule-names-its-turn-by-uuid`).
  // Nothing else ties the two together, so a turn that stopped carrying its
  // entry uuid — or carried a different one — would point every card at the
  // wrong lane while every other assertion here still passed.
  it('names a cache-burn turn the timeline carries, at the position it was measured on', () => {
    const { rollup, turns } = computeStats(cacheBurnEntries(CACHE_BURN_MIN_TURNS, 100));
    const evidence = rollup.findings.find((f) => f.rule === 'cache-burn')?.evidence;
    expect(turns.map((t) => t.uuid)).toEqual(turns.map((_, i) => `a-${i}`));
    expect(turns.findIndex((t) => t.uuid === evidence?.firstTurnUuid)).toBe(0);
  });

  it('does not fire cache-burn below the turn minimum', () => {
    const { rollup } = computeStats(cacheBurnEntries(CACHE_BURN_MIN_TURNS - 1, 100));
    expect(rollup.findings.some((f) => f.rule === 'cache-burn')).toBe(false);
  });

  it('does not fire cache-burn when the cache is doing its job', () => {
    const { rollup } = computeStats(cacheBurnEntries(CACHE_BURN_MIN_TURNS, 9000));
    expect(rollup.findings.some((f) => f.rule === 'cache-burn')).toBe(false);
  });

  it('fires obese-tool-result for the largest oversized result only', () => {
    const big = 'x'.repeat(OBESE_RESULT_TOKENS * CHARS_PER_TOKEN);
    const bigger = 'x'.repeat(OBESE_RESULT_TOKENS * CHARS_PER_TOKEN * 2);
    const entries: TranscriptEntry[] = [
      human(0),
      assistant({ at: 0, requestId: 'r1', uuid: 'a1', content: [toolUse('u1', 'Read')] }),
      toolResult({ at: 10, useId: 'u1', result: big }),
      assistant({ at: 20, requestId: 'r2', uuid: 'a2', content: [toolUse('u2', 'Grep')] }),
      toolResult({ at: 30, useId: 'u2', result: bigger }),
    ];
    const findings = computeStats(entries).rollup.findings.filter((f) => f.rule === 'obese-tool-result');
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence).toMatchObject({
      tool: 'Grep',
      chars: bigger.length,
      estimatedTokens: OBESE_RESULT_TOKENS * 2,
      toolUseId: 'u2',
      turnUuid: 'a2',
    });
  });

  it('does not fire obese-tool-result just below the threshold', () => {
    const entries: TranscriptEntry[] = [
      human(0),
      assistant({ at: 0, requestId: 'r1', content: [toolUse('u1', 'Read')] }),
      toolResult({ at: 10, useId: 'u1', result: 'x'.repeat(OBESE_RESULT_TOKENS * CHARS_PER_TOKEN - 1) }),
    ];
    expect(computeStats(entries).rollup.findings).toEqual([]);
  });

  function errorLoopEntries(count: number, opts: { vary?: boolean; fail?: boolean } = {}): TranscriptEntry[] {
    const entries: TranscriptEntry[] = [human(0)];
    for (let i = 0; i < count; i++) {
      entries.push(
        assistant({
          at: i * 100,
          requestId: `req-${i}`,
          uuid: `a-${i}`,
          content: [toolUse(`u${i}`, 'Bash', { cmd: opts.vary ? `run-${i}` : 'run' })],
        }),
        toolResult({ at: i * 100 + 10, useId: `u${i}`, isError: opts.fail !== false }),
      );
    }
    return entries;
  }

  it('fires error-loop on repeated identical failing calls', () => {
    const { rollup } = computeStats(errorLoopEntries(ERROR_LOOP_MIN_REPEATS));
    const finding = rollup.findings.find((f) => f.rule === 'error-loop');
    expect(finding?.evidence).toMatchObject({
      tool: 'Bash',
      count: ERROR_LOOP_MIN_REPEATS,
      firstTurnUuid: 'a-0',
      lastTurnUuid: `a-${ERROR_LOOP_MIN_REPEATS - 1}`,
    });
  });

  it('names the first and last error-loop turns the timeline carries', () => {
    const { rollup, turns } = computeStats(errorLoopEntries(ERROR_LOOP_MIN_REPEATS));
    const evidence = rollup.findings.find((f) => f.rule === 'error-loop')?.evidence;
    expect(turns.findIndex((t) => t.uuid === evidence?.firstTurnUuid)).toBe(0);
    expect(turns.findIndex((t) => t.uuid === evidence?.lastTurnUuid)).toBe(turns.length - 1);
  });

  it('names the obese result`s turn the timeline carries', () => {
    const big = 'x'.repeat(OBESE_RESULT_TOKENS * CHARS_PER_TOKEN);
    const entries: TranscriptEntry[] = [
      human(0),
      assistant({ at: 0, requestId: 'r1', uuid: 'a1' }),
      assistant({ at: 20, requestId: 'r2', uuid: 'a2', content: [toolUse('u2', 'Grep')] }),
      toolResult({ at: 30, useId: 'u2', result: big }),
    ];
    const { rollup, turns } = computeStats(entries);
    const evidence = rollup.findings.find((f) => f.rule === 'obese-tool-result')?.evidence;
    expect(turns.findIndex((t) => t.uuid === evidence?.turnUuid)).toBe(1);
  });

  it('does not fire error-loop one call short', () => {
    const { rollup } = computeStats(errorLoopEntries(ERROR_LOOP_MIN_REPEATS - 1));
    expect(rollup.findings.some((f) => f.rule === 'error-loop')).toBe(false);
  });

  it('does not fire error-loop when the input differs each time', () => {
    const { rollup } = computeStats(errorLoopEntries(ERROR_LOOP_MIN_REPEATS + 2, { vary: true }));
    expect(rollup.findings.some((f) => f.rule === 'error-loop')).toBe(false);
  });

  it('does not fire error-loop when the calls succeed', () => {
    const { rollup } = computeStats(errorLoopEntries(ERROR_LOOP_MIN_REPEATS + 2, { fail: false }));
    expect(rollup.findings.some((f) => f.rule === 'error-loop')).toBe(false);
  });

  it('breaks the error run on a success in the middle', () => {
    const fail = (i: number) => [
      assistant({ at: i * 100, requestId: `f${i}`, uuid: `f${i}`, content: [toolUse(`fu${i}`, 'Bash', { cmd: 'run' })] }),
      toolResult({ at: i * 100 + 10, useId: `fu${i}`, isError: true }),
    ];
    const entries: TranscriptEntry[] = [human(0)];
    const half = ERROR_LOOP_MIN_REPEATS - 1;
    for (let i = 0; i < half; i++) entries.push(...fail(i));
    entries.push(
      assistant({ at: 8000, requestId: 'ok', uuid: 'ok', content: [toolUse('ok1', 'Bash', { cmd: 'run' })] }),
      toolResult({ at: 8010, useId: 'ok1' }),
    );
    for (let i = half; i < half * 2; i++) entries.push(...fail(i + 100));
    expect(computeStats(entries).rollup.findings.some((f) => f.rule === 'error-loop')).toBe(false);
  });
});
