import type { Finding, StatsRollup, SubagentModelUsage } from './compute.js';
import { CACHE_BURN_CRITICAL_USD } from './constants.js';

/** USD per million tokens. Ships with the build — see the task report for sourcing. */
export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

// Shared tier objects — several model-id prefixes resolve to the exact same
// row (e.g. every current-gen Opus dotted release, or Mythos mirroring
// Fable's per-token price), and duplicating the literals per prefix would let
// one of them drift on the next price edit.
const OPUS_CURRENT: ModelPricing = { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 };
const OPUS_LEGACY: ModelPricing = { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 };
const SONNET_CURRENT: ModelPricing = { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 };
const SONNET_LEGACY: ModelPricing = { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 };
const HAIKU_CURRENT: ModelPricing = { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 };
/** Fable 5 / Mythos 5 — cache reads at the standard 0.1× input rate. */
const FABLE_STANDARD: ModelPricing = { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1 };
/** Fable 5.1 / Mythos 5.1 — same per-token price as the standard row, but cache reads at a quarter of it. */
const FABLE_5_1: ModelPricing = { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 };

/**
 * One row per model-id prefix the CLI can report in `message.model`. Several
 * prefixes for one family overlap as plain strings (`claude-opus-4-8` starts
 * with both `claude-opus-` and `claude-opus-4-`) — `pricingFor` always picks
 * the *longest* matching prefix, never declaration order, so a family's
 * current-generation dotted releases (listed individually below) resolve to
 * the current tier even though a broader, differently-priced prefix for the
 * same family also matches. Keep that invariant in mind before adding a row:
 * a new prefix only needs to be more specific than whatever it must
 * override, not first in this object.
 *
 * Deliberately one price per tier, not one per dated snapshot: the spec's
 * whole point is that a price bump ships as an edit here and reprices
 * history at read time, with no reindex and no per-token override table
 * (spec §Tokens and cost).
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-': OPUS_CURRENT,
  // Opus 4 and 4.1 only — the pre-price-cut generation. Opus 4.5 and later
  // dotted releases are listed below at the current rate so they don't fall
  // through to this broader, more expensive prefix.
  'claude-opus-4-': OPUS_LEGACY,
  'claude-opus-4-5': OPUS_CURRENT,
  'claude-opus-4-6': OPUS_CURRENT,
  'claude-opus-4-7': OPUS_CURRENT,
  'claude-opus-4-8': OPUS_CURRENT,
  'claude-sonnet-': SONNET_CURRENT,
  'claude-sonnet-4-': SONNET_LEGACY,
  'claude-haiku-': HAIKU_CURRENT,
  'claude-fable-': FABLE_STANDARD,
  'claude-fable-5-1': FABLE_5_1,
  'claude-mythos-': FABLE_STANDARD,
  'claude-mythos-5-1': FABLE_5_1,
};

/** Priced as current-gen Sonnet: the mainstream default tier, so an unpriced model neither over- nor under-states cost by an extreme margin. */
export const DEFAULT_PRICING: ModelPricing = SONNET_CURRENT;

/** Matches a model id to its most specific known prefix; anything unrecognised prices as DEFAULT_PRICING. */
export function pricingFor(model: string): ModelPricing {
  let best: { prefix: string; pricing: ModelPricing } | null = null;
  for (const [prefix, pricing] of Object.entries(MODEL_PRICING)) {
    if (!model.startsWith(prefix)) continue;
    if (!best || prefix.length > best.prefix.length) best = { prefix, pricing };
  }
  return best?.pricing ?? DEFAULT_PRICING;
}

export interface CostSplit {
  uncachedInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  total: number;
}

const TOKENS_PER_MILLION = 1_000_000;

/** The token counts `priceUsage` needs — `costOf` reads them off a StatsRollup, `costOfSubagentUsage` off a per-model subagent bucket. */
interface RawUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cacheCreation5m: number;
  cacheCreation1h: number;
}

function priceUsage(u: RawUsage, p: ModelPricing): CostSplit {
  const uncachedInput = (u.input / TOKENS_PER_MILLION) * p.input;
  const cacheRead = (u.cacheRead / TOKENS_PER_MILLION) * p.cacheRead;
  // Transcripts written before the CLI split cache_creation_input_tokens
  // into the 5m/1h ephemeral pair carry a creation total with no breakdown
  // at all — price whatever the split doesn't account for at the 5m rate
  // rather than silently dropping it from cost.
  const unattributed = Math.max(0, u.cacheCreation - (u.cacheCreation5m + u.cacheCreation1h));
  const cacheWrite =
    (u.cacheCreation5m / TOKENS_PER_MILLION) * p.cacheWrite5m +
    (u.cacheCreation1h / TOKENS_PER_MILLION) * p.cacheWrite1h +
    (unattributed / TOKENS_PER_MILLION) * p.cacheWrite5m;
  const output = (u.output / TOKENS_PER_MILLION) * p.output;
  return { uncachedInput, cacheRead, cacheWrite, output, total: uncachedInput + cacheRead + cacheWrite + output };
}

/**
 * The main thread's cost only — the drilldown's "where the money went"
 * four-way split (spec §Tokens and cost). Output cost is priced off
 * `outputTokens` alone — `thinkingTokens` is a breakdown of it, already
 * counted in `output_tokens`, not an addition. Subagent spend is priced
 * separately by `costOfSubagentUsage`, never folded in here: a subagent
 * commonly runs a different (usually cheaper) model than the parent session,
 * so pricing its tokens at the parent's rate would misprice them (Ruling 11).
 */
export function costOf(rollup: StatsRollup, model: string): CostSplit {
  return priceUsage(
    {
      input: rollup.inputTokens,
      output: rollup.outputTokens,
      cacheRead: rollup.cacheReadTokens,
      cacheCreation: rollup.cacheCreationTokens,
      cacheCreation5m: rollup.cacheCreation5mTokens,
      cacheCreation1h: rollup.cacheCreation1hTokens,
    },
    pricingFor(model),
  );
}

/**
 * Subagent spend, each model in `subagentUsage` priced at its own rate
 * (Ruling 11) and summed to one USD total — the per-session and per-window
 * cost totals both add this on top of `costOf(...).total` for the main
 * thread.
 */
export function costOfSubagentUsage(subagentUsage: Record<string, SubagentModelUsage>): number {
  let total = 0;
  for (const [model, u] of Object.entries(subagentUsage)) {
    total += priceUsage(
      {
        input: u.input,
        output: u.output,
        cacheRead: u.cacheRead,
        cacheCreation: u.cacheCreation,
        cacheCreation5m: u.cacheCreation5m,
        cacheCreation1h: u.cacheCreation1h,
      },
      pricingFor(model),
    ).total;
  }
  return total;
}

export type Severity = 'critical' | 'warning' | 'info';

/**
 * Severity is resolved at read time, never stored: cache-burn's depends on
 * the shipped pricing table, which can change under a stored finding (spec
 * §Heuristic findings).
 */
export function severityOf(finding: Finding, model: string): Severity {
  switch (finding.rule) {
    case 'error-loop':
      return 'critical';
    case 'obese-tool-result':
      return 'warning';
    case 'cache-burn': {
      const tokens =
        typeof finding.evidence.uncachedInputTokens === 'number' ? finding.evidence.uncachedInputTokens : 0;
      const usd = (tokens / TOKENS_PER_MILLION) * pricingFor(model).input;
      return usd >= CACHE_BURN_CRITICAL_USD ? 'critical' : 'warning';
    }
  }
}
