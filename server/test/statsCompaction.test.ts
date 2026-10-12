import { describe, expect, it } from 'vitest';
import { computeCompactionStats, emptyCompactionStats } from '../src/stats/compaction.js';
import { autoCompactSummary, type WindowRow } from '../src/stats/window.js';
import { autoCompactPrompt } from '../src/runner/autoCompact.js';
import type { StatsRollup } from '../src/stats/compute.js';
import type { TranscriptEntry } from '../src/transcript/parser.js';

/** Compaction stats (spec 2026-10-10-auto-compact-between-turns-design § Stats). */

const prompt = (text: string): TranscriptEntry => ({ type: 'user', message: { role: 'user', content: text } } as TranscriptEntry);
const request = (id: string, read: number, write = 0, reads: string[] = []): TranscriptEntry =>
  ({
    type: 'assistant',
    requestId: id,
    message: {
      role: 'assistant',
      usage: { input_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 5 },
      content: reads.map((path, i) => ({ type: 'tool_use', id: `${id}-${i}`, name: 'Read', input: { file_path: path } })),
    },
  }) as unknown as TranscriptEntry;
const boundary = (trigger: string, pre: number, post: number): TranscriptEntry =>
  ({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger, preTokens: pre, postTokens: post, durationMs: 90_000 } }) as TranscriptEntry;

describe('computeCompactionStats', () => {
  it('counts what every later request did not carry, until a compaction Orbital did not start', () => {
    const stats = computeCompactionStats([
      prompt('go'),
      request('r1', 250_000, 0, ['/a.ts', '/b.ts']),
      prompt(autoCompactPrompt(200_000)),
      boundary('manual', 250_000, 20_000),
      request('r2', 0, 20_000), // the summary written to the cache: counted as a read, its write is in the cost
      prompt('next'),
      request('r3', 30_000, 0, ['/a.ts', '/c.ts', '/a.ts']),
      request('r4', 0, 40_000), // a cold cache: the counterfactual would have written it
      boundary('auto', 300_000, 25_000),
      request('r5', 30_000),
    ]);
    expect(stats).toMatchObject({
      orbital: 1, manual: 0, auto: 1, measured: 1, preTokens: 250_000, postTokens: 20_000,
      timed: 1, durationMs: 90_000,
      savedReadTokens: 2 * 230_000, savedWriteTokens: 230_000,
      costReadTokens: 250_000, costOutputTokens: 20_000, costWriteTokens: 20_000,
      rereads: 1, mainRequests: 5,
    });
  });

  it('counts a plain /compact as manual and saves nothing for it', () => {
    const stats = computeCompactionStats([prompt('/compact'), boundary('manual', 250_000, 20_000), request('r1', 20_000)]);
    expect(stats).toMatchObject({ orbital: 0, manual: 1, savedReadTokens: 0, costReadTokens: 0 });
  });

  it('closes the re-read window at the second prompt after the compaction', () => {
    const stats = computeCompactionStats([
      request('r1', 1, 0, ['/a.ts']),
      prompt(autoCompactPrompt(200_000)),
      boundary('manual', 250_000, 20_000),
      prompt('one'),
      prompt('two'),
      request('r2', 1, 0, ['/a.ts']),
    ]);
    expect(stats.rereads).toBe(0);
  });
});

function row(compaction: Partial<StatsRollup['compaction']>, extra: Partial<StatsRollup> = {}, permissionTimed = true): WindowRow {
  return {
    sessionId: Math.random().toString(),
    lastAt: 0,
    projectDir: '/p',
    model: 'claude-opus-5-5',
    permissionTimed,
    rollup: {
      apiMs: 0, localToolMs: 0, mcpMs: 0, subagentMs: 0, turns: 10,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheCreationTokens: 0,
      cacheCreation5mTokens: 0, cacheCreation1hTokens: 0, thinkingTokens: 0, subagentTokens: 0,
      subagentUsage: {}, toolCalls: 0, toolErrors: 0, toolBreakdown: {}, findings: [],
      humanWaitMs: 0, humanBreakdown: {}, permissionBreakdown: {},
      compaction: { ...emptyCompactionStats(), ...compaction },
      ...extra,
    },
  };
}

describe('autoCompactSummary', () => {
  it('nets the saving against the cost at each session\'s own prices', () => {
    const summary = autoCompactSummary([
      row({ orbital: 1, measured: 1, preTokens: 250_000, postTokens: 20_000, savedReadTokens: 2_000_000,
        costReadTokens: 250_000, costOutputTokens: 20_000, costWriteTokens: 20_000, mainRequests: 10, contextTokens: 1_000_000 }),
      row({ manual: 2, mainRequests: 10, contextTokens: 3_000_000 }),
      row({ auto: 1 }, {}, false),
    ]);
    // Opus: read $0.5/M, output $25/M, 1h write $10/M.
    expect(summary.savedUsd).toBeCloseTo(1);
    expect(summary.costUsd).toBeCloseTo(0.125 + 0.5 + 0.19);
    expect(summary.netUsd).toBeCloseTo(1 - 0.815);
    // The session cost $0.5 as it ran, and would have cost $0.685 without it.
    expect(summary.netPct).toBeCloseTo(0.185 / 0.685);
    expect(summary).toMatchObject({ compactions: 1, otherCompactions: 3, avgPreTokens: 250_000, avgPostTokens: 20_000 });
    expect(summary.withAutoCompact).toMatchObject({ sessions: 1, avgContextTokens: 100_000 });
    expect(summary.withoutAutoCompact).toMatchObject({ sessions: 1, avgContextTokens: 300_000 });
  });

  it('has nothing to say with no Orbital compaction', () => {
    const summary = autoCompactSummary([row({})]);
    expect(summary).toMatchObject({ compactions: 0, netPct: null, avgPreTokens: null, avgDurationMs: null });
  });
});
