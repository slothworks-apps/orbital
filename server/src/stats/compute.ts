import type { TranscriptEntry, TranscriptUsage } from '../transcript/parser.js';
import { SUBAGENT_TOOLS } from '../transcript/subagents.js';
import { liveBranch } from '../transcript/liveBranch.js';
import {
  CACHE_BURN_MIN_HIT_RATIO,
  CACHE_BURN_MIN_TURNS,
  CHARS_PER_TOKEN,
  ERROR_LOOP_MIN_REPEATS,
  HIST_BUCKET_BOUNDS_MS,
  HIST_BUCKET_COUNT,
  HUMAN_WAIT_TOOLS,
  MCP_TOOL_PREFIX,
  OBESE_RESULT_TOKENS,
} from './constants.js';

export interface SessionStats {
  rollup: StatsRollup;
  /** Derived on demand for the waterfall and the slowest-turns list; never stored. */
  turns: TurnSegment[];
}

export interface StatsRollup {
  apiMs: number;
  localToolMs: number;
  mcpMs: number;
  subagentMs: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
  thinkingTokens: number;
  subagentTokens: number;
  /**
   * Sidechain usage, per the subagent's own model id (Ruling 11: subagents
   * often run a cheaper model than the parent session, so pricing the sum
   * under the parent's model would misprice it). `subagentTokens` above
   * stays the flat display sum; this is the priceable breakdown.
   */
  subagentUsage: Record<string, SubagentModelUsage>;
  toolCalls: number;
  toolErrors: number;
  toolBreakdown: Record<string, ToolStat>;
  findings: Finding[];
  /**
   * Time the session sat waiting on the user inside tool calls: the
   * `HUMAN_WAIT_TOOLS` runs plus every recorded permission wait. Never part of
   * the four work categories above (spec 2026-09-30-human-wait-tools-design).
   */
  humanWaitMs: number;
  /** The `HUMAN_WAIT_TOOLS` runs, which `toolBreakdown` and `toolCalls` never see. */
  humanBreakdown: Record<string, ToolStat>;
  /**
   * Permission waits keyed by the prompted tool's name; `ms` and `buckets` are
   * the wait, not the tool, and `errors` counts prompts that were not allowed.
   */
  permissionBreakdown: Record<string, ToolStat>;
}

export type PermissionOutcome = 'allowed' | 'denied' | 'aborted';

/**
 * One permission prompt the runner parked and settled, as `permission_waits`
 * stores it (ADR `permission-waits-are-measured-by-the-runner-only`).
 */
export interface PermissionWait {
  /** The prompted tool's `tool_use` id — a sidechain one for a subagent's prompt. */
  toolUseId: string;
  /**
   * The main-chain `Agent` call whose subagent raised the prompt, however deep
   * the subagent was nested; null for the main loop's own prompt, and for a
   * subagent's the runner could not place.
   */
  agentToolUseId: string | null;
  /** The name the runner was asked about — the fallback when the transcript lacks the tool_use. */
  toolName: string;
  shownAt: number;
  answeredAt: number;
  outcome: PermissionOutcome;
}

export interface SubagentModelUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cacheCreation5m: number;
  cacheCreation1h: number;
}

export interface ToolStat {
  calls: number;
  errors: number;
  ms: number;
  resultChars: number;
  /** Duration histogram over HIST_BUCKET_BOUNDS_MS, length HIST_BUCKET_COUNT. */
  buckets: number[];
}

export type ToolKind = 'local' | 'mcp' | 'subagent' | 'human';

export interface TurnSegment {
  /** Synthetic `turn-<index>` when the entry predates `requestId`. */
  requestId: string;
  /**
   * The uuid of the assistant entry that opened the turn — the same value the
   * findings below carry in `firstTurnUuid` / `turnUuid`, and the only thing
   * that lets the drilldown point a finding at a lane (ADR
   * `a-rule-names-its-turn-by-uuid`). Empty for an entry that has none.
   */
  uuid: string;
  startTs: number;
  apiMs: number;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  tools: Array<{
    name: string;
    kind: ToolKind;
    ms: number;
    isError: boolean;
    resultChars: number;
    /** The tool_use block id, so the UI can link into the transcript. */
    useId: string;
    /**
     * The permission wait cut out of `ms`, when there was one: the prompt on
     * this call, or for an `Agent` call the prompts its subagent raised.
     */
    waitMs?: number;
  }>;
}

export type FindingRule = 'cache-burn' | 'obese-tool-result' | 'error-loop';

