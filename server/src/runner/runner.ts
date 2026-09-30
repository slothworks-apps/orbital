import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { Hub } from '../api/hub.js';
import type { PermissionMode, SessionStatus, ChatMessage } from '../types.js';
import type { TranscriptEntry } from '../transcript/parser.js';
import { TASK_EVENT_SUBTYPES, type TaskEvent, type SubagentTranscripts } from '../transcript/subagents.js';
import { TASK_LAUNCHING_TOOLS, type LaunchingCall } from '../transcript/backgroundTasks.js';
import { imageRefOf, splitUserText, toolResultParts } from '../transcript/parser.js';
import { noticeFromSdkMessage } from '../transcript/notices.js';
import {
  compactSummaryText,
  failureMessage,
  markFromSdkBoundary,
  type CompactionFailureRecord,
} from '../transcript/compaction.js';
import type { ImageStore, ImageWriter } from '../images/store.js';
import type { IdeApprovals, IdeReviewVerdict } from '../ide/approvals.js';

/**
 * How long a turn's end waits for the CLI to say how full the window is
 * before falling back to the turn's last API call. Short on purpose: the
 * request is answered by an idle CLI in milliseconds, and the thing it is
 * holding up — every subsequent message of the session — matters more than
 * the small accuracy it buys.
 */
const CONTEXT_USAGE_TIMEOUT_MS = 2_000;

/**
 * How long a rewind waits for the session's `claude` process to exit once
 * it has been told to stop, before it gives up and says so. A rewind must
 * not start a second process on the same transcript while the first may
 * still be writing to it (spec 2026-09-29-rewind-design § Runner).
 */
export const REWIND_STOP_TIMEOUT_MS = 10_000;

/**
 * How the CLI words a truncating resume it will not do: the
 * `--resume-drops-turn` guard refusing the range, and a fork point it cannot
 * load (one before the newest compaction). Both arrive as the `errors[0]` of
 * an `error_during_execution` result before `system/init`, and the query's
 * iterator then throws the same text (spec § Verification).
 */
export const REWIND_REFUSAL_PREFIXES = [
  'Resume rejected by --resume-drops-turn:',
  'No message found with message.uuid of:',
] as const;

/** The refusal text when `text` is one of the CLI's rewind refusals, else null. */
export function rewindRefusal(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const at = Math.min(
    ...REWIND_REFUSAL_PREFIXES.map((p) => text.indexOf(p)).filter((i) => i >= 0),
  );
  return Number.isFinite(at) ? text.slice(at).trim() : null;
}

/**
 * What a truncating resume tells whoever holds the pending rewind: the CLI
 * took it (`system/init` arrived — a refusal always comes before it), or it
 * refused, with the CLI's own words.
 */
export interface RewindHooks {
  started(): void;
  refused(message: string): void;
}

/**
 * How long a session may sit waiting on the user before its `claude` process
 * is stopped. Stopping is not ending: the session reads `idle` and the next
 * message resumes it through the revive path (spec
 * 2026-09-24-sessions-end-only-by-hand-design § 2). A constant rather than a
 * setting, because the user cannot see the difference between a sleeping
 * session and an idle one.
 */
const SLEEP_AFTER_IDLE_MINUTES = 30;

/**
 * Appended to the `claude_code` preset while Settings › Experimental ›
 * "Comment for Narrate" is on (spec 2026-09-30-narrate-out-of-band-design
 * § Settings › Experimental). It asks for visible prose and nothing else, so
 * the why of a change is in the record the narrate query reads.
 */
export const NARRATE_COMMENTARY_PROMPT =
  'Before you change a file, say in a sentence or two what you are changing and why. ' +
  'If you considered another way and rejected it, name it and say why in the same place.';

/**
 * How many `Bash`/`Monitor` calls a session remembers for the background
 * task tracker. The tracker reads a call when the `task_started` it causes
 * arrives, right behind it on the stream, so only the newest few ever
 * matter; the cap keeps a long session's foreground commands from piling up.
 */
const MAX_LAUNCHING_CALLS = 200;

/**
 * The CLI's answer to a background `Bash`: `Command running in background
 * with ID: <id>. Output is being written to: <path>.output. …`. The path is
 * taken from here and from `task_notification.output_file`, never built
 * (spec 2026-09-28-background-tasks-design § 4).
 */
const OUTPUT_PATH_IN_RESULT = /Output is being written to: (\/.*?\.output)(?=[.\s]|$)/;

/** The text of a `tool_result` block's content, string or text-block array alike. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
    .join('\n');
}

/**
 * The subset of the SDK's `Query` object Orbital uses. `supportedModels`,
 * `supportedCommands`, `setModel`, `setPermissionMode` and `getContextUsage`
 * are optional because a fake in a test may implement only what that test
 * exercises — and because a CLI too old to answer a control request must
 * degrade to "unknown", never to a crash.
 */
export type QueryFn = (args: {
  prompt: AsyncIterable<unknown>;
  options: Record<string, unknown>;
}) => AsyncGenerator<any> & {
  interrupt?: () => Promise<void>;
  setModel?: (model?: string) => Promise<void>;
  setPermissionMode?: (mode: PermissionMode) => Promise<void>;
  supportedModels?: () => Promise<unknown[]>;
  supportedCommands?: () => Promise<unknown[]>;
  getContextUsage?: (opts?: { detail?: 'summary' | 'full' }) => Promise<unknown>;
};

/**
 * One row of the session's slash-command list, as the composer's popup needs
 * it — the SDK's `SlashCommand` with the empties dropped, so a command with no
 * argument hint carries no field rather than an empty string the UI would then
 * have to test for. `source` is not here: it is the *route* that attributes
 * one, by matching these names against the filesystem catalog.
 */
export interface SessionCommand {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
}

/**
 * Keeps what the popup can use and drops what it cannot. Anything without a
 * name is not a command anyone could type, and the CLI's own `argumentHint`
 * is frequently `''` — an absent field says "none" more honestly.
 */
function shapeCommands(raw: unknown[]): SessionCommand[] {
  const out: SessionCommand[] = [];
  for (const entry of raw) {
    const c = entry as { name?: unknown; description?: unknown; argumentHint?: unknown; aliases?: unknown };
    if (typeof c?.name !== 'string' || !c.name) continue;
    const aliases = Array.isArray(c.aliases) ? c.aliases.filter((a): a is string => typeof a === 'string') : [];
    out.push({
      name: c.name,
      description: typeof c.description === 'string' ? c.description : '',
      ...(typeof c.argumentHint === 'string' && c.argumentHint ? { argumentHint: c.argumentHint } : {}),
      ...(aliases.length ? { aliases } : {}),
    });
  }
  return out;
}

/**
 * How many tokens of the context window ONE API call's `usage` accounts for,
 * or `null` when it carries no usage worth reading.
 *
 * All four fields, cache reads included — a cached-in token sits in the
 * window like any other — which for a single call is exactly the prompt it
 * carried plus what it wrote back, and so the size of the conversation at
 * the moment it ran.
 *
 * ONE call. This must never be handed the `usage` off a `result` message:
 * that field is the turn's total across every request the turn made, so a
 * turn with N tool round-trips counts the whole conversation N times over.
 * That is how a 222k session came to read 1513.6k — see
 * `docs/fixes/context-arc-summed-the-whole-turn.md`.
 *
 * `null` rather than `0` when nothing numeric is there: a message that says
 * nothing about usage is an unmeasured call, not a session whose context is
 * empty, and only the first of those may be allowed to erase a real reading.
 */
