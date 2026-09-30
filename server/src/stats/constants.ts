/**
 * Every threshold the stats engine tests against. They live here so a
 * definition change is one edit and so `statsVersion` has something to point
 * at: bump it whenever a value below moves, or stored rollups mean two
 * different things at once.
 */

/**
 * What the stored rollups in `session_stats` were computed by. Bump it
 * whenever a threshold below moves or `computeStats` changes what a column
 * means: the indexer then recomputes every session, including files whose
 * mtime and size have not changed since they were last indexed.
 */
export const STATS_VERSION = 3;

/**
 * How many turns a live session runs before the watcher tail recomputes its
 * rollup (spec § Evaluation cadence). Each tick is a full reparse of the
 * transcript, so this is a cost ceiling as much as a freshness floor.
 */
export const STATS_LIVE_RECOMPUTE_TURNS = 10;

/**
 * Duration histogram boundaries in milliseconds, log₂ apart. Stored per tool
 * so the overview can merge sessions and read a p50 off the merged counts
 * without keeping every individual duration.
 */
export const HIST_BUCKET_BOUNDS_MS = [250, 500, 1000, 2000, 4000, 8000, 16000, 32000, 64000];

/** One bucket below the first bound, one between each pair, one above the last. */
export const HIST_BUCKET_COUNT = HIST_BUCKET_BOUNDS_MS.length + 1;

/** cache-burn stays quiet until a session has enough turns for the ratio to mean anything. */
export const CACHE_BURN_MIN_TURNS = 10;

/** Cache hits over all input the session paid to put in front of the model. */
export const CACHE_BURN_MIN_HIT_RATIO = 0.6;

/** Tool results are measured in characters; tokens are an estimate, never billed. */
export const CHARS_PER_TOKEN = 4;

/** One tool result this large drowns the context window on its own. */
export const OBESE_RESULT_TOKENS = 25_000;

/** Identical failing calls in a row before the agent is judged to be stuck. */
export const ERROR_LOOP_MIN_REPEATS = 5;

/** The prefix the CLI gives every MCP tool: `mcp__<server>__<tool>`. */
export const MCP_TOOL_PREFIX = 'mcp__';

/**
 * Tools whose `tool_use` → `tool_result` gap is the user answering, not work:
 * a question and a plan approval. Their runs are human wait, never tool time
 * (spec 2026-09-30-human-wait-tools-design).
 */
export const HUMAN_WAIT_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** cache-burn's severity crosses from WARNING to CRITICAL at this priced cost. */
export const CACHE_BURN_CRITICAL_USD = 10;

/** slow-mcp needs a p50 this slow, server-wide across the window, before it fires. */
export const SLOW_MCP_P50_MS = 5000;

/** slow-mcp needs at least this many window-wide calls before a p50 means anything. */
export const SLOW_MCP_MIN_CALLS = 10;

/** A rule drops into RESOLVED once this many sessions since its last firing came up clean. */
export const RESOLVED_CLEAN_SESSIONS = 5;

/** A RESOLVED entry drops off the feed once its last firing is older than this. */
export const RESOLVED_TTL_DAYS = 7;

/** Both the tool leaderboard's slowest and most-expensive rankings stop here. */
export const TOOL_LEADERBOARD_LIMIT = 10;