export interface Finding {
  rule: FindingRule;
  /**
   * Measured numbers plus the entry uuids the UI links from. Severity is not
   * here on purpose: it is derived at read time, because cache-burn's depends
   * on a pricing table that ships with the build and may change under stored
   * findings.
   */
  evidence: Record<string, number | string | string[]>;
}

/** A finished tool run, in the order its result arrived — what the rules scan. */
interface ToolRun {
  name: string;
  inputKey: string;
  isError: boolean;
  resultChars: number;
  useId: string;
  turnUuid: string;
}

/** A dispatched tool_use still waiting for its result. */
interface PendingUse {
  name: string;
  inputKey: string;
  ts: number | null;
  turnIndex: number;
  turnUuid: string;
}

function emptyRollup(): StatsRollup {
  return {
    apiMs: 0, localToolMs: 0, mcpMs: 0, subagentMs: 0, turns: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    cacheCreation5mTokens: 0, cacheCreation1hTokens: 0, thinkingTokens: 0, subagentTokens: 0,
    subagentUsage: {},
    toolCalls: 0, toolErrors: 0, toolBreakdown: {}, findings: [],
    humanWaitMs: 0, humanBreakdown: {}, permissionBreakdown: {},
  };
}

function emptyToolStat(): ToolStat {
  return { calls: 0, errors: 0, ms: 0, resultChars: 0, buckets: new Array(HIST_BUCKET_COUNT).fill(0) };
}

function timestampOf(entry: TranscriptEntry): number | null {
  if (typeof entry.timestamp !== 'string') return null;
  const t = Date.parse(entry.timestamp);
  return Number.isNaN(t) ? null : t;
}