export function contextUsedFromAssistantUsage(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const keys = [
    'input_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'output_tokens',
  ] as const;
  let total = 0;
  let sawOne = false;
  for (const key of keys) {
    const value = u[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    sawOne = true;
    total += value;
  }
  return sawOne ? total : null;
}

/**
 * What the CLI itself says is in the window right now, from its answer to the
 * `get_context_usage` control request, or `null` when it did not answer with
 * a usable total.
 *
 * The best available reading, and the only one that is a *measurement* rather
 * than an inference: `totalTokens` counts what is queued for the next
 * request — the system prompt, tool schemas, memory files and messages —
 * which is the question the arc asks. Everything else here reconstructs that
 * from what the last request happened to be billed.
 *
 * The field is `totalTokens` on the flat `SDKControlGetContextUsageResponse`
 * the method returns — NOT the snake_case `context_usage.total_tokens` that
 * a `/context` slash-command result carries beside its text. Two shapes for
 * the same measurement; this is the one on this call's answer.
 *
 * Read as the SDK reports it, unclamped: a session past its window reads as
 * past it, and only the bar clamps (adr: `context-usage-has-one-source`).
 */
export function contextUsedFromContextUsage(response: unknown): number | null {
  if (!response || typeof response !== 'object') return null;
  const total = (response as { totalTokens?: unknown }).totalTokens;
  return typeof total === 'number' && Number.isFinite(total) ? total : null;
}

/**
 * The tokens a compaction left behind, as the SDK's
 * `SDKCompactBoundaryMessage` reports them, or `null` when it does not say.
 * `post_tokens` is optional in the SDK type, and a compaction whose size is
 * unknown must clear the stored reading rather than leave the pre-compaction
 * one standing — the arc would otherwise stay full after a `/compact`.
 */
export function contextUsedFromCompactBoundary(msg: unknown): number | null {
  const meta = (msg as { compact_metadata?: unknown } | null)?.compact_metadata;
  if (!meta || typeof meta !== 'object') return null;
  const post = (meta as { post_tokens?: unknown }).post_tokens;
  return typeof post === 'number' && Number.isFinite(post) ? post : null;
}

/**
 * What the session was started with, kept so a failure can say what it was
 * trying to run. The sessions row carries the same three, but not always in
 * time: `POST /api/sessions` inserts it only *after* `start()` returns, and a
 * spawn that fails is precisely the case where the two race. The Runner knows
 * them before the CLI is asked for anything, so it is the one place they are
 * always available.
 */
export interface SessionAttempt {
  cwd: string;
  permissionMode: PermissionMode;
  model: string | null;
}

/**
 * A compaction running right now, as the session snapshot carries it (spec
 * 2026-09-28-context-compaction-design § Live state).
 */
export interface CompactingState {
  startedAt: number;
  trigger: 'manual' | 'auto';
}

/**
 * The newest compaction this process saw succeed, for the map's short-lived
 * `compacted · 186k → 22k` caption. In memory only: after a restart there is
 * nothing to animate.
 */
export interface LastCompacted {
  at: number;
  preTokens: number | null;
  postTokens: number | null;
}

/** What a compaction's edges tell whoever stores and republishes the session. */
export type CompactionEvent =
  | { type: 'started' }
  | { type: 'succeeded' }
  | { type: 'failed'; failure: CompactionFailureRecord };

/** The outcomes the dev simulation can play. */
export type SimulatedCompactionOutcome = 'success' | 'success_no_post_tokens' | 'failed' | 'failed_no_error';

/** The simulation's stand-ins for what a real compaction would report. */
const SIMULATED_PRE_TOKENS = 150_000;
const SIMULATED_COMPACT_ERROR = 'Simulated: API Error 529 · Overloaded';
const SIMULATED_SUMMARY =
  'Simulated compaction summary.\n\nGoal: exercise the compaction UI.\nNext: carry on from here.';

/**
 * Whether a compaction was the user's `/compact`: the turn it runs in was
 * started by that command, with or without arguments. Everything else —
 * including a compaction in a turn the CLI started by itself — is `auto`.
 */
export function compactTriggerOf(turnPrompt: string | null): 'manual' | 'auto' {
  return turnPrompt !== null && /^\/compact(\s|$)/.test(turnPrompt.trim()) ? 'manual' : 'auto';
}

/**
 * The synthetic user frame carrying a compaction's summary. The SDK stream
 * marks it `isSynthetic` (the transcript's `isCompactSummary` does not
 * cross), and its body is a plain string — which the harness's other
 * synthetic frames, block arrays, are not.
 */
function isCompactSummaryFrame(msg: any): boolean {
  if (msg?.type !== 'user' || msg.parent_tool_use_id != null) return false;
  if (msg.isCompactSummary === true) return true;
  return msg.isSynthetic === true && typeof msg.message?.content === 'string';
}

/** The tool whose call becomes a question card rather than a permission prompt. */
const QUESTION_TOOL = 'AskUserQuestion';

/** What a subagent that asked the human a question is told instead of an answer. */
const SUBAGENT_QUESTION_REFUSAL =
  'Orbital cannot relay a question asked from inside a subagent; ask the parent session instead.';

/**
 * The tool that asks to leave plan mode. It is a permission request as far as
 * the SDK is concerned, but approving it does something no other approval
 * does — it changes the session's permission mode — so it gets its own kind.
 */
const PLAN_TOOL = 'ExitPlanMode';

/**
 * What kind of surface a parked decision needs. The `kind` on the envelope the
 * spec left as an extension point, now with all three of its values
 * (spec 2026-09-23-permission-and-plan-decisions-design).
 */
export type DecisionKind = 'question' | 'permission' | 'plan';

/**
 * Which surface a tool's ask belongs on. Total by design: any tool that is not
 * one of the two named ones is an ordinary permission prompt, which is the
 * whole point — the CLI can ask about a tool this build has never heard of and
 * still get a surface instead of a synthetic denial.
 */
export function decisionKindFor(toolName: string): DecisionKind {
  if (toolName === QUESTION_TOOL) return 'question';
  if (toolName === PLAN_TOOL) return 'plan';
  return 'permission';
}

/**
 * A blocked tool call waiting on the browser, as it travels on the hub
 * (`decision_pending`) and in the session snapshot (`ApiSession`).
 *
 * The prompt copy (`title`, `displayName`, `description`) is the CLI bridge's
 * own, taken off the `canUseTool` options rather than reconstructed here: the
 * bridge writes the sentence the terminal shows, and two hosts writing their
 * own wording for the same ask is how they come to disagree about what a tool
 * is about to do. Every one of them is optional — an older CLI sends none.
 */
export interface PendingDecision {
  /** The SDK's `toolUseID` — what an answer has to name to be accepted. */
  id: string;
  kind: DecisionKind;
  /**
   * The tool's own input, verbatim: `AskUserQuestionInput` for `question`,
   * `{plan}` for `plan`, and whatever the tool takes for `permission`.
   */
  input: Record<string, unknown>;
  createdAt: number;
  /** The tool being asked about. Absent on `question`, where it is implied. */
  toolName?: string;
  /** The bridge's full prompt sentence ("Claude wants to read foo.txt"). */
  title?: string;
  /** The bridge's short noun phrase for the action ("Read file"). */
  displayName?: string;
  /** The bridge's subtitle, when it wrote one. */
  description?: string;
  /**
   * The ask must open on its decline option and offer no one-key approve
   * (the SDK's `defaultToNo`). Carried so the card cannot be approved by a
   * stray keystroke on the asks the CLI flagged as dangerous.
   */
  defaultToNo?: boolean;
}

/**
 * The verdict a `permission` or `plan` decision is settled with — the other
 * half of `DecisionAnswer`, the question's `answers` map being the first.
 *
 * `message` is what the model reads back when `approved` is false: the
 * composer's "no, do this instead" text, or nothing at all for a bare refusal.
 */
export interface DecisionVerdict {
  approved: boolean;
  message?: string;
}

/**
 * What `answerDecision` takes. Which arm applies is decided by the PARKED
 * decision's `kind`, never by sniffing the payload: a question's answers map
 * is `Record<string, string>` and could hold any key at all, so the shape
 * alone can never be the discriminator.
 */
export type DecisionAnswer = Record<string, string> | DecisionVerdict;

/** True for the verdict arm of `DecisionAnswer`. */
export function isDecisionVerdict(answer: DecisionAnswer): answer is DecisionVerdict {
  return typeof (answer as DecisionVerdict).approved === 'boolean';
}

/**
 * What a denied tool tells the model when the user gave no reason of their
 * own. Plain and non-committal: the model has to be able to pick another
 * route without reading a refusal as an instruction.
 */
const DENIED_MESSAGE = 'The user declined this action.';

/**
 * The mode a session continues in once its plan is approved.
 *
 * `acceptEdits` rather than a choice between it and "keep asking": Orbital's
 * `PermissionMode` has no ask-about-everything member (see `types.ts`), and
 * adding one changes the launch picker, its artboard and the lists pinned to
 * it. `acceptEdits` still routes every shell command through the permission
 * card this same change adds, so an approved plan is not a blank cheque
 * (adr: an-approved-plan-continues-in-acceptedits).
 */
export const APPROVED_PLAN_MODE: PermissionMode = 'acceptEdits';

/**
 * The question texts of a decision's input, which are the keys its `answers`
 * map is keyed by. Total: anything that is not a question with text is not
 * something an answer could be missing for.
 */
export function decisionQuestions(input: Record<string, unknown>): string[] {
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((q) => (q as { question?: unknown })?.question)
    .filter((q): q is string => typeof q === 'string' && q.length > 0);
}

/**
 * A message on a session's input stream, or `null` — the sentinel that closes
 * it. `unknown` already admits `null`, so the alias is where that is said;
 * spelling it `unknown | null` at each use says nothing the type does not
 * already allow.
 */
type InputMessage = unknown;

/**
 * How long the runner holds a row's streamed text before publishing it as
 * one `delta`. Bounds the wire and the transcript's re-renders to a few per
 * second per row whatever the token rate; the block's end and any complete
 * message flush it at once (spec: 2026-09-24-streaming-output-design § 2).
 */
export const STREAM_FLUSH_MS = 50;

/** One text or thinking block being streamed: the row the client is filling. */
interface StreamRow {
  id: string;
  role: 'assistant' | 'thinking';
  /** Everything received for the block so far. */
  text: string;
}

/**
 * The assistant message one loop is streaming right now — what its
 * `SDKPartialAssistantMessage` frames are folded into. The main loop has one
 * and every running subagent has its own, because agents run side by side and
 * their block indexes collide. Opened at `message_start`, rows are claimed by
 * the complete blocks that follow the stream (`idFor` in `pump()`), and
 * whatever is left is dropped at the next `message_start` of the same loop
 * (spec: 2026-09-24-streaming-output-design § 3).
 */
interface StreamState {
  /** The API message id, `event.message.id` at `message_start`. */
  messageId: string;
  model?: string;
  /** Rows by content block index; a row leaves when a complete block claims it. */
  rows: Map<number, StreamRow>;
  /** Text received since the row's last publish, and where it starts. */
  pending: Map<number, { offset: number; text: string }>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** `message_stop` has been seen: no row will be added any more. */
  stopped: boolean;
}

interface ManagedSession {
  status: SessionStatus;
  queue: Array<(msg: InputMessage) => void>;
  pending: Array<InputMessage>;
  /** The main loop's message being streamed, or `null` between streams. */
  stream: StreamState | null;
  /**
   * Each subagent's message being streamed, by the `parent_tool_use_id` its
   * frames carry. An entry leaves once its message is stopped and every row
   * has been claimed, so a finished agent does not hold one for the session's
   * lifetime.
   */
  agentStreams: Map<string, StreamState>;
  /**
   * The decision this session's CLI is blocked on, with the resolver of the
   * `canUseTool` promise that block *is*. One at a time: the model cannot ask
   * a second question while it waits on the first.
   */
  decision: {
    pending: PendingDecision;
    /** Settles the SDK's promise and drops the abort listener with it. */
    settle: (result: PermissionResult) => void;
    /**
     * Abandons the editor's review of this decision, when one was opened —
     * which also drops the diff tab. Fired by `settleDecision`, so a verdict
     * reaching the decision by ANY route leaves no tab behind and no second
     * answer on its way (spec § Talking back to the editor).
     */
    review: AbortController | null;
  } | null;
  /**
   * The live query handle — the object `queryFn` returned. It is both the
   * message stream `pump()` drains and the control channel `interrupt`,
   * `setModel` and `supportedCommands` travel on, which is why it is kept per
   * session rather than consumed and forgotten.
   */
  generator:
    | (AsyncGenerator<any> & {
        interrupt?: () => Promise<void>;
        setModel?: (model?: string) => Promise<void>;
        setPermissionMode?: (mode: PermissionMode) => Promise<void>;
        supportedCommands?: () => Promise<unknown[]>;
        getContextUsage?: (opts?: { detail?: 'summary' | 'full' }) => Promise<unknown>;
        stopTask?: (taskId: string) => Promise<void>;
      })
    | null;
  /**
   * The session's `Bash` and `Monitor` calls by `tool_use` id, with the
   * output path their `tool_result` named once it arrived — what the
   * background task tracker reads to tell a monitor from a shell and to show
   * the command (spec 2026-09-28-background-tasks-design § 2). Oldest first,
   * capped at `MAX_LAUNCHING_CALLS`; dies with the session.
   */
  launchingCalls: Map<string, LaunchingCall>;
  /**
   * The window reading from the most recent main-loop API call of the turn in
   * flight — the fallback the turn's end uses when the CLI cannot answer
   * `get_context_usage`.
   *
   * The LATEST reading, never a running total: a streaming response arrives
   * as several assistant messages sharing one `message.id`, each carrying a
   * later `usage` for the SAME request, and consecutive requests each re-read
   * the whole conversation from cache. Adding any of that up is the bug this
   * field exists to avoid. Cleared when a turn ends or a compaction lands, so
   * a turn that measures nothing reports nothing rather than re-reporting the
   * turn before it.
   */
  lastCall: number | null;
  /**
   * Whether the CLI's main loop has finished the turn it was last seen
   * running — the `result` edge, kept rather than acted on directly because
   * a finished turn is only *half* of "this session wants you". The other
   * half is whether anything it launched is still running; `settleStatus()`
   * is what puts the two together.
   */
  turnEnded: boolean;
  sleepTimer: ReturnType<typeof setTimeout> | null;
  attempt: SessionAttempt;
  /** The session's command list once asked for (or pushed), `null` until then.
   * It lives on the session, so it dies with it — see `release()`. */
  commands: SessionCommand[] | null;
  /**
   * The compaction running now, with the context reading it started from —
   * what a failure's mark reports as "unchanged". Cleared by its end, by the
   * turn ending, and with the session.
   */
  compacting: (CompactingState & { preTokens: number | null }) | null;
  /** The last successful compaction's measured duration, for its boundary. */
  measuredCompactionMs: number | null;
  /** A compaction mark waiting for the summary frame that follows it. */
  heldCompaction: ChatMessage | null;
  /** The last compaction that succeeded in this process — the map's caption. */
  lastCompacted: LastCompacted | null;
  /**
   * The text of the user message that started the turn in flight, or `null`
   * between turns — what tells a `/compact` apart from an automatic one.
   */
  turnPrompt: string | null;
  /** A truncating resume still waiting for `init` or a refusal; null otherwise. */
  rewind: RewindHooks | null;
  /** The CLI refused this session's rewind: the error its iterator throws next is not a failure. */
  rewindRefused: boolean;
  /**
   * The main loop's `tool_use` ids still waiting for a result. An interrupt
   * that leaves one behind leaves it on the client's screen, while the live
   * branch drops it once a later prompt is on the chain.
   */
  openToolUses: Set<string>;
  /**
   * Where that dangling call stands: `left` by an interrupt, `resetAtTurnEnd`
   * once the next prompt has gone out — its turn's end is when the file has
   * the prompt that takes the call off the branch, and the client is told to
   * read the transcript again.
   */
  danglingCall: 'none' | 'left' | 'resetAtTurnEnd';
}

/**
 * Converts one SDK message into zero or more ChatMessages.
 * `nextSeq` must return a monotonically increasing number per call — callers
 * (Runner) bind it to a per-instance counter so ids can't collide when two
 * messages land in the same millisecond with the same block index.
 *
 * `idFor` lets the caller hand a `text` or `thinking` block an id it already
 * published under — the row its stream filled — so the complete block
 * replaces the streamed one in the client instead of landing beside it
 * (adr: streamed-text-rides-as-offset-deltas-on-the-rows-id). Answering
 * `undefined` mints a fresh id as before.
 */
export function sdkToChatMessages(
  sdkMsg: any,
  nextSeq: () => number,
  images?: ImageWriter,
  idFor?: (block: { type: 'text' | 'thinking'; text: string }) => string | undefined,
): ChatMessage[] {
  // `isSynthetic` is how the SDK stream carries the transcript's `isMeta`:
  // the CLI stamps it on a user frame that is `isMeta`,
  // `isVisibleInTranscriptOnly` or `isCompactSummary` — the harness speaking,
  // not the human. Dropped here for the same reason `entriesToMessages`
  // drops `isMeta` entries, so a Read of an image does not leave an
  // `[Image: original …]` bubble on either path. The compact summary is a
  // string body, which this function never rendered anyway.
  if (sdkMsg.type === 'user' && sdkMsg.isSynthetic === true) return [];
  const content = sdkMsg.message?.content;
  if (!Array.isArray(content)) return [];
  const model = typeof sdkMsg.message?.model === 'string' ? sdkMsg.message.model : undefined;
  // Stamped once per frame, not per block: every message this call emits
  // was published in the same instant. The SDK frame's own timestamp wins
  // when it has one; otherwise this is the only record of when it landed,
  // so a tool row's duration (a later task) has something to subtract.
  const timestamp = typeof sdkMsg.timestamp === 'string' ? sdkMsg.timestamp : new Date().toISOString();
  // The frame's own uuid is the transcript entry's (verified, spec
  // 2026-09-29-rewind-design § Ids), so a live row names the same entry its
  // reloaded twin does.
  const uuid = typeof sdkMsg.uuid === 'string' ? { uuid: sdkMsg.uuid as string } : {};
  const out: ChatMessage[] = [];
  content.forEach((block: any, i: number) => {
    const id = `${sdkMsg.session_id}:${nextSeq()}:${i}`;
    if (block.type === 'text' && block.text?.trim()) {
      if (sdkMsg.type === 'user') {
        // Same split as the indexed path (`entriesToMessages`) — a live
        // command expansion must fold identically to a reloaded one.
        const split = splitUserText(block.text);
        out.push({ id, role: 'user', text: split.text, ...(split.command ? { command: split.command } : {}), timestamp, ...uuid });
      } else {
        const streamed = idFor?.({ type: 'text', text: block.text });
        out.push({ id: streamed ?? id, role: 'assistant', text: block.text, model, timestamp, ...uuid });
      }
    } else if (block.type === 'thinking') {
      // The SDK carries the reasoning text in `thinking`, not `text` — the
      // field text blocks use. A thinking block with only a signature and
      // no text (real transcripts have these) is not a message, same as
      // the text branch above skips empty text.
      //
      // `typeof` first, matching the indexed path (`entriesToMessages` in
      // `transcript/parser.ts`): `block` is `any` off the stream, and a
      // non-string `thinking` would throw on `.trim()` inside `pump()`'s
      // `for await`, where the catch logs a warning and then calls
      // `release()` — one malformed frame would stop the whole session.
      if (typeof block.thinking === 'string' && block.thinking.trim()) {
        const streamed = idFor?.({ type: 'thinking', text: block.thinking });
        out.push({ id: streamed ?? id, role: 'thinking', text: block.thinking, model, timestamp, ...uuid });
      }
    } else if (block.type === 'tool_use') {
      out.push({ id, role: 'tool_use', toolName: block.name, toolInput: block.input, toolUseId: block.id, timestamp, ...uuid });
    } else if (block.type === 'tool_result') {
      const parts = toolResultParts(block.content ?? '', images);
      out.push({
        id, role: 'tool_result', toolUseId: block.tool_use_id,
        text: parts.text,
        ...(parts.images.length ? { images: parts.images } : {}),
        ...(block.is_error === true ? { isError: true } : {}),
        timestamp,
        ...uuid,
      });
    } else if (block.type === 'image') {
      const entry = imageRefOf(block, images);
      if (entry) out.push({ id, role: sdkMsg.type === 'user' ? 'user' : 'assistant', images: [entry], timestamp, ...uuid });
    }
  });
  return out;
}

export class Runner {
  private sessions = new Map<string, ManagedSession>();
  /** Every id this Runner has started, live or stopped — see `hasRun`. */
  private ran = new Set<string>();
  /**
   * Each session's pump, by id, until its generator has finished — which is
   * after `release()` when the session was stopped. What `stopAndWait` awaits:
   * a stopped session's CLI can still be writing its transcript.
   */
  private exits = new Map<string, Promise<void>>();
  private seq = 0;
  private hub: Hub;
  private queryFn: QueryFn;
  private newSessionId: () => string;
  private sleepAfterMs: number;
  private onStatus?: (sessionId: string, status: SessionStatus) => void;
  private onOwnership?: (sessionId: string, status: SessionStatus | null) => void;
  private onTurnUsage?: (modelUsage: unknown) => void;
  private onContextUsed?: (sessionId: string, usedTokens: number | null) => void;
  private onInit?: (sessionId: string, model: string | null) => void;
  private onEntries?: (sessionId: string, entries: TranscriptEntry[]) => void;
  private onTaskEvent?: (sessionId: string, msg: TaskEvent) => void;
  private hasLiveBackgroundWork?: (sessionId: string) => boolean;
  private onTaskOutputPath?: (sessionId: string, toolUseId: string, path: string) => void;
  private onTurnBoundary?: (sessionId: string, ended: boolean) => void;
  private onDecision?: (sessionId: string) => void;
  private onPermissionMode?: (sessionId: string, mode: PermissionMode) => void;
  private onError?: (sessionId: string, err: unknown, attempt?: SessionAttempt) => void;
  private onCompaction?: (sessionId: string, event: CompactionEvent) => void;
  private readContextUsed?: (sessionId: string) => number | null;
  private images?: ImageStore;
  private subagentTranscripts?: SubagentTranscripts;
  private claudeExecutablePath?: string | null;
  private ide?: IdeApprovals;
  private commentary?: () => boolean;

  constructor(deps: {
    hub: Hub;
    queryFn?: QueryFn;
    /** Absolute path to the claude CLI to spawn, or null/undefined for the SDK's bundled default. */
    claudeExecutablePath?: string | null;
    /**
     * Mints the id a fresh session runs under, handed to the CLI as
     * `options.sessionId`. Injectable so tests can pin a readable id; the
     * default is a v4 UUID, which is the only shape the CLI accepts.
     */
    newSessionId?: () => string;
    /** The sleep delay, for tests; `SLEEP_AFTER_IDLE_MINUTES` otherwise. */
    sleepAfterMs?: number;
    /** Content-addressed store live image blocks are decoded into; absent
     * (some tests) they drop, which was always the live path's behaviour. */
    images?: ImageStore;
    /**
     * Where `pump()` files each subagent's own frames — keyed by the `Agent`
     * `tool_use` id its `parent_tool_use_id` carries — instead of the ones
     * it still sends to `onEntries`/`session:<id>` for the parent's own.
     * Absent (most tests), a subagent's messages are converted and published
     * to `subagent:<id>:<toolUseId>` same as ever; there is simply nothing
     * buffering them for a panel opened later, which is the live behaviour
     * before this Runner ever had a caller that cared.
     */
    subagentTranscripts?: SubagentTranscripts;
    onStatus?: (sessionId: string, status: SessionStatus) => void;
    /**
     * Which sessions this Runner owns, and in what state — `null` when it
     * lets one go. Whoever persists it can tell, at the next boot, a session
     * whose process stopped from one whose process was killed: a stop
     * reports `null`, and a kill reports nothing at all, leaving the last
     * live status standing (spec `2026-09-21-session-autoheal-design`).
     *
     * The `null` is also the only word the Runner says about a stop. It
     * publishes no status for it, because it cannot know the answer: a
     * stopped session is `ended` only if the user ended it, which lives on
     * the row (spec 2026-09-24-sessions-end-only-by-hand-design § 1). So the
     * listener announces what the session reads now.
     *
     * Not a second `onStatus`. That one is guarded on change, and a fresh
     * session's state is constructed already at `working`, so it never fires
     * for the initial transition — the window a save-triggered restart lands
     * in most often.
     */
    onOwnership?: (sessionId: string, status: SessionStatus | null) => void;
    /** Receives each turn result's `modelUsage`, which is where context-window sizes come from. */
    onTurnUsage?: (modelUsage: unknown) => void;
    /**
     * How full this session's context is after a turn, or after a compaction
     * reset it — the arc's numerator (spec `context-fill-arc`). Separate from
     * `onTurnUsage`, which is about models rather than sessions and is handed
     * no session id at all.
     *
     * `null` only ever arrives from a `compact_boundary` that did not say how
     * much survived: a turn whose `result` carries no usage is left silent
     * rather than reported as null, so an unreadable message cannot erase a
     * good reading.
     */
    onContextUsed?: (sessionId: string, usedTokens: number | null) => void;
    /** Receives the resolved model a session actually started on (`system/init`). */
    onInit?: (sessionId: string, model: string | null) => void;
    /**
     * Every assistant/user message the SDK streams, in transcript-entry shape.
     * What the session said, for readers that care about its contents — the
     * auto-titler. Subagent liveness does *not* come from here; see
     * `onTaskEvent`.
     */
    onEntries?: (sessionId: string, entries: TranscriptEntry[]) => void;
    /**
     * The task lifecycle the SDK streams as `system` messages
     * (`TASK_EVENT_SUBTYPES`): where a subagent's live state comes from.
     * The tool blocks cannot answer it, because `Agent` runs in the background
     * and its `tool_result` comes back at launch
     * (adr: subagent-liveness-from-sdk-task-events).
     */
    onTaskEvent?: (sessionId: string, msg: TaskEvent) => void;
    /**
     * Whether anything this session launched is still running — a subagent
     * or a background task — read straight back out of the stores
     * `onTaskEvent` feeds, so the two can never disagree about the same
     * moment.
     *
     * The Runner asks because a finished turn is not the same thing as a
     * session that wants you: `Agent` runs in the background, so the CLI ends
     * its turn (and emits `result`) with subagents still working, and wakes
     * itself up when they report back. A background shell counts too,
     * deliberately: a dev server left running keeps the session `working`
     * for as long as it runs (spec 2026-09-28-background-tasks-design § 2
     * "Working while a task runs"). Unwired, every session behaves as it
     * always did — `result` means `needs_input`.
     */
    hasLiveBackgroundWork?: (sessionId: string) => boolean;
    /**
     * The output path a background `Bash` or `Monitor` call's `tool_result`
     * named. The result usually lands after the `task_started` it belongs
     * to, so the tracker, which read the call at the start, learns the path
     * here.
     */
    onTaskOutputPath?: (sessionId: string, toolUseId: string, path: string) => void;
    /**
     * Each edge of the CLI's main loop: `ended` true when a turn's `result`
     * lands (or the user interrupts), false when a frame shows a turn has
     * begun — including the turns the CLI starts by ITSELF, which no `send()`
     * of ours ever announces.
     *
     * Separate from `onStatus` because the two stopped meaning the same
     * thing: a turn that ends with subagents still running leaves the session
     * `working`, so "a turn just ended" no longer has a status transition to
     * hang off. Both the auto-titler and `awaitingSubagents` need the edge
     * itself.
     */
    onTurnBoundary?: (sessionId: string, ended: boolean) => void;
    /**
     * A question was parked on this session, or the parked one was settled.
     *
     * The `decision_pending` / `decision_resolved` events go to
     * `session:<id>`, which only a client that has this session SELECTED is
     * listening to — and whether a session is blocked on a question or merely
     * finished a turn is the difference between NEEDS INPUT and DONE on the
     * map, where nothing is selected. So the snapshot has to be republished on
     * both edges; the status alone cannot carry it, both being `needs_input`.
     */
    onDecision?: (sessionId: string) => void;
    /**
     * The session's permission mode changed mid-run — which today happens on
     * exactly one edge, an approved plan leaving plan mode
     * (spec 2026-09-23-permission-and-plan-decisions-design). Whoever stores
     * the sessions row writes it, so the panel's readout and the next
     * revive both see the mode the CLI is actually in rather than the one
     * the session was launched with.
     */
    onPermissionMode?: (sessionId: string, mode: PermissionMode) => void;
    /**
     * Whatever the SDK generator threw, with the session it was running.
     * Called from `pump()`'s catch, where the only record of a session dying
     * on its own used to be a line on the server's terminal that nobody was
     * reading — see
     * `docs/superpowers/specs/2026-09-17-error-surface-design.md`.
     *
     * Reporting only; the process is still released the same way it always
     * was. `release()` runs regardless of whether this is wired, and there
     * is no `failed` status for it to reach.
     *
     * `attempt` is what the session was started with, so a failure can name
     * the directory it could not run in without waiting for the sessions row
     * to exist. Absent only if the session is already gone from the map.
     */
    onError?: (sessionId: string, err: unknown, attempt?: SessionAttempt) => void;
    /**
     * The editor, as a second route to a parked permission's verdict
     * (spec 2026-09-23-ide-bridge-design § Talking back to the editor).
     *
     * Optional in every sense. Absent — no editor running, an extension
     * without `openDiff`, a test that does not care — every decision is
     * answered from the browser exactly as it was before this existed, and
     * that stays true even when it IS wired: the browser card is never
     * disabled, never waits on the editor, and never learns that a diff is
     * open (adr `the-editor-is-a-second-route-to-one-verdict`).
     */
    ide?: IdeApprovals;
    /**
     * A compaction's edges: started, succeeded, failed (spec
     * 2026-09-28-context-compaction-design). Whoever stores the session
     * republishes on each, persists a failure and logs it.
     */
    onCompaction?: (sessionId: string, event: CompactionEvent) => void;
    /** The session's stored context reading — a failed compaction's "before". */
    readContextUsed?: (sessionId: string) => number | null;
    /**
     * The `narrate_commentary` setting, read at every start — spawn and
     * revive alike — so it holds for a query from the moment it starts and
     * a change counts from the next one. Unwired, off.
     */
    commentary?: () => boolean;
  }) {
    this.hub = deps.hub;
    this.queryFn = deps.queryFn ?? (query as unknown as QueryFn);
    this.newSessionId = deps.newSessionId ?? randomUUID;
    this.sleepAfterMs = deps.sleepAfterMs ?? SLEEP_AFTER_IDLE_MINUTES * 60_000;
    this.onStatus = deps.onStatus;
    this.onOwnership = deps.onOwnership;
    this.onTurnUsage = deps.onTurnUsage;
    this.onContextUsed = deps.onContextUsed;
    this.onInit = deps.onInit;
    this.onEntries = deps.onEntries;
    this.onTaskEvent = deps.onTaskEvent;
    this.hasLiveBackgroundWork = deps.hasLiveBackgroundWork;
    this.onTaskOutputPath = deps.onTaskOutputPath;
    this.onTurnBoundary = deps.onTurnBoundary;
    this.onDecision = deps.onDecision;
    this.onPermissionMode = deps.onPermissionMode;
    this.onError = deps.onError;
    this.images = deps.images;
    this.subagentTranscripts = deps.subagentTranscripts;
    this.claudeExecutablePath = deps.claudeExecutablePath;
    this.ide = deps.ide;
    this.onCompaction = deps.onCompaction;
    this.readContextUsed = deps.readContextUsed;
    this.commentary = deps.commentary;
  }

  /**
   * Clears every armed sleep timer (server shutdown). The timers are already
   * `unref()`d so they never hold the process open, but one firing after
   * close would call `stop()` on a Runner whose Hub and db are gone.
   */
  dispose(): void {
    for (const s of this.sessions.values()) {
      if (s.sleepTimer) clearTimeout(s.sleepTimer);
      s.sleepTimer = null;
    }
  }

  private setStatus(sessionId: string, status: SessionStatus): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.status === status) return;
    s.status = status;
    this.hub.publish(`session:${sessionId}`, { event: 'status', status });
    this.onStatus?.(sessionId, status);
    this.onOwnership?.(sessionId, status);
  }

  /**
   * Re-derives a running session's status from what the CLI is actually
   * doing, and moves the sleep timer with it.
   *
   * `needs_input` is orbital's word for "this one wants YOU", so it may only
   * stand when nothing is going to move on its own. Two things can be moving:
   * the main loop's turn (between its first frame and its `result`), and the
   * subagents it launched — `Agent` is backgrounded by default, so the CLI
   * ends the turn that launched one and then wakes ITSELF up when the agent
   * reports back (fix `background-agents-retire-their-moon-at-launch`). Both
   * read `working`; a map that said NEEDS INPUT through either was asking for
   * an answer nobody owed it.
   *
   * A parked decision is the exception that owns the status outright: the
   * turn has not ended and agents may well be running, but the CLI is
   * genuinely blocked on the human until `settleDecision` frees it — and
   * `decide()` deliberately arms no deadline for it.
   *
   * Every caller funnels through here rather than calling `setStatus`
   * directly, so the sleep timer can never be left armed under a `working`
   * session or disarmed under a parked one.
   */
  private settleStatus(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.decision) return;
    const busy = !s.turnEnded || this.hasLiveBackgroundWork?.(sessionId) === true;
    const want: SessionStatus = busy ? 'working' : 'needs_input';
    if (s.status === want) return;
    this.setStatus(sessionId, want);
    if (busy) {
      // Null the handle, not just clear it — same reasoning as `send()`.
      if (s.sleepTimer) clearTimeout(s.sleepTimer);
      s.sleepTimer = null;
    } else {
      this.armSleepTimer(sessionId);
    }
  }

  /**
   * One SDK user message, or `null` when there is nothing to say.
   *
   * Images first, then the text — the order the model reads them in, and the
   * order the composer shows them in (chips above the field). Base64 exists on
   * exactly this hop: everything Orbital stores or puts on its own wire is a
   * ref, and only the message handed to the CLI carries bytes.
   *
   * A ref the store no longer holds is skipped without a word. The alternative
   * is failing a turn over a thumbnail the cache pruned, which is a worse
   * answer than sending the rest of what was typed.
   */
  private userMessage(sessionId: string, text: string, attachments?: string[], uuid?: string): InputMessage {
    const content: unknown[] = [];
    for (const ref of attachments ?? []) {
      const image = this.images?.read(ref);
      if (!image) continue;
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
      });
    }
    if (text) content.push({ type: 'text', text });
    // "An empty prompt enqueues nothing" now reads "empty prompt *and* nothing
    // attached": a turn of only images is a real turn, a turn of neither is not.
    if (content.length === 0) return null;
    return {
      type: 'user',
      session_id: sessionId,
      parent_tool_use_id: null,
      message: { role: 'user', content },
      // The CLI writes the entry under this uuid, so the turn can be named as
      // a rewind target before the file is read again (spec
      // 2026-09-29-rewind-design § Ids).
      ...(uuid ? { uuid } : {}),
    };
  }

  /**
   * Puts a session that is waiting on the user to sleep after
   * `SLEEP_AFTER_IDLE_MINUTES`: its process stops, and nothing else about it
   * changes (spec 2026-09-24-sessions-end-only-by-hand-design § 2).
   */
  private armSleepTimer(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.sleepTimer) clearTimeout(s.sleepTimer);
    const timer = setTimeout(() => void this.stop(sessionId), this.sleepAfterMs);
    // Don't let the sleep timer keep the process alive (e.g. during tests).
    (timer as unknown as { unref?: () => void }).unref?.();
    s.sleepTimer = timer;
  }

  /**
   * Lets go of a session whose process has stopped, whichever way it
   * stopped: `stop()` (the user's End or Clear, or the sleep timer), or a
   * generator that completed or threw on its own.
   *
   * Stopping is not ending. From here on `status()` does not answer for the
   * session at all, the way it does not for one this Runner never ran, so
   * `statusOf` falls through to the row: `ended` if a route stamped
   * `ended_at`, `idle` otherwise (spec
   * 2026-09-24-sessions-end-only-by-hand-design § 1). No status is published
   * here — `onOwnership`'s `null` is the whole announcement.
   *
   * `state` is the session this call is about. A revive can start a new
   * session under the same id before the old generator has finished
   * draining, and that generator's completion must not release the new one.
   */
  private release(sessionId: string, state: ManagedSession): void {
    if (this.sessions.get(sessionId) !== state) return;
    // The backstop for the paths that do not go through stop(): a generator
    // that completed or threw while a decision was parked. No promise may
    // outlive its session.
    this.settleDecision(sessionId, { behavior: 'deny', message: 'The session ended.' });
    if (state.sleepTimer) clearTimeout(state.sleepTimer);
    state.sleepTimer = null;
    // A mark still waiting for its summary goes out as it is, while the
    // session is still this one's; the compaction itself dies with it.
    this.publishHeldCompaction(sessionId, state);
    state.compacting = null;
    // A flush after the release would publish for a session nobody holds.
    if (state.stream?.flushTimer) clearTimeout(state.stream.flushTimer);
    state.stream = null;
    for (const stream of state.agentStreams.values()) {
      if (stream.flushTimer) clearTimeout(stream.flushTimer);
    }
    state.agentStreams.clear();
    // Gone before the release is announced, so whoever hears it and asks
    // `status()` already finds nobody holding the session.
    this.sessions.delete(sessionId);
    this.onOwnership?.(sessionId, null);
  }

  /**
   * Starts (or resumes) a session and returns its id.
   *
   * Resolves without waiting to hear anything from the CLI, because there is
   * nothing to wait for: in stream-json input mode the CLI sits silent on
   * stdin and emits `system/init` only *after* it has been sent a user
   * message. The previous order — withhold the first prompt until `init`
   * arrives — was a deadlock in which the launch request hung forever, the
   * session row was never written, and the only trace was the spawned CLI
   * registering itself in `~/.claude/sessions` (the "record appears, nothing
   * happens" report). Instead Orbital *pins* the id via `options.sessionId`
   * and hands it to the CLI, so the id is known before the process says a
   * word. See `docs/decisions/runner-pins-the-session-id.md`.
   *
   * `sessionId` lets the *caller* pin that id rather than have one minted
   * here. The browser mints it and subscribes to `session:<id>` before it
   * posts the launch, so the window in which the first turn could publish to
   * a topic nobody is listening on never opens. `resume` still wins over it:
   * a resumed session's id is already fixed by its transcript, and the two
   * are mutually exclusive in the SDK.
   */
  // The Runner's public methods are uniformly awaited by the routes, so the
  // `async` here is the published signature rather than an oversight — it
  // stays even though nothing in the body awaits today.
  // eslint-disable-next-line @typescript-eslint/require-await
  async start(opts: {
    cwd: string;
    prompt: string;
    permissionMode: PermissionMode;
    resume?: string;
    /** An id the caller has already committed to. Must be a v4 UUID — the only shape the CLI accepts. */
    sessionId?: string;
    model?: string;
    /** Image store refs to send alongside the first prompt — the New Session
     * dialog's attachments, and a revived session's. */
    attachments?: string[];
    /**
     * A truncating resume (spec 2026-09-29-rewind-design § Runner): the chain
     * entry the conversation continues from, and — only when the dropped
     * range is exactly the newest turn — the prompt uuid the CLI's guard
     * checks it against. Both go straight to the SDK options.
     */
    resumeSessionAt?: string;
    resumeDropsTurn?: string;
    /** The uuid the first prompt's entry is written under. */
    promptUuid?: string;
    /** Told whether the CLI took the truncating resume. */
    rewind?: RewindHooks;
  }): Promise<string> {
    // A resume keeps the transcript's own id; otherwise the caller's pinned
    // id if it brought one, and a freshly minted one if it did not.
    const sessionId = opts.resume ?? opts.sessionId ?? this.newSessionId();
    if (this.sessions.has(sessionId)) {
      throw new Error(`resume collision: session ${sessionId} already active`);
    }
    const state: ManagedSession = {
      status: 'working', queue: [], pending: [], stream: null, agentStreams: new Map(), generator: null, sleepTimer: null,
      launchingCalls: new Map(),
      lastCall: null, turnEnded: false,
      attempt: { cwd: opts.cwd, permissionMode: opts.permissionMode, model: opts.model ?? null },
      commands: null, decision: null,
      compacting: null, measuredCompactionMs: null, heldCompaction: null, lastCompacted: null,
      turnPrompt: opts.prompt,
      rewind: opts.rewind ?? null, rewindRefused: false,
      openToolUses: new Set(), danglingCall: 'none',
    };
    // Registered before anything is awaited, so two concurrent start() calls
    // for the same id can't both get past the check above.
    this.sessions.set(sessionId, state);
    this.ran.add(sessionId);
    // The claim, announced here rather than left to `setStatus`: the state
    // above is already `working`, so the guarded setter has no transition to
    // fire on, and a session killed before its first turn ended would look
    // to the next boot like one that was never running.
    this.onOwnership?.(sessionId, state.status);

    // Input stream: yields queued user messages; null closes it.
    const dequeue = () =>
      new Promise<InputMessage>((resolve) => {
        if (state.pending.length) resolve(state.pending.shift());
        else state.queue.push(resolve);
      });
    async function* input() {
      while (true) {
        const msg = await dequeue();
        if (msg === null) return;
        yield msg;
      }
    }
    const options: Record<string, unknown> = {
      cwd: opts.cwd,
      permissionMode: opts.permissionMode,
      systemPrompt: this.commentary?.()
        ? { type: 'preset', preset: 'claude_code', append: NARRATE_COMMENTARY_PROMPT }
        : { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      // The subagent panel's whole feed: without this only tool_use/tool_result
      // blocks cross from a subagent to the stream, and prose/thinking never
      // arrive at all. An older CLI that does not know the option ignores it
      // silently — the panel degrades to tool rows with no prose, which is
      // accepted, not an error (spec
      // `2026-09-22-subagent-transcript-panel-design.md` § 1).
      forwardSubagentText: true,
      // The streamed answer: `stream_event` frames as each block is written,
      // ahead of the complete message that still follows
      // (spec: 2026-09-24-streaming-output-design § 3).
      includePartialMessages: true,
      // Orbital stops background tasks one at a time (the task list's ■, the
      // subagent list's ■), so the composer's Stop may abort only the turn.
      // Undeclared, the CLI fails closed and an interrupt kills running
      // background agents and workflows with it (adr
      // the-composers-stop-spares-background-work).
      perTaskStopAffordance: true,
      // Without this the SDK treats every "ask" decision as terminal and
      // auto-denies it, which is what used to push `AskUserQuestion` into
      // plain prose (spec 2026-09-20-interactive-decisions-design).
      canUseTool: ((toolName, input, canUseOpts) =>
        this.decide(sessionId, toolName, input, canUseOpts)) satisfies CanUseTool,
    };
    // `sessionId` and `resume` are mutually exclusive in the SDK; resuming
    // already fixes the id, so it is only pinned for a fresh session.
    if (opts.resume) options.resume = opts.resume;
    else options.sessionId = sessionId;
    if (opts.model) options.model = opts.model;
    if (opts.resume && opts.resumeSessionAt) {
      options.resumeSessionAt = opts.resumeSessionAt;
      if (opts.resumeDropsTurn) options.resumeDropsTurn = opts.resumeDropsTurn;
    }
    // Absent, the SDK spawns its own bundled binary — which is what dev
    // wants and what the packaged app cannot have (spec § 2).
    if (this.claudeExecutablePath) options.pathToClaudeCodeExecutable = this.claudeExecutablePath;

    const generator = this.queryFn({ prompt: input(), options });
    state.generator = generator;
    const exit = this.pump(sessionId, state, generator);
    this.exits.set(sessionId, exit);
    void exit.then(() => {
      if (this.exits.get(sessionId) === exit) this.exits.delete(sessionId);
    });

    // An empty prompt with nothing attached (e.g. clear+startNew) means "start
    // the session but wait for the caller's first send()" — enqueueing an empty
    // user turn would otherwise burn a turn on nothing (I6). Nothing reaches
    // the CLI until then, so it stays parked on stdin, which is exactly
    // `needs_input`.
    const first = this.userMessage(sessionId, opts.prompt, opts.attachments, opts.promptUuid);
    if (first) {
      this.enqueue(sessionId, first);
      // The state above is constructed mid-turn, so neither the status nor
      // the stream will ever show this turn's start as an edge.
      this.onTurnBoundary?.(sessionId, false);
    } else {
      // No turn ever ran, so there is none in flight for `settleStatus` to
      // find — but it must not read the session as mid-turn either.
      state.turnEnded = true;
      this.setStatus(sessionId, 'needs_input');
    }

    return sessionId;
  }

  /** Drains one session's SDK message stream onto the hub until it ends. */
  private async pump(sessionId: string, state: ManagedSession, generator: AsyncGenerator<any>): Promise<void> {
    try {
      for await (const msg of generator) await this.handle(sessionId, state, msg);
    } catch (err) {
      // A refused rewind is not a failed session: the refusal went to whoever
      // holds the rewind, which records it (spec 2026-09-29-rewind-design §
      // Runner). The iterator throws the refusal's text after its `result`,
      // or instead of it.
      const refusal = state.rewind ? rewindRefusal(err instanceof Error ? err.message : err) : null;
      if (refusal) this.refuseRewind(state, refusal);
      if (state.rewindRefused) {
        this.release(sessionId, state);
        return;
      }
      // A process that exits non-zero after stop() let go of it — a rewind's
      // "Stop and rewind" interrupting a turn, then closing the process — is
      // the stop working, not the session failing.
      if (this.sessions.get(sessionId) !== state) return;
      // Both, deliberately: the terminal keeps saying it, and the browser
      // finally gets to. A reporter that throws must not stop `release()`
      // below from running — a session that failed twice is still a session
      // whose process is gone.
      console.warn('orbital: runner pump error:', err);
      try {
        this.onError?.(sessionId, err, state.attempt);
      } catch (reportErr) {
        console.warn('orbital: failed to record runner error:', reportErr);
      }
    }
    // Generator finished: the SDK process exited, or stop() closed the input
    // stream. Harmless after an explicit stop() — the session is already
    // released, so release() does nothing a second time.
    this.release(sessionId, state);
  }

  /**
   * One SDK message, as `pump()` hands it over. Its own method so the dev
   * compaction simulation can feed fake messages through the very same path
   * (spec 2026-09-28-context-compaction-design § Dev simulation).
   */
  private async handle(sessionId: string, state: ManagedSession, msg: any): Promise<void> {
    const topic = `session:${sessionId}`;
    // A stopped process can still be flushing frames when a revive starts
    // a new session under the same id; everything keyed by `sessionId`
    // below would land on that new session. Once `state` is no longer the
    // session this id holds, the stream is drained unread.
    if (this.sessions.get(sessionId) !== state) return;
    // A truncating resume the CLI will not do is answered before `init`, by
    // a result nothing else should read as a turn (spec
    // 2026-09-29-rewind-design § Runner). Checked ahead of the id guard: the
    // CLI has not loaded the session it refuses.
    if (state.rewind && msg?.type === 'result' && msg.subtype === 'error_during_execution') {
      const refusal = rewindRefusal(Array.isArray(msg.errors) ? msg.errors[0] : null);
      if (refusal) {
        this.refuseRewind(state, refusal);
        return;
      }
    }
    // Every CLI message names the session it belongs to. Anything wearing
    // a different id (a stray from another session) is not ours to
    // publish; messages with no id at all are stream-level noise.
    if (msg?.session_id !== sessionId) return;
    // A compaction's mark waits one message for its summary frame. That frame
    // completes it; anything else publishes it as it is, ahead of itself.
    if (state.heldCompaction) {
      if (isCompactSummaryFrame(msg)) {
        const summary = compactSummaryText(msg.message?.content);
        if (summary && state.heldCompaction.compaction) state.heldCompaction.compaction.summary = summary;
        this.publishHeldCompaction(sessionId, state);
        // Nothing else to do with it: `sdkToChatMessages` drops a synthetic
        // frame, and it is not a turn edge — the compaction ran inside one.
        return;
      }
      if (!(msg.type === 'system' && msg.subtype === 'status')) this.publishHeldCompaction(sessionId, state);
    }
    if (msg.type === 'system' && msg.subtype === 'status') {
      this.onCompactionStatus(sessionId, state, msg);
      return;
    }
    if (msg.type === 'system' && msg.subtype === 'init') {
      // The turn is running, so the CLI took the truncating resume: a refusal
      // always comes before this.
      const rewind = state.rewind;
      state.rewind = null;
      if (rewind) {
        try {
          rewind.started();
        } catch (err) {
          console.warn('orbital: failed to record a sent rewind:', err);
        }
      }
      this.onInit?.(sessionId, typeof msg.model === 'string' ? msg.model : null);
      return;
    }
    // A fire-and-forget push of the whole command list after a mid-session
    // change (a skill discovered as the agent moves into a subdirectory).
    // The SDK's instruction is to REPLACE the cached list with it, so that
    // is what this does — a re-ask would return the same thing anyway.
    // A task's life — a subagent's or a background task's — as the CLI
    // reports it; the tool blocks below cannot tell when one ends
    // (`onTaskEvent`). Every other `system` subtype falls through unread,
    // as before.
    if (msg.type === 'system' && TASK_EVENT_SUBTYPES.has(msg.subtype)) {
      this.onTaskEvent?.(sessionId, msg as TaskEvent);
      // After the forward, never before: `hasLiveBackgroundWork` reads the very
      // store the line above just fed, and this message may be the one
      // that empties it — the last background agent reporting back, or the
      // last background shell exiting, is what finally makes a turn-ended
      // session `needs_input`.
      this.settleStatus(sessionId);
      return;
    }
    // A compaction just rewrote the context, so the last `result`'s token
    // count is history — this is what makes the map's arc shrink after a
    // `/compact` instead of sitting full until the next turn ends
    // (spec `context-fill-arc`). The SDK's `post_tokens` is optional;
    // without it the reading is cleared rather than left stale.
    if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
      // The calls before the boundary measured a conversation that no
      // longer exists, so they must not outlive it as this turn's
      // fallback and overwrite `post_tokens` when the turn ends.
      state.lastCall = null;
      // The mark (spec 2026-09-28-context-compaction-design § Success). The
      // measured duration is the fallback for a boundary without
      // `duration_ms`: the status pair when it arrived first, or the time
      // since `compacting` when the boundary is what ends it.
      const measuredMs =
        state.measuredCompactionMs ?? (state.compacting ? Date.now() - state.compacting.startedAt : null);
      const mark = markFromSdkBoundary(msg, { measuredMs, fallbackTrigger: state.compacting?.trigger });
      state.measuredCompactionMs = null;
      state.compacting = null;
      // Set before the republish below, so the map's caption and the drained
      // arc arrive in the same snapshot.
      state.lastCompacted = { at: Date.now(), preTokens: mark.preTokens, postTokens: mark.postTokens };
      this.onContextUsed?.(sessionId, contextUsedFromCompactBoundary(msg));
      state.heldCompaction = {
        id: `${sessionId}:${++this.seq}:0`,
        role: 'compaction',
        timestamp: new Date().toISOString(),
        ...(typeof msg.uuid === 'string' ? { uuid: msg.uuid as string } : {}),
        compaction: mark,
      };
      // Also when the status message already said so: the status messages
      // sit behind a CLI flag, and the boundary must stand on its own.
      this.onCompaction?.(sessionId, { type: 'succeeded' });
      return;
    }
    if (msg.type === 'system' && msg.subtype === 'commands_changed') {
      const s = this.sessions.get(sessionId);
      if (s && Array.isArray(msg.commands)) s.commands = shapeCommands(msg.commands);
      return;
    }
    // The CLI speaking for itself: `local_command_output` and the loop's
    // `informational` banner. Neither is a turn, so neither touches the
    // session's status or its context reading — they are rows and nothing
    // else. Every OTHER `system` subtype still falls through unread.
    if (msg.type === 'system') {
      const row = noticeFromSdkMessage(msg, `${sessionId}:${++this.seq}:0`);
      if (row) this.hub.publish(topic, { event: 'message', message: row });
      return;
    }
    // The answer as it is written — the main loop's on `session:<id>`, a
    // subagent's on its own topic, each in a stream state of its own
    // (spec: 2026-09-24-streaming-output-design § 1).
    if (msg.type === 'stream_event') {
      if (msg.event) this.onStreamEvent(sessionId, state, msg.event, msg.parent_tool_use_id ?? null);
      return;
    }
    if (msg.type === 'assistant' || msg.type === 'user') {
      // Main loop and subagents alike: a background task a subagent starts
      // reaches this session's stream and is listed under it (spec
      // 2026-09-28-background-tasks-design, Out of scope).
      this.noteLaunchingCalls(sessionId, state, msg);
      // A main-loop frame means the turn is running, whoever started it.
      // Orbital used to learn that only from its own `send()`, so every
      // turn the CLI starts by ITSELF — a background agent reporting
      // back, a queued message, a hook — streamed a whole answer while
      // the map still said NEEDS INPUT. Subagent frames
      // (`parent_tool_use_id` set) are deliberately not this signal;
      // `hasLiveBackgroundWork` already speaks for them, and only the main
      // loop's own turn can be said to have ended.
      if (msg.parent_tool_use_id == null) this.noteOpenToolUses(state, msg);
      if (msg.parent_tool_use_id == null) {
        const s = this.sessions.get(sessionId);
        const began = s?.turnEnded === true;
        if (s) s.turnEnded = false;
        this.settleStatus(sessionId);
        // Only on the edge: every later frame of the same turn changes
        // nothing, and a republish per streamed block is a firehose.
        if (began) this.onTurnBoundary?.(sessionId, false);
      }
      // A slash command the CLI answered by itself arrives as a SYNTHETIC
      // assistant frame — `message.model` is the literal `<synthetic>`
      // and `message.usage` is all zeros — with the answer in its text
      // blocks and `local_command_source` beside them. Publishing it as
      // an assistant turn would draw a model divider around a model that
      // does not exist, feed the context arc's fallback a zero, and hand
      // the auto-titler a page of `/context` output; a reload, which
      // rebuilds the same answer from the transcript file, would then
      // disagree with the live view about what kind of row it is. So it
      // becomes the same notice on both paths and stops here — before
      // the usage capture, `onEntries` and the ordinary publish, and
      // after the turn edge above, which is real: the turn did run.
      const localCommand = noticeFromSdkMessage(msg, `${sessionId}:${++this.seq}:0`);
      if (localCommand) {
        this.hub.publish(topic, { event: 'message', message: localCommand });
        return;
      }
      // How big the conversation was when this call ran — kept as the
      // turn's fallback reading. Only the main loop's own calls: a
      // subagent (`parent_tool_use_id` set) fills a window of its own,
      // which is not this session's.
      if (msg.type === 'assistant' && msg.parent_tool_use_id == null) {
        const used = contextUsedFromAssistantUsage(msg.message?.usage);
        const s = this.sessions.get(sessionId);
        if (s && used !== null) s.lastCall = used;
      }
      // The publish itself is the other half of the `parent_tool_use_id`
      // split above. Before `forwardSubagentText` this branch mattered
      // only for `onEntries` and the fallback reading, because a
      // subagent's tool_use/tool_result blocks look harmless enough on
      // `session:<id>` — but they vanish on reload (`entriesToMessages`
      // skips `isSidechain` entries), so live and reloaded transcripts of
      // the same session already disagreed before today. Now that the SDK
      // also forwards a subagent's prose and thinking, publishing it here
      // unchanged would flood the parent with the whole nested
      // conversation instead of the one line it used to get from the
      // tool's own `tool_result`. So a subagent frame goes to its own
      // buffer and its own topic instead, and touches neither `onEntries`
      // nor `session:<id>` at all (spec
      // `2026-09-22-subagent-transcript-panel-design.md` § "The bug this
      // uncovers" and § 2).
      if (msg.parent_tool_use_id == null) {
        // The SDK's `isSynthetic` is the transcript's `isMeta` under
        // another name; restoring it keeps a skill body or an image
        // note out of whatever reads these as transcript entries.
        const entry = (msg.type === 'user' && (msg as { isSynthetic?: boolean }).isSynthetic === true
          ? { ...msg, isMeta: true }
          : msg) as TranscriptEntry;
        this.onEntries?.(sessionId, [entry]);
        // Every delta of a block goes out before the block itself, so
        // the client never sees a complete row grow afterwards.
        this.flushStream(sessionId, state);
        const idFor = this.streamedIdFor(state.stream, msg);
        for (const chat of sdkToChatMessages(msg, () => ++this.seq, this.images, idFor)) {
          this.hub.publish(topic, { event: 'message', message: chat });
        }
      } else {
        const agent: string = msg.parent_tool_use_id;
        // The same order as the main loop: the agent's deltas first, then
        // the block, which takes over the row they were filling. The
        // buffer below only ever holds complete messages.
        this.flushStream(sessionId, state, agent);
        const agentStream = state.agentStreams.get(agent);
        const chats = sdkToChatMessages(msg, () => ++this.seq, this.images, this.streamedIdFor(agentStream, msg));
        if (agentStream?.stopped && agentStream.rows.size === 0) state.agentStreams.delete(agent);
        this.subagentTranscripts?.append(sessionId, msg.parent_tool_use_id, chats);
        const subagentTopic = `subagent:${sessionId}:${msg.parent_tool_use_id}`;
        // Read AFTER the append, so it already counts whatever this
        // frame just evicted. `droppedCount` rides every increment and
        // not just the REST response (spec § 3: "`droppedCount` rides
        // the REST response and the WS increments") — without it a
        // panel that was opened before the buffer overflowed would
        // never learn it had, and its TRUNCATED chip would stay hidden
        // while the transcript above it silently lost its head.
        const droppedCount =
          this.subagentTranscripts?.get(sessionId, msg.parent_tool_use_id)?.droppedCount ?? 0;
        for (const chat of chats) {
          this.hub.publish(subagentTopic, { event: 'message', message: chat, droppedCount });
        }
      }
    } else if (msg.type === 'result') {
      this.hub.publish(topic, { event: 'turn_result', usage: msg.usage ?? {} });
      this.onTurnUsage?.(msg.modelUsage);
      // How full the window is now (spec `context-fill-arc`). Deliberately
      // NOT `msg.usage`, which is the turn's billing total across every
      // request it made — see `contextUsedFromAssistantUsage`.
      const used = await this.contextUsed(sessionId);
      if (used !== null) this.onContextUsed?.(sessionId, used);
      // The turn is over — but whether the SESSION is waiting for the
      // human depends on what it left running behind it, which is
      // `settleStatus`'s call to make.
      const s = this.sessions.get(sessionId);
      if (s) s.turnEnded = true;
      // A compaction never outlives the turn it ran in; the republish below
      // carries the cleared state to the map.
      state.compacting = null;
      state.turnPrompt = null;
      // The turn after an interrupt has put its prompt in the file, which
      // takes the interrupted call off the live branch; the client still
      // holds it from the stream, so it reads the transcript again.
      if (state.danglingCall === 'resetAtTurnEnd') {
        state.danglingCall = 'none';
        this.hub.publish(topic, { event: 'transcript_reset' });
      }
      this.settleStatus(sessionId);
      this.onTurnBoundary?.(sessionId, true);
    }
  }

  /** Keeps `openToolUses` in step with one main-loop frame. */
  private noteOpenToolUses(state: ManagedSession, msg: any): void {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (msg.type === 'assistant' && block?.type === 'tool_use' && typeof block.id === 'string') {
        state.openToolUses.add(block.id);
      } else if (msg.type === 'user' && block?.type === 'tool_result') {
        state.openToolUses.delete(block.tool_use_id);
      }
    }
  }

  /** The CLI refused the session's truncating resume; tells whoever holds it, once. */
  private refuseRewind(state: ManagedSession, message: string): void {
    const rewind = state.rewind;
    state.rewind = null;
    state.rewindRefused = true;
    if (!rewind) return;
    try {
      rewind.refused(message);
    } catch (err) {
      console.warn('orbital: failed to record a refused rewind:', err);
    }
  }

  /**
   * The CLI's `system/status` messages, of which only a compaction's two
   * edges mean anything here (spec 2026-09-28-context-compaction-design §
   * Live state). `requesting`, and a bare `null` with no `compact_result`,
   * are ignored.
   */
  private onCompactionStatus(sessionId: string, state: ManagedSession, msg: any): void {
    if (msg.status === 'compacting') {
      if (state.compacting) return;
      state.compacting = {
        startedAt: Date.now(),
        trigger: compactTriggerOf(state.turnPrompt),
        preTokens: this.readContextUsed?.(sessionId) ?? null,
      };
      state.measuredCompactionMs = null;
      this.onCompaction?.(sessionId, { type: 'started' });
      return;
    }
    const result = msg.compact_result;
    if (result !== 'success' && result !== 'failed') return;
    const started = state.compacting;
    state.compacting = null;
    const measuredMs = started ? Date.now() - started.startedAt : null;
    if (result === 'success') {
      // Kept for the boundary that follows, in case it carries no duration.
      state.measuredCompactionMs = measuredMs;
      this.onCompaction?.(sessionId, { type: 'succeeded' });
      return;
    }
    const error = typeof msg.compact_error === 'string' && msg.compact_error.trim() ? msg.compact_error : null;
    const failure: CompactionFailureRecord = {
      id: `compaction:${randomUUID()}`,
      at: Date.now(),
      error,
      preTokens: started ? started.preTokens : (this.readContextUsed?.(sessionId) ?? null),
      // A failure reports no trigger, so it is Orbital's own attribution.
      trigger: started?.trigger ?? compactTriggerOf(state.turnPrompt),
      durationMs: measuredMs,
    };
    this.hub.publish(`session:${sessionId}`, { event: 'message', message: failureMessage(failure) });
    this.onCompaction?.(sessionId, { type: 'failed', failure });
  }

  /** Publishes the compaction mark waiting for its summary, if any. */
  private publishHeldCompaction(sessionId: string, state: ManagedSession): void {
    const held = state.heldCompaction;
    if (!held) return;
    state.heldCompaction = null;
    this.hub.publish(`session:${sessionId}`, { event: 'message', message: held });
  }

  /**
   * Plays a compaction through `handle()` with fake SDK messages, for the dev
   * route (spec 2026-09-28-context-compaction-design § Dev simulation).
   * Nothing reaches the CLI: the messages go where the CLI's own would, and
   * nowhere else. `false` when this Runner does not hold the session.
   */
  simulateCompaction(sessionId: string, outcome: SimulatedCompactionOutcome, seconds: number): boolean {
    const state = this.sessions.get(sessionId);
    if (!state) return false;
    const feed = (msg: Record<string, unknown>) =>
      this.handle(sessionId, state, { session_id: sessionId, uuid: randomUUID(), ...msg });
    void (async () => {
      await feed({ type: 'system', subtype: 'status', status: 'compacting' });
      const trigger = state.compacting?.trigger ?? 'auto';
      const preTokens = state.compacting?.preTokens ?? SIMULATED_PRE_TOKENS;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds) * 1000).unref?.());
      if (outcome === 'failed' || outcome === 'failed_no_error') {
        await feed({
          type: 'system', subtype: 'status', status: null, compact_result: 'failed',
          ...(outcome === 'failed' ? { compact_error: SIMULATED_COMPACT_ERROR } : {}),
        });
        return;
      }
      await feed({ type: 'system', subtype: 'status', status: null, compact_result: 'success' });
      // `success_no_post_tokens` also drops the duration, so the measured
      // fallback is exercised too.
      const full = outcome === 'success';
      await feed({
        type: 'system', subtype: 'compact_boundary',
        compact_metadata: {
          trigger,
          pre_tokens: preTokens,
          ...(full ? { post_tokens: Math.round(preTokens * 0.12), duration_ms: Math.round(seconds * 1000) } : {}),
        },
      });
      await feed({
        type: 'user', parent_tool_use_id: null, isSynthetic: true,
        message: { role: 'user', content: SIMULATED_SUMMARY },
      });
    })();
    return true;
  }

  /**
   * The compaction running in this session right now, or `null` — for every
   * session this Runner does not hold, too. In memory only.
   */
  compacting(sessionId: string): CompactingState | null {
    const c = this.sessions.get(sessionId)?.compacting;
    return c ? { startedAt: c.startedAt, trigger: c.trigger } : null;
  }

  /** The last compaction this Runner saw succeed in the session, or `null`. */
  lastCompacted(sessionId: string): LastCompacted | null {
    return this.sessions.get(sessionId)?.lastCompacted ?? null;
  }

  /**
   * Folds one Messages API stream event into its loop's stream state — the
   * main loop's when `agent` is `null`, otherwise that subagent's — and
   * publishes the text it carries as coalesced `delta` events
   * (spec: 2026-09-24-streaming-output-design § 3).
   */
  private onStreamEvent(sessionId: string, state: ManagedSession, event: any, agent: string | null): void {
    if (event.type === 'message_start') {
      // A new message: whatever the last one left unclaimed is stale now.
      this.flushStream(sessionId, state, agent);
      const model = typeof event.message?.model === 'string' ? event.message.model : undefined;
      const fresh: StreamState = {
        messageId: typeof event.message?.id === 'string' ? event.message.id : '',
        model,
        rows: new Map(),
        pending: new Map(),
        flushTimer: null,
        stopped: false,
      };
      if (agent !== null) {
        state.agentStreams.set(agent, fresh);
        return;
      }
      state.stream = fresh;
      // The first frame of a turn, ahead of any complete message — the same
      // edge the assistant/user branch of `pump()` marks, moved earlier. A
      // subagent's message is not this edge, as its complete frames are not.
      const began = state.turnEnded === true;
      state.turnEnded = false;
      this.settleStatus(sessionId);
      if (began) this.onTurnBoundary?.(sessionId, false);
      return;
    }
    const stream = this.streamOf(state, agent);
    if (!stream) return;
    if (event.type === 'content_block_start') {
      const kind = event.content_block?.type;
      if (kind !== 'text' && kind !== 'thinking') return;
      const index = Number(event.index);
      stream.rows.set(index, {
        id: `${sessionId}:${++this.seq}:${index}`,
        role: kind === 'text' ? 'assistant' : 'thinking',
        text: '',
      });
      return;
    }
    if (event.type === 'content_block_delta') {
      const index = Number(event.index);
      const row = stream.rows.get(index);
      if (!row) return;
      const delta = event.delta;
      const text =
        delta?.type === 'text_delta' && typeof delta.text === 'string' ? delta.text
        : delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' ? delta.thinking
        : '';
      if (!text) return;
      const pending = stream.pending.get(index);
      if (pending) pending.text += text;
      else stream.pending.set(index, { offset: row.text.length, text });
      row.text += text;
      if (!stream.flushTimer) {
        const timer = setTimeout(() => {
          stream.flushTimer = null;
          this.flushStream(sessionId, state, agent);
        }, STREAM_FLUSH_MS);
        (timer as unknown as { unref?: () => void }).unref?.();
        stream.flushTimer = timer;
      }
      return;
    }
    if (event.type === 'content_block_stop') {
      this.flushStream(sessionId, state, agent);
      return;
    }
    if (event.type === 'message_stop') {
      this.flushStream(sessionId, state, agent);
      stream.stopped = true;
      // The complete blocks may all have landed already; if not, the last of
      // them drops the entry in `pump()`.
      if (agent !== null && stream.rows.size === 0) state.agentStreams.delete(agent);
    }
  }

  /** The stream state of the main loop (`agent` null) or of one subagent. */
  private streamOf(state: ManagedSession, agent: string | null): StreamState | null {
    return agent === null ? state.stream : (state.agentStreams.get(agent) ?? null);
  }

  /**
   * Publishes every row's pending text as one `delta` each, and clears it. A
   * subagent's go to its own topic and carry the buffer's `droppedCount`, as
   * its `message` events do, so a panel learns of an overflow from either.
   */
  /**
   * Keeps what the background task tracker needs from one frame: each
   * `Bash`/`Monitor` call, and the output path its `tool_result` names. The
   * assistant frame with the call precedes the `task_started` it causes; the
   * result usually follows it, so a path found here is also handed on.
   */
  private noteLaunchingCalls(sessionId: string, state: ManagedSession, msg: any): void {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type === 'tool_use' && TASK_LAUNCHING_TOOLS.has(block.name) && typeof block.id === 'string') {
        const input = block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {};
        state.launchingCalls.set(block.id, { name: block.name, input });
        if (state.launchingCalls.size > MAX_LAUNCHING_CALLS) {
          state.launchingCalls.delete(state.launchingCalls.keys().next().value!);
        }
      } else if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const call = state.launchingCalls.get(block.tool_use_id);
        if (!call || call.outputPath) continue;
        const path = OUTPUT_PATH_IN_RESULT.exec(toolResultText(block.content))?.[1];
        if (!path) continue;
        call.outputPath = path;
        this.onTaskOutputPath?.(sessionId, block.tool_use_id, path);
      }
    }
  }

  private flushStream(sessionId: string, state: ManagedSession, agent: string | null = null): void {
    const stream = this.streamOf(state, agent);
    if (!stream) return;
    if (stream.flushTimer) {
      clearTimeout(stream.flushTimer);
      stream.flushTimer = null;
    }
    if (stream.pending.size === 0) return;
    const topic = agent === null ? `session:${sessionId}` : `subagent:${sessionId}:${agent}`;
    const dropped =
      agent === null ? {} : { droppedCount: this.subagentTranscripts?.get(sessionId, agent)?.droppedCount ?? 0 };
    for (const [index, pending] of stream.pending) {
      const row = stream.rows.get(index);
      if (!row) continue;
      this.hub.publish(topic, {
        event: 'delta',
        id: row.id,
        role: row.role,
        offset: pending.offset,
        text: pending.text,
        ...(stream.model ? { model: stream.model } : {}),
        ...dropped,
      });
    }
    stream.pending.clear();
  }

  /**
   * The id resolver a complete assistant frame converts with: a `text` or
   * `thinking` block whose text equals an unclaimed row of the frame's own
   * loop's stream takes that row's id, and the row leaves the stream. Text
   * equality rather than block order — the deltas concatenate to the final
   * text exactly, and one frame per block is the SDK's habit, not its
   * contract (adr: streamed-text-rides-as-offset-deltas-on-the-rows-id).
   */
  private streamedIdFor(
    stream: StreamState | null | undefined,
    msg: any,
  ): ((block: { type: 'text' | 'thinking'; text: string }) => string | undefined) | undefined {
    if (!stream || msg.type !== 'assistant' || msg.message?.id !== stream.messageId) return undefined;
    return (block) => {
      const role = block.type === 'text' ? 'assistant' : 'thinking';
      for (const [index, row] of stream.rows) {
        if (row.role === role && row.text === block.text) {
          stream.rows.delete(index);
          return row.id;
        }
      }
      return undefined;
    };
  }

  /**
   * How full this session's window is at the end of a turn, or `null` when
   * nothing could measure it.
   *
   * Two sources, best first:
   *
   * 1. `get_context_usage`, where the CLI counts what it will send next —
   *    system prompt, tool schemas, memory files, messages — and answers
   *    with the total. A measurement, and the same number `/context` prints.
   * 2. The turn's last main-loop API call, reconstructed from its billed
   *    `usage`. One request behind the truth (it misses whatever the turn's
   *    final assistant message added), and blind to anything the CLI would
   *    trim before the next send, but close and always available.
   *
   * The control request is bounded rather than simply awaited: it travels the
   * same stdio channel `pump()` is draining, and a CLI that never answers it
   * — an old one, a wedged one — would otherwise stall the session's whole
   * message stream behind a number that is decoration. Past the deadline the
   * fallback answers and the late reply, if it ever comes, is dropped.
   *
   * Consumes `lastCall` either way: each turn measures itself, and a turn
   * with nothing to measure must stay silent rather than re-report the
   * previous turn's figure as if it were new.
   */
  private async contextUsed(sessionId: string): Promise<number | null> {
    const s = this.sessions.get(sessionId);
    const fallback = s?.lastCall ?? null;
    if (s) s.lastCall = null;
    const ask = s?.generator?.getContextUsage;
    if (!ask) return fallback;
    try {
      const answer = await Promise.race([
        ask.call(s.generator, { detail: 'summary' }),
        new Promise((resolve) => setTimeout(() => resolve(null), CONTEXT_USAGE_TIMEOUT_MS).unref?.()),
      ]);
      return contextUsedFromContextUsage(answer) ?? fallback;
    } catch {
      // A CLI too old for the control request answers by refusing it. Not
      // worth a log line every turn — the fallback is a good number.
      return fallback;
    }
  }

  private enqueue(sessionId: string, msg: InputMessage): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const waiter = s.queue.shift();
    if (waiter) waiter(msg);
    else s.pending.push(msg);
  }

  /**
   * The SDK's `canUseTool`: what the CLI blocks on while it waits for a
   * human. An unsettled promise blocks the tool forever — the SDK gives it no
   * park deadline — so every path out of here settles exactly once.
   *
   * Three kinds ride one envelope (`decisionKindFor`): the question card, the
   * permission prompt, and the plan approval. Only the surface the browser
   * draws differs; the parking, the hub events, the `needs_input` status and
   * the settle-exactly-once guarantee are the same machinery for all three.
   */
  private decide(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    opts: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const s = this.sessions.get(sessionId);
    if (!s) {
      return Promise.resolve({ behavior: 'deny', message: `session ${sessionId} is not active` });
    }
    const kind = decisionKindFor(toolName);
    // A question from inside a subagent (`agentID` set) is refused, not
    // parked: the only surface that shows it is the read-only subagent panel,
    // so a card for it would be a promise nobody can keep — and parking it
    // would also supersede whatever the parent itself is waiting on. A
    // subagent's permission ask is unaffected: the parent's card answers it
    // (adr: a-subagents-question-is-refused-not-relayed).
    if (kind === 'question' && typeof opts.agentID === 'string' && opts.agentID !== '') {
      return Promise.resolve({ behavior: 'deny', message: SUBAGENT_QUESTION_REFUSAL });
    }
    // `bypassPermissions` is the user saying "do not ask me". The CLI normally
    // honours that before the callback is reached, but a rule or a safety
    // check can still route one here — and a session launched to run
    // unattended must not stop on a card nobody is watching for. Questions and
    // plan approvals are not permission prompts and are unaffected: the model
    // asked the human something, and no mode answers that on their behalf.
    if (kind === 'permission' && s.attempt.permissionMode === 'bypassPermissions') {
      return Promise.resolve({ behavior: 'allow' });
    }
    // Defensive: the model is blocked on the first ask, so a second cannot
    // normally arrive. If one does, the older promise is settled rather than
    // dropped — an overwritten resolver is a permanently blocked tool.
    this.settleDecision(sessionId, {
      behavior: 'deny',
      message: 'Superseded by a newer request.',
    });
    const pending: PendingDecision = {
      id: opts.toolUseID, kind, input, createdAt: Date.now(),
      // The bridge's prompt copy, only where there is a surface that draws
      // it. A question card names its own tool and writes its own headline
      // out of the questions, so none of this would reach the browser — and
      // an envelope carrying fields nothing reads is one more thing that can
      // drift. Each field travels only when the CLI actually sent it: an
      // older CLI sends none, and an absent field says "none" more honestly
      // than an empty string the browser would then have to test for.
      ...(kind === 'question'
        ? {}
        : {
            toolName,
            ...(typeof opts.title === 'string' ? { title: opts.title } : {}),
            ...(typeof opts.displayName === 'string' ? { displayName: opts.displayName } : {}),
            ...(typeof opts.description === 'string' ? { description: opts.description } : {}),
            ...(opts.defaultToNo === true ? { defaultToNo: true } : {}),
          }),
    };
    return new Promise<PermissionResult>((resolve) => {
      // Already aborted: `addEventListener` would never fire, and parking a
      // decision nothing will ever answer is worse than denying it now.
      if (opts.signal.aborted) {
        resolve({ behavior: 'deny', message: 'The request was aborted.' });
        return;
      }
      const onAbort = () =>
        this.settleDecision(sessionId, { behavior: 'deny', message: 'The request was aborted.' });
      opts.signal.addEventListener('abort', onAbort, { once: true });
      s.decision = {
        pending,
        settle: (result) => {
          opts.signal.removeEventListener('abort', onAbort);
          resolve(result);
        },
        review: null,
      };
      this.hub.publish(`session:${sessionId}`, { event: 'decision_pending', decision: pending });
      this.onDecision?.(sessionId);
      // No sleep timer is armed for this: a parked decision has no deadline,
      // mirroring the SDK, whose `canUseTool` promise has none either.
      this.setStatus(sessionId, 'needs_input');
      // AFTER the park, and only after: the browser's card is what owns this
      // decision, and the editor is offered as a second way to answer the
      // same one. Nothing below can stop the card from appearing, and
      // nothing here is awaited.
      this.offerReview(sessionId, pending, toolName, input);
    });
  }

  /**
   * Shows a parked edit in the editor as a diff, when there is an editor to
   * show it in (spec 2026-09-23-ide-bridge-design § Talking back to the
   * editor).
   *
   * Strictly additive. The browser card is already published by the time
   * this runs; a session with no editor, an extension without `openDiff`, or
   * an ask that is not an edit simply never opens a tab, and every one of
   * those is the behaviour Orbital has today.
   */
  private offerReview(
    sessionId: string,
    pending: PendingDecision,
    toolName: string,
    input: Record<string, unknown>,
  ): void {
    const ide = this.ide;
    const s = this.sessions.get(sessionId);
    // Only an ordinary permission ask. A question is the model asking the
    // human something and a plan is not a file, so neither is a diff.
    if (!ide || !s || pending.kind !== 'permission') return;
    const cwd = s.attempt.cwd;
    if (!ide.offers(cwd, toolName, input)) return;

    const controller = new AbortController();
    // Re-read rather than closing over `s.decision`: a settle may already
    // have happened between the park and here, in which case there is
    // nothing to attach the review to and nothing to open.
    const parked = s.decision;
    if (!parked || parked.pending.id !== pending.id) return;
    parked.review = controller;

    void ide
      .review({ cwd, toolName, input, decisionId: pending.id, signal: controller.signal })
      .then((verdict) => {
        // Null is no verdict at all — an editor that quit, a tab closed
        // without an answer, a call that failed, or this review being
        // abandoned because the browser got there first. In every one of
        // them the decision is left exactly as it was found.
        if (verdict) this.answerFromEditor(sessionId, pending.id, verdict);
      })
      .catch(() => {
        // Nothing about the editor may fail a session. A review that throws
        // is a review that did not happen.
      });
  }

  /**
   * The editor's verdict on a decision it was shown — the second route in.
   *
   * It settles through `settleDecision` like every other route, and it
   * refuses everything that route already refuses: a session this process
   * does not run, a decision that is no longer parked, and — the guard this
   * route adds — a decision that is parked but is *not the one this review
   * was opened for*. Without that last check a late verdict could answer the
   * NEXT ask, which is the one way two routes could ever settle one decision
   * wrongly.
   */
  private answerFromEditor(
    sessionId: string,
    decisionId: string,
    verdict: IdeReviewVerdict,
  ): boolean {
    const s = this.sessions.get(sessionId);
    const parked = s?.decision;
    if (!s || !parked || parked.pending.id !== decisionId) return false;
    if (parked.pending.kind !== 'permission') return false;
    if (!verdict.approved) {
      this.settleDecision(sessionId, {
        behavior: 'deny',
        message: verdict.message || DENIED_MESSAGE,
        decisionClassification: 'user_reject',
      });
    } else {
      this.settleDecision(sessionId, {
        behavior: 'allow',
        // Present only for a hand-edit in the diff tab. A plain approval
        // carries none, exactly as the browser's does: approving a tool must
        // not rewrite what it was asked to do.
        ...(verdict.updatedInput ? { updatedInput: verdict.updatedInput } : {}),
        decisionClassification: 'user_temporary',
      });
    }
    this.setStatus(sessionId, 'working');
    return true;
  }

  /**
   * Settles this session's parked decision, if it has one, and tells every
   * client so their cards lock. `false` when there was nothing parked, which
   * is what makes calling this from every exit path harmless.
   */
  private settleDecision(sessionId: string, result: PermissionResult): boolean {
    const s = this.sessions.get(sessionId);
    const parked = s?.decision;
    if (!s || !parked) return false;
    // Cleared before the resolve, so a settle path that re-enters here
    // (abort racing an answer) finds nothing left to settle.
    s.decision = null;
    // The editor's copy of this ask goes with it, whichever route won. The
    // abort drops the diff tab as well, so no editor is left holding a
    // review of something already decided — and the abandoned `openDiff`
    // answers null, which `answerFromEditor` would refuse anyway.
    parked.review?.abort();
    parked.settle(result);
    this.hub.publish(`session:${sessionId}`, {
      event: 'decision_resolved',
      decisionId: parked.pending.id,
    });
    this.onDecision?.(sessionId);
    return true;
  }

  /**
   * The decision this session is blocked on, or `null` — including for every
   * session this process does not run, whose questions died with it. It is on
   * the session snapshot so a page reload recovers the question.
   */
  pendingDecision(sessionId: string): PendingDecision | null {
    return this.sessions.get(sessionId)?.decision?.pending ?? null;
  }

  /**
   * Answers the parked decision and unblocks the tool. `false` for every case
   * the route reports as 404: a session it does not run, and an id that is not
   * the parked one — a decision already settled among them, which is how the
   * loser of two open windows finds out. Also `false` when the payload does
   * not fit the parked decision's `kind`, which is a 400 rather than a 404 and
   * is why the route checks the shape itself before calling.
   *
   * A question's `answers` are taken as given: the route checks there is one
   * per question, nothing checks what they say. A verdict's `message` reaches
   * the model verbatim as the tool's refusal.
   */
  answerDecision(sessionId: string, decisionId: string, answer: DecisionAnswer): boolean {
    const s = this.sessions.get(sessionId);
    const parked = s?.decision;
    if (!s || !parked || parked.pending.id !== decisionId) return false;
    const { kind, input } = parked.pending;

    if (kind === 'question') {
      if (isDecisionVerdict(answer)) return false;
      this.settleDecision(sessionId, {
        behavior: 'allow',
        updatedInput: { ...input, answers: answer },
      });
      this.setStatus(sessionId, 'working');
      return true;
    }

    if (!isDecisionVerdict(answer)) return false;
    if (!answer.approved) {
      this.settleDecision(sessionId, {
        behavior: 'deny',
        message: answer.message?.trim() || DENIED_MESSAGE,
        // Telemetry only, but the SDK asks hosts that actually prompt a human
        // to say so rather than let the CLI infer it.
        decisionClassification: 'user_reject',
      });
      // A refused tool does not end the turn: the model reads the refusal as
      // this tool's result and carries on with whatever it does instead.
      this.setStatus(sessionId, 'working');
      return true;
    }
    // Before the settle, deliberately. Both the control request and the
    // permission answer travel the CLI's stdin, and stdin is ordered, so
    // firing it first is what puts the new mode in place before the tools the
    // approved plan calls for. Nothing is awaited — the browser's POST is
    // answered by the park being over, not by the CLI acknowledging a mode.
    if (kind === 'plan') this.leavePlanMode(sessionId);
    this.settleDecision(sessionId, {
      behavior: 'allow',
      decisionClassification: 'user_temporary',
    });
    this.setStatus(sessionId, 'working');
    return true;
  }

  /**
   * Takes an approved session out of plan mode.
   *
   * Approving `ExitPlanMode` is the one approval that is not only about the
   * tool in front of it: the tool's own result is a formality, and what the
   * user actually said yes to is the session being allowed to act. Without
   * the control request the CLI stays read-only and the approved plan cannot
   * run a single step of itself — which is the dead end this whole change
   * exists to open.
   *
   * A CLI too old to answer the request (or one that rejects it) leaves the
   * session where it was: still in plan mode, still read-only. Degraded, but
   * never less safe than what the user chose at launch.
   *
   * Only a session actually IN plan mode moves. A model that calls the tool
   * from some other mode is asking for nothing, and quietly rewriting a
   * session's mode on the back of it would be a downgrade the user never
   * asked for.
   */
  private leavePlanMode(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.attempt.permissionMode !== 'plan') return;
    void s.generator?.setPermissionMode?.(APPROVED_PLAN_MODE)?.catch(() => {});
    s.attempt.permissionMode = APPROVED_PLAN_MODE;
    this.onPermissionMode?.(sessionId, APPROVED_PLAN_MODE);
  }

  /**
   * Sends one turn, or settles the parked decision with it. Returns the uuid
   * the turn's entry is written under — a rewind names the turn by it before
   * the file is read again — and null when no turn was started.
   */
  send(sessionId: string, text: string, attachments?: string[]): string | null {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`session ${sessionId} is not active`);
    // Composer text settles a parked decision instead of starting a turn: the
    // CLI asked, so the text it gets back belongs to the ask, which is what
    // the typing meant. What it MEANS depends on the kind, and the two must
    // not be confused — a question's text is an answer merged into the tool's
    // input, and merging an `answers` key into a Bash call would both corrupt
    // the command and approve it.
    //
    // Attachments have nowhere to go on either path.
    const parked = s.decision;
    if (parked && text) {
      if (parked.pending.kind === 'question') {
        // Every question gets the same text — the web client routes per
        // question before it ever posts here, and this is the fallback for
        // the race and for the API.
        const answers: Record<string, string> = {};
        for (const question of decisionQuestions(parked.pending.input)) answers[question] = text;
        this.settleDecision(sessionId, {
          behavior: 'allow',
          updatedInput: { ...parked.pending.input, answers },
        });
      } else {
        // The CLI's own "No, and tell Claude what to do differently". Typing
        // instead of clicking approve is a refusal with a reason in it, never
        // an approval — the one reading under which a stray keystroke cannot
        // authorise anything (spec § Answering).
        this.settleDecision(sessionId, {
          behavior: 'deny',
          message: text,
          decisionClassification: 'user_reject',
        });
      }
      // The settle resumes the turn the ask paused — same mark as the send
      // below.
      s.turnEnded = false;
      this.setStatus(sessionId, 'working');
      return null;
    }
    const uuid = randomUUID();
    const msg = this.userMessage(sessionId, text, attachments, uuid);
    // Nothing to say: leave the session exactly as it was. Flipping it to
    // `working` first would strand it there — no turn is running, so no
    // `result` is coming to move it back.
    if (!msg) return null;
    if (s.danglingCall === 'left') s.danglingCall = 'resetAtTurnEnd';
    // Null the handle, not just clear it — a cleared-but-retained handle is a
    // dangling reference to a timer that can never fire again.
    if (s.sleepTimer) clearTimeout(s.sleepTimer);
    s.sleepTimer = null;
    // A turn is starting, and this is the one place that knows it before the
    // stream does. Without the mark, a task event landing in the gap before
    // the CLI's first frame would run `settleStatus` against a session that
    // still looked finished and snap it back to `needs_input`.
    s.turnEnded = false;
    s.turnPrompt = text;
    this.setStatus(sessionId, 'working');
    this.enqueue(sessionId, msg);
    return uuid;
  }

  /**
   * The slash commands this session's CLI will actually honour, or `null` when
   * there is no live query to ask (an ended session, or one this process never
   * ran). The route treats `null` as its cue to answer from the filesystem
   * catalog alone — see spec 2026-09-20-composer-design § Server.
   *
   * Cached per session and thrown away with it. The cache is also *replaced*
   * whenever the CLI pushes a new list (`system/commands_changed` in
   * `pump()`), which is what keeps a skill discovered mid-session from needing
   * a re-ask.
   */
  async commands(sessionId: string): Promise<SessionCommand[] | null> {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    if (s.commands) return s.commands;
    const generator = s.generator;
    // A CLI too old to know the control request answers "unknown", not an error.
    if (!generator?.supportedCommands) return null;
    let raw: unknown[];
    try {
      raw = await generator.supportedCommands();
    } catch {
      return null;
    }
    if (!Array.isArray(raw)) return null;
    const shaped = shapeCommands(raw);
    // A push that landed while this request was in flight is newer than it, so
    // it keeps the cache; and the session may have ended in the meantime.
    const still = this.sessions.get(sessionId);
    if (still && !still.commands) still.commands = shaped;
    return still?.commands ?? shaped;
  }

  async interrupt(sessionId: string): Promise<void> {
    // Nothing is auto-answered on the user's behalf: an interrupted ask
    // is a denied one, and its card locks unanswered.
    this.settleDecision(sessionId, { behavior: 'deny', message: 'The user interrupted.' });
    const s = this.sessions.get(sessionId);
    await s?.generator?.interrupt?.();
    // The turn the user cut short is over whatever the stream says next, so
    // the mark goes down here rather than waiting for a `result` that an
    // interrupt may never produce.
    if (s) s.turnEnded = true;
    // A call the interrupt cut off before its result stays on the client's
    // screen until the transcript is read again — see `danglingCall`.
    if (s && s.openToolUses.size > 0) {
      s.openToolUses.clear();
      s.danglingCall = 'left';
    }
    // Only the turn stops: what it left running in the background keeps
    // running (adr the-composers-stop-spares-background-work), and keeps the
    // session `working` as it would after any other turn — and unslept, since
    // sleeping stops the process and the tasks with it.
    if (s && this.hasLiveBackgroundWork?.(sessionId) === true) {
      this.settleStatus(sessionId);
    } else {
      this.setStatus(sessionId, 'needs_input');
      this.armSleepTimer(sessionId);
    }
    if (s) this.onTurnBoundary?.(sessionId, true);
  }

  /**
   * Asks the CLI to stop one task — a background task or a subagent, the
   * SDK's `stopTask` takes any task id. The task's own `task_notification`
   * then ends it; nothing here does. False when this Runner holds no live
   * query for the session to send it on.
   */
  async stopTask(sessionId: string, taskId: string): Promise<boolean> {
    const generator = this.sessions.get(sessionId)?.generator;
    if (!generator?.stopTask) return false;
    await generator.stopTask(taskId);
    return true;
  }

  /** The `Bash`/`Monitor` call with this `tool_use` id, as this session's stream carried it. */
  launchingCall(sessionId: string, toolUseId: string): LaunchingCall | undefined {
    return this.sessions.get(sessionId)?.launchingCalls.get(toolUseId);
  }

  /**
   * Changes the model for this session's next turn. The SDK keeps the
   * conversation — only what serves it changes — which is why the UI can
   * promise "context is kept".
   */
  async setModel(sessionId: string, model: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`session ${sessionId} is not active`);
    await s.generator?.setModel?.(model);
  }

  /**
   * Stops the session's `claude` process — for the user's End and Clear, and
   * for the sleep timer. Only the process: whether the session is over is
   * the `ended_at` stamp the routes write, not anything the Runner knows
   * (spec 2026-09-24-sessions-end-only-by-hand-design § 2).
   */
  // Same as `start`: `Promise<void>` is this method's published shape, and the
  // routes await it alongside `setModel`, which genuinely is asynchronous.
  // eslint-disable-next-line @typescript-eslint/require-await
  async stop(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    // Before the input stream closes, so the CLI is unblocked while it can
    // still read the answer to the question it is parked on.
    this.settleDecision(sessionId, { behavior: 'deny', message: 'The session ended.' });
    this.enqueue(sessionId, null); // close the input stream
    this.release(sessionId, s);
  }

  /**
   * Stops the session and waits for its `claude` process to be gone — what a
   * rewind needs before it starts another process on the same transcript
   * (spec 2026-09-29-rewind-design § Runner). `stop()` alone closes the input
   * and lets go without waiting. Also waits out a process a sleep or an End
   * stopped a moment ago that is still draining.
   *
   * A turn in flight is interrupted first, so the CLI is not left finishing
   * it after its input closed. A process that has not exited within half the
   * timeout is closed outright; one still running at the timeout throws,
   * rather than racing it.
   */
  async stopAndWait(sessionId: string, timeoutMs = REWIND_STOP_TIMEOUT_MS): Promise<void> {
    const exit = this.exits.get(sessionId);
    if (!exit) return;
    const s = this.sessions.get(sessionId);
    const generator = s?.generator ?? null;
    const within = (p: Promise<unknown>, ms: number) =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), ms);
        (timer as unknown as { unref?: () => void }).unref?.();
        p.then(() => {
          clearTimeout(timer);
          resolve(true);
        }, () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
    if (s && s.status === 'working' && generator?.interrupt) {
      await within(generator.interrupt().catch(() => {}), timeoutMs / 4);
    }
    await this.stop(sessionId);
    if (await within(exit, timeoutMs / 2)) return;
    (generator as { close?: () => void } | null)?.close?.();
    if (await within(exit, timeoutMs / 2)) return;
    throw new Error(`the session's claude process did not exit within ${timeoutMs / 1000} s`);
  }

  /**
   * The status of a session this Runner holds a process for, and `undefined`
   * for every other — one it never ran and one whose process has stopped
   * alike, so `statusOf` can read the rest off the row.
   */
  status(sessionId: string): SessionStatus | undefined {
    return this.sessions.get(sessionId)?.status;
  }

  /**
   * Whether this Runner has ever started a session under this id, running or
   * not. The launch route's collision check needs the stopped ones too: their
   * transcript still sits on disk under that name, even where the row is
   * gone.
   */
  hasRun(sessionId: string): boolean {
    return this.ran.has(sessionId);
  }

  /**
   * True when this session is `working` only because of what it launched:
   * its own turn is over, and a subagent or a background task is still out
   * there. The name predates the tasks; the label the UI builds from it
   * says which (spec 2026-09-28-background-tasks-design § 3).
   *
   * The distinction the status alone cannot carry. `working` is the honest
   * answer either way — nothing here wants the human — but "it is thinking"
   * and "it is waiting for an agent" are different things to look at on a
   * map, so the UI gets to say which (`WAITING FOR AGENT`). False for every
   * session this Runner does not own, terminal ones included: nobody can read
   * a main loop's turn boundaries off a transcript.
   */
  awaitingSubagents(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s || s.status !== 'working' || !s.turnEnded) return false;
    return this.hasLiveBackgroundWork?.(sessionId) === true;
  }

  active(): string[] {
    return [...this.sessions.keys()];
  }
}
