import { describe, it, expect } from 'vitest';
import { MODEL_PRICING, DEFAULT_PRICING, pricingFor, costOf, costOfSubagentUsage, severityOf } from '../src/stats/pricing.js';
import { CACHE_BURN_CRITICAL_USD } from '../src/stats/constants.js';
import type { StatsRollup, Finding, SubagentModelUsage } from '../src/stats/compute.js';

function rollup(overrides: Partial<StatsRollup> = {}): StatsRollup {
  return {
    apiMs: 0, localToolMs: 0, mcpMs: 0, subagentMs: 0, turns: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    cacheCreation5mTokens: 0, cacheCreation1hTokens: 0, thinkingTokens: 0, subagentTokens: 0,
    subagentUsage: {},
    toolCalls: 0, toolErrors: 0, toolBreakdown: {}, findings: [],
    humanWaitMs: 0, humanBreakdown: {}, permissionBreakdown: {},
    ...overrides,
  };
}

function subagentUsage(overrides: Partial<SubagentModelUsage> = {}): SubagentModelUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation5m: 0, cacheCreation1h: 0, ...overrides };
}

describe('pricingFor — prefix match and fallback', () => {
  it('matches each current-generation model family by prefix', () => {
    expect(pricingFor('claude-opus-5')).toBe(MODEL_PRICING['claude-opus-']);
    expect(pricingFor('claude-sonnet-5')).toBe(MODEL_PRICING['claude-sonnet-']);
    expect(pricingFor('claude-haiku-4-5')).toBe(MODEL_PRICING['claude-haiku-']);
  });

  it('falls back to DEFAULT_PRICING for a genuinely unrecognised model id', () => {
    expect(pricingFor('some-future-model')).toBe(DEFAULT_PRICING);
    expect(pricingFor('')).toBe(DEFAULT_PRICING);
    expect(pricingFor('gpt-4')).toBe(DEFAULT_PRICING);
  });

  it('prices every family strictly higher on output than input, and cache read below input', () => {
    for (const pricing of Object.values(MODEL_PRICING)) {
      expect(pricing.output).toBeGreaterThan(pricing.input);
      expect(pricing.cacheRead).toBeLessThan(pricing.input);
      expect(pricing.cacheWrite5m).toBeGreaterThan(pricing.input);
      expect(pricing.cacheWrite1h).toBeGreaterThan(pricing.cacheWrite5m);
    }
  });

  // Finding 1 — Fable 5.1's cache-read rate is a quarter of Fable 5's; the
  // two must not collapse onto the same row.
  it('resolves claude-fable-5-1 to its own row, distinct from and cheaper on cache reads than claude-fable-5', () => {
    const fable51 = pricingFor('claude-fable-5-1');
    const fable5 = pricingFor('claude-fable-5');
    expect(fable51).not.toBe(fable5);
    expect(fable51.cacheRead).toBeLessThan(fable5.cacheRead);
    expect(fable51.input).toBe(fable5.input); // same per-token price otherwise
    expect(fable51.output).toBe(fable5.output);
  });

  // Same pattern on Mythos — it mirrors Fable's per-token price including the
  // 5.1-only cache-read discount, so it needs the identical distinguishing row.
  it('resolves claude-mythos-5-1 to its own row, distinct from and cheaper on cache reads than claude-mythos-5', () => {
    const mythos51 = pricingFor('claude-mythos-5-1');
    const mythos5 = pricingFor('claude-mythos-5');
    expect(mythos51).not.toBe(mythos5);
    expect(mythos51.cacheRead).toBeLessThan(mythos5.cacheRead);
    expect(mythos51).toEqual(pricingFor('claude-fable-5-1')); // same rates as Fable
    expect(mythos5).toEqual(pricingFor('claude-fable-5'));
  });

  // Finding 4 — prior-generation Sonnet 4.x is a real, more expensive tier
  // that must not collapse onto Sonnet 5's row just because both prefixes match.
  it('prices claude-sonnet-4-6 at the legacy Sonnet 4.x rate, not the current Sonnet 5 rate', () => {
    const legacy = pricingFor('claude-sonnet-4-6');
    const current = pricingFor('claude-sonnet-5');
    expect(legacy).not.toBe(current);
    expect(legacy.input).toBeGreaterThan(current.input);
    expect(legacy.output).toBeGreaterThan(current.output);
  });

  // Finding 4 — prior-generation Opus 4/4.1 is far more expensive than
  // current-gen Opus, but the dotted 4.5/4.6/4.7/4.8 releases sit at the
  // *current* rate despite also matching the broader `claude-opus-4-` prefix
  // — this is exactly the longest-prefix-first collision the fix guards.
  it('prices legacy Opus 4/4.1 higher than current-gen Opus, and does not swallow the 4.5+ dotted releases into the legacy tier', () => {
    const current = pricingFor('claude-opus-5');
    const legacy41 = pricingFor('claude-opus-4-1');
    const legacy40 = pricingFor('claude-opus-4-0');
    expect(legacy41.input).toBeGreaterThan(current.input);
    expect(legacy40.input).toBeGreaterThan(current.input);
    for (const dotted of ['claude-opus-4-5', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8']) {
      expect(pricingFor(dotted)).toBe(current);
      expect(pricingFor(dotted).input).toBeLessThan(legacy41.input);
    }
    // A dated snapshot of the legacy generation still resolves to the legacy tier.
    expect(pricingFor('claude-opus-4-20250514')).toBe(legacy41);
  });
});

describe('costOf — the four-way split for a known token set', () => {
  it('prices input, cache read, cache write (5m + 1h) and output independently', () => {
    const p = MODEL_PRICING['claude-sonnet-'];
    const r = rollup({
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 2_000_000,
      cacheCreationTokens: 300_000,
      cacheCreation5mTokens: 200_000,
      cacheCreation1hTokens: 100_000,
    });
    const cost = costOf(r, 'claude-sonnet-5');
    expect(cost.uncachedInput).toBeCloseTo(1 * p.input, 6);
    expect(cost.output).toBeCloseTo(0.5 * p.output, 6);
    expect(cost.cacheRead).toBeCloseTo(2 * p.cacheRead, 6);
    expect(cost.cacheWrite).toBeCloseTo(0.2 * p.cacheWrite5m + 0.1 * p.cacheWrite1h, 6);
    expect(cost.total).toBeCloseTo(
      cost.uncachedInput + cost.cacheRead + cost.cacheWrite + cost.output,
      6,
    );
  });

  it('prices a session with thinking tokens using the output rate — thinking is part of output', () => {
    const p = MODEL_PRICING['claude-opus-'];
    const r = rollup({ outputTokens: 1_000_000, thinkingTokens: 400_000 });
    // thinkingTokens is a breakdown of outputTokens, not an addition to it —
    // output cost must key off outputTokens alone.
    const cost = costOf(r, 'claude-opus-5');
    expect(cost.output).toBeCloseTo(1 * p.output, 6);
  });

  it('prices an all-zero rollup at zero', () => {
    const cost = costOf(rollup(), 'claude-sonnet-5');
    expect(cost).toEqual({ uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 });
  });

  it('falls back to DEFAULT_PRICING for an unknown model id without throwing', () => {
    const r = rollup({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(() => costOf(r, 'claude-unicorn-9')).not.toThrow();
    const cost = costOf(r, 'claude-unicorn-9');
    expect(cost.uncachedInput).toBeCloseTo(DEFAULT_PRICING.input, 6);
    expect(cost.output).toBeCloseTo(DEFAULT_PRICING.output, 6);
  });

  // Finding 2 — a transcript written before the CLI split cache_creation into
  // its 5m/1h breakdown carries a nonzero total with no attribution at all.
  it('prices a cache-creation total with no 5m/1h breakdown at the 5m rate, instead of zero', () => {
    const p = MODEL_PRICING['claude-sonnet-'];
    const r = rollup({ cacheCreationTokens: 1_000_000, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 });
    const cost = costOf(r, 'claude-sonnet-5');
    expect(cost.cacheWrite).toBeCloseTo(1 * p.cacheWrite5m, 6);
  });

  it('prices the unattributed remainder on top of a partial 5m/1h breakdown', () => {
    const p = MODEL_PRICING['claude-sonnet-'];
    // total 1,000,000 but the split only accounts for 600,000 — the other
    // 400,000 is the unattributed remainder, priced at the 5m rate.
    const r = rollup({ cacheCreationTokens: 1_000_000, cacheCreation5mTokens: 400_000, cacheCreation1hTokens: 200_000 });
    const cost = costOf(r, 'claude-sonnet-5');
    expect(cost.cacheWrite).toBeCloseTo(0.4 * p.cacheWrite5m + 0.2 * p.cacheWrite1h + 0.4 * p.cacheWrite5m, 6);
  });
});

describe('costOfSubagentUsage — Ruling 11, subagent spend priced per its own model', () => {
  it('returns zero for an empty usage record', () => {
    expect(costOfSubagentUsage({})).toBe(0);
  });

  it('prices a single model bucket the same way costOf prices a rollup', () => {
    const p = MODEL_PRICING['claude-haiku-'];
    const usage = subagentUsage({ input: 1_000_000, output: 500_000, cacheRead: 200_000 });
    const total = costOfSubagentUsage({ 'claude-haiku-4-5': usage });
    expect(total).toBeCloseTo(1 * p.input + 0.5 * p.output + 0.2 * p.cacheRead, 6);
  });

  it('prices a two-model usage record at each model\'s own rate and sums them', () => {
    const haiku = MODEL_PRICING['claude-haiku-'];
    const opus = MODEL_PRICING['claude-opus-'];
    const usage = {
      'claude-haiku-4-5': subagentUsage({ input: 1_000_000 }),
      'claude-opus-5': subagentUsage({ input: 1_000_000 }),
    };
    const total = costOfSubagentUsage(usage);
    expect(total).toBeCloseTo(haiku.input + opus.input, 6);
    // Sanity: the two models must not have been priced identically.
    expect(haiku.input).not.toBe(opus.input);
  });

  it('falls back to DEFAULT_PRICING for an unrecognised subagent model id', () => {
    const usage = { 'some-unknown-subagent-model': subagentUsage({ input: 1_000_000 }) };
    expect(costOfSubagentUsage(usage)).toBeCloseTo(DEFAULT_PRICING.input, 6);
  });
});

describe('severityOf — rule-fixed and priced severities', () => {
  it('is always CRITICAL for error-loop', () => {
    const finding: Finding = { rule: 'error-loop', evidence: { tool: 'Bash', count: 5 } };
    expect(severityOf(finding, 'claude-haiku-4-5')).toBe('critical');
  });

  it('is always WARNING for obese-tool-result', () => {
    const finding: Finding = { rule: 'obese-tool-result', evidence: { tool: 'Read', chars: 999 } };
    expect(severityOf(finding, 'claude-opus-5')).toBe('warning');
  });

  it('prices cache-burn CRITICAL when uncached input at the model rate reaches the $10 line', () => {
    const p = MODEL_PRICING['claude-sonnet-']; // $/MTok
    const tokensAtThreshold = (CACHE_BURN_CRITICAL_USD / p.input) * 1_000_000;
    const finding: Finding = {
      rule: 'cache-burn',
      evidence: { hitRatio: 0.1, uncachedInputTokens: tokensAtThreshold, turnsAffected: 10, totalTurns: 10, firstTurnUuid: 'x' },
    };
    expect(severityOf(finding, 'claude-sonnet-5')).toBe('critical');
  });

  it('prices cache-burn WARNING just below the $10 line', () => {
    const p = MODEL_PRICING['claude-sonnet-'];
    const tokensJustUnder = (CACHE_BURN_CRITICAL_USD / p.input) * 1_000_000 - 1000;
    const finding: Finding = {
      rule: 'cache-burn',
      evidence: { hitRatio: 0.1, uncachedInputTokens: tokensJustUnder, turnsAffected: 10, totalTurns: 10, firstTurnUuid: 'x' },
    };
    expect(severityOf(finding, 'claude-sonnet-5')).toBe('warning');
  });

  it('resolves cache-burn severity against the priced model, not a fixed rate', () => {
    // The same token count is cheap on Haiku and expensive on Fable — severity
    // must track the model the session actually ran on.
    const tokens = 2_000_000;
    const finding: Finding = {
      rule: 'cache-burn',
      evidence: { hitRatio: 0.1, uncachedInputTokens: tokens, turnsAffected: 10, totalTurns: 10, firstTurnUuid: 'x' },
    };
    expect(severityOf(finding, 'claude-haiku-4-5')).toBe('warning');
    expect(severityOf(finding, 'claude-fable-5')).toBe('critical');
  });
});