function blocksOf(entry: TranscriptEntry): Array<Record<string, unknown>> {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Transcripts hold whatever a tool returned; a value that cannot serialize measures 0. */
function serializedLength(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (value === undefined || value === null) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * What "the same call" means to error-loop. Key order is not normalised: the
 * CLI builds a repeated call's input the same way each time, so two genuinely
 * identical calls serialize identically.
 */
function inputFingerprint(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

export function toolKind(name: string): ToolKind {
  // SUBAGENT_TOOLS, not a local copy: the CLI has renamed this tool once
  // already and both names are on disk.
  if (SUBAGENT_TOOLS.has(name)) return 'subagent';
  if (HUMAN_WAIT_TOOLS.has(name)) return 'human';
  if (name.startsWith(MCP_TOOL_PREFIX)) return 'mcp';
  return 'local';
}

/** Index of the bucket a duration falls in: each bound opens the bucket above it. */
export function histogramBucket(ms: number): number {
  let i = 0;
  while (i < HIST_BUCKET_BOUNDS_MS.length && ms >= HIST_BUCKET_BOUNDS_MS[i]) i++;
  return i;
}

function usageTokens(usage: TranscriptUsage | undefined) {
  const creation = usage?.cache_creation;
  return {
    input: num(usage?.input_tokens),
    output: num(usage?.output_tokens),
    cacheRead: num(usage?.cache_read_input_tokens),
    cacheCreation: num(usage?.cache_creation_input_tokens),
    creation5m: num(creation?.ephemeral_5m_input_tokens),
    creation1h: num(creation?.ephemeral_1h_input_tokens),
    thinking: num(usage?.output_tokens_details?.thinking_tokens),
  };
}

/**
 * The whole stats layer in one pass over a parsed transcript: the rollup the
 * indexer stores and the per-turn timeline the drilldown asks for on demand.
 * Pure — no DB, no I/O — and it never throws: a transcript half-written or
 * from an older CLI degrades to partial numbers.
 *
 * A turn is the run of consecutive assistant entries sharing one `requestId`
 * (the CLI writes one entry per content block and repeats the usage on each,
 * so usage is counted once per request). Sidechain entries belong to a
 * subagent: their time is already covered by the parent's dispatching tool
 * run, so they only contribute `subagentTokens` (the flat display sum) and
 * `subagentUsage` (the same tokens, broken down by the subagent's own model
 * id, for pricing — Ruling 11).
 *
 * Main-chain entries off the live branch (a rewind's abandoned turns, an
 * interrupt's dangling call) were billed all the same, so their usage counts
 * toward the token totals; they open no turn, run no tool and time nothing,
 * so turns, tools, time and findings cover the live branch only (spec
 * 2026-09-29-rewind-design § After a rewind is sent).
 *
 * Human wait stays out of work time (spec 2026-09-30-human-wait-tools-design).
 * A `HUMAN_WAIT_TOOLS` run is the user answering, so it goes to `humanWaitMs`
 * and `humanBreakdown` and nowhere else. Each of `permissionWaits` is cut out
 * of the prompted tool's run, or for a subagent's prompt out of the
 * dispatching `Agent` run — the run a sidechain tool's time is counted in.
 */
export function computeStats(
  entries: TranscriptEntry[],
  permissionWaits: PermissionWait[] = [],
): SessionStats {
  const rollup = emptyRollup();
  const turns: TurnSegment[] = [];
  /** Turn uuids kept beside the segments — evidence needs them, the wire does not. */
  const turnUuids: string[] = [];
  const toolRuns: ToolRun[] = [];
  const pending = new Map<string, PendingUse>();
  const countedRequests = new Set<string>();
  const countedSidechainRequests = new Set<string>();
  const live = new Set(liveBranch(entries));
  /** Permission wait to cut out of each main-chain tool run, by its tool_use id. */
  const waitByUse = bankPermissionWaits(entries, permissionWaits, rollup);

  /**
   * Banks a request's usage in the totals, once per request; the tokens it
   * added, or null when the request was already banked.
   */
  const bankUsage = (key: string, entry: TranscriptEntry) => {
    if (countedRequests.has(key)) return null;
    countedRequests.add(key);
    const u = usageTokens(entry.message?.usage);
    rollup.inputTokens += u.input;
    rollup.outputTokens += u.output;
    rollup.cacheReadTokens += u.cacheRead;
    rollup.cacheCreationTokens += u.cacheCreation;
    rollup.cacheCreation5mTokens += u.creation5m;
    rollup.cacheCreation1hTokens += u.creation1h;
    rollup.thinkingTokens += u.thinking;
    return u;
  };

  /**
   * Where the next turn's API wait is measured from: the last main-chain entry
   * of any kind. A user entry (a human prompt or a tool_result) is when the
   * request went out; an assistant entry is when the previous response's last
   * token landed. Both must advance it, or two turns with nothing between them
   * — every turn on the no-requestId fallback path — measure the same gap
   * twice and the lanes climb past wall-clock.
   */
  let lastAnchorTs: number | null = null;
  let openTurnKey: string | null = null;

  /**
   * A tool_result closes the run its tool_use opened. A tool_use with no
   * result — an aborted turn — is left in `pending` and counts for nothing,
   * neither as a call nor as time.
   */
  const closeToolRun = (
    entry: TranscriptEntry,
    block: Record<string, unknown>,
    endTs: number | null,
  ) => {
    const useId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
    const use = pending.get(useId);
    if (!use) return;
    pending.delete(useId);

    // Both ends are needed for a duration. Without them the call still counts,
    // but it must not enter the histogram: a phantom sub-first-bound sample
    // would vote "fast" in the p50 the window-level slow-mcp rule reads.
    const startTs = use.ts;
    const timed = startTs !== null && endTs !== null;
    const rawMs = timed ? Math.max(0, endTs - startTs) : 0;
    // Clamped at the run: the runner's clock is not the transcript's, and a
    // wait must never leave a negative duration behind.
    const waitMs = Math.min(rawMs, waitByUse.get(useId) ?? 0);
    const ms = rawMs - waitMs;
    const isError = block.is_error === true;
    // The payload lives on the entry, not the block — the CLI never puts more
    // than one tool_result in an entry, so the two line up.
    const resultChars = serializedLength(entry.toolUseResult);
    const kind = toolKind(use.name);

    if (kind === 'human') {
      // The user answering, not work: no call, no error, no tool time — and no
      // ToolRun, since a rejected plan is not a failing tool.
      rollup.humanWaitMs += ms;
      const stat = (rollup.humanBreakdown[use.name] ??= emptyToolStat());
      stat.calls++;
      if (isError) stat.errors++;
      stat.ms += ms;
      stat.resultChars += resultChars;
      if (timed) stat.buckets[histogramBucket(ms)]++;
      turns[use.turnIndex]?.tools.push({ name: use.name, kind, ms, isError, resultChars, useId });
      return;
    }

    rollup.toolCalls++;
    if (isError) rollup.toolErrors++;
    if (kind === 'subagent') rollup.subagentMs += ms;
    else if (kind === 'mcp') rollup.mcpMs += ms;
    else rollup.localToolMs += ms;

    const stat = (rollup.toolBreakdown[use.name] ??= emptyToolStat());
    stat.calls++;
    if (isError) stat.errors++;
    stat.ms += ms;
    stat.resultChars += resultChars;
    if (timed) stat.buckets[histogramBucket(ms)]++;

    turns[use.turnIndex]?.tools.push({
      name: use.name, kind, ms, isError, resultChars, useId,
      ...(waitMs > 0 ? { waitMs } : {}),
    });
    toolRuns.push({
      name: use.name, inputKey: use.inputKey, isError, resultChars, useId,
      turnUuid: use.turnUuid,
    });
  };

  entries.forEach((entry, index) => {
    if (entry.isSidechain) {
      if (entry.type !== 'assistant') return;
      const key = entry.requestId || `sidechain-${index}`;
      if (countedSidechainRequests.has(key)) return;
      countedSidechainRequests.add(key);
      const u = usageTokens(entry.message?.usage);
      rollup.subagentTokens += u.input + u.output + u.cacheRead + u.cacheCreation;
      // Empty string when the entry carries no model — pricing falls back to
      // DEFAULT_PRICING for that bucket the same way an unrecognised id does.
      const model = typeof entry.message?.model === 'string' ? entry.message.model : '';
      const usage = (rollup.subagentUsage[model] ??= {
        input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation5m: 0, cacheCreation1h: 0,
      });
      usage.input += u.input;
      usage.output += u.output;
      usage.cacheRead += u.cacheRead;
      usage.cacheCreation += u.cacheCreation;
      usage.cacheCreation5m += u.creation5m;
      usage.cacheCreation1h += u.creation1h;
      return;
    }

    if (!live.has(entry)) {
      if (entry.type === 'assistant') bankUsage(entry.requestId || `turn-${index}`, entry);
      return;
    }

    if (entry.type === 'user') {
      openTurnKey = null;
      const ts = timestampOf(entry);
      if (ts !== null) lastAnchorTs = ts;
      for (const block of blocksOf(entry)) {
        if (block.type !== 'tool_result') continue;
        closeToolRun(entry, block, ts);
      }
      return;
    }

    if (entry.type !== 'assistant') return;

    const ts = timestampOf(entry);
    const key = entry.requestId || `turn-${index}`;
    if (key !== openTurnKey) {
      openTurnKey = key;
      const apiMs = ts !== null && lastAnchorTs !== null ? Math.max(0, ts - lastAnchorTs) : 0;
      rollup.apiMs += apiMs;
      const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
      // A repeated requestId (never seen in practice) still opens a segment,
      // but its usage was already banked and must not count twice.
      const u = bankUsage(key, entry);
      if (u) {
        tokens.input = u.input;
        tokens.output = u.output;
        tokens.cacheRead = u.cacheRead;
        tokens.cacheCreation = u.cacheCreation;
      }
      turns.push({ requestId: key, uuid: entry.uuid ?? '', startTs: ts ?? 0, apiMs, tokens, tools: [] });
      turnUuids.push(entry.uuid ?? '');
    }

    const turnIndex = turns.length - 1;
    for (const block of blocksOf(entry)) {
      if (block.type !== 'tool_use') continue;
      const id = typeof block.id === 'string' ? block.id : '';
      const name = typeof block.name === 'string' ? block.name : '';
      // A block missing either is unusable: no id means no result can ever be
      // matched to it, and no name means no lane and no leaderboard row.
      if (!id || !name) continue;
      pending.set(id, {
        name,
        inputKey: inputFingerprint(block.input),
        ts,
        turnIndex,
        turnUuid: turnUuids[turnIndex] ?? '',
      });
    }

    if (ts !== null) lastAnchorTs = ts;
  });

  rollup.turns = turns.length;
  rollup.findings = sessionFindings(rollup, turns, turnUuids, toolRuns);
  return { rollup, turns };
}

/**
 * Banks every permission wait in `humanWaitMs` and `permissionBreakdown`, and
 * returns how much to cut out of each main-chain tool run: the prompted call's
 * own for a main-loop prompt, the dispatching `Agent` call's for a subagent's.
 * A wait is banked whether or not its run is ever found — the user waited all
 * the same.
 */
function bankPermissionWaits(
  entries: TranscriptEntry[],
  waits: PermissionWait[],
  rollup: StatsRollup,
): Map<string, number> {
  const cut = new Map<string, number>();
  if (waits.length === 0) return cut;
  // The prompted tool's name as the transcript wrote it, sidechains included:
  // a subagent's tool_use lives only there.
  const names = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== 'assistant') continue;
    for (const block of blocksOf(entry)) {
      if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        names.set(block.id, block.name);
      }
    }
  }
  for (const wait of waits) {
    const ms = Math.max(0, wait.answeredAt - wait.shownAt);
    rollup.humanWaitMs += ms;
    const stat = (rollup.permissionBreakdown[names.get(wait.toolUseId) || wait.toolName] ??= emptyToolStat());
    stat.calls++;
    if (wait.outcome !== 'allowed') stat.errors++;
    stat.ms += ms;
    stat.buckets[histogramBucket(ms)]++;
    const target = wait.agentToolUseId ?? wait.toolUseId;
    cut.set(target, (cut.get(target) ?? 0) + ms);
  }
  return cut;
}

/** One finding per rule at most — the worst instance the session offers. */
function sessionFindings(
  rollup: StatsRollup,
  turns: TurnSegment[],
  turnUuids: string[],
  toolRuns: ToolRun[],
): Finding[] {
  const out: Finding[] = [];
  const burn = cacheBurn(rollup, turns, turnUuids);
  if (burn) out.push(burn);
  const obese = obeseToolResult(toolRuns);
  if (obese) out.push(obese);
  const loop = errorLoop(toolRuns);
  if (loop) out.push(loop);
  return out;
}

/** Cache reads over everything the session put in front of the model. */
function hitRatio(t: { input: number; cacheRead: number; cacheCreation: number }): number | null {
  const total = t.input + t.cacheRead + t.cacheCreation;
  return total > 0 ? t.cacheRead / total : null;
}

function cacheBurn(rollup: StatsRollup, turns: TurnSegment[], turnUuids: string[]): Finding | null {
  if (turns.length < CACHE_BURN_MIN_TURNS) return null;
  const ratio = hitRatio({
    input: rollup.inputTokens,
    cacheRead: rollup.cacheReadTokens,
    cacheCreation: rollup.cacheCreationTokens,
  });
  if (ratio === null || ratio >= CACHE_BURN_MIN_HIT_RATIO) return null;

  let turnsAffected = 0;
  let firstAffected = -1;
  turns.forEach((turn, i) => {
    const r = hitRatio(turn.tokens);
    if (r === null || r >= CACHE_BURN_MIN_HIT_RATIO) return;
    turnsAffected++;
    if (firstAffected < 0) firstAffected = i;
  });

  return {
    rule: 'cache-burn',
    evidence: {
      hitRatio: ratio,
      // Input the session paid full price for: neither read from the cache
      // nor written to it, which is the side of the bill this rule is about.
      uncachedInputTokens: rollup.inputTokens,
      turnsAffected,
      totalTurns: turns.length,
      firstTurnUuid: turnUuids[Math.max(firstAffected, 0)] ?? '',
    },
  };
}

function obeseToolResult(toolRuns: ToolRun[]): Finding | null {
  let worst: ToolRun | null = null;
  for (const run of toolRuns) {
    if (run.resultChars / CHARS_PER_TOKEN < OBESE_RESULT_TOKENS) continue;
    if (!worst || run.resultChars > worst.resultChars) worst = run;
  }
  if (!worst) return null;
  return {
    rule: 'obese-tool-result',
    evidence: {
      tool: worst.name,
      chars: worst.resultChars,
      estimatedTokens: Math.round(worst.resultChars / CHARS_PER_TOKEN),
      toolUseId: worst.useId,
      turnUuid: worst.turnUuid,
    },
  };
}

/** The longest run of identical failing calls, in the order the results landed. */
function errorLoop(toolRuns: ToolRun[]): Finding | null {
  let best: { first: ToolRun; last: ToolRun; count: number } | null = null;
  let first: ToolRun | null = null;
  let count = 0;
  for (const run of toolRuns) {
    const continues =
      run.isError && first !== null && first.name === run.name && first.inputKey === run.inputKey;
    if (continues) count++;
    else {
      first = run.isError ? run : null;
      count = run.isError ? 1 : 0;
    }
    if (first && count > (best?.count ?? 0)) best = { first, last: run, count };
  }
  if (!best || best.count < ERROR_LOOP_MIN_REPEATS) return null;
  return {
    rule: 'error-loop',
    evidence: {
      tool: best.first.name,
      count: best.count,
      firstTurnUuid: best.first.turnUuid,
      lastTurnUuid: best.last.turnUuid,
    },
  };
}
