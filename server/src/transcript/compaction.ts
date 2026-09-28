import type { ChatMessage, CompactionMark } from '../types.js';

/**
 * The compaction mark, built from either of the two places a compaction is
 * reported: the SDK's `compact_boundary` message (snake_case, live) and the
 * transcript file's `compact_boundary` entry (camelCase, reload and terminal).
 * Both must produce the same `CompactionMark`, which is why the reading of
 * each lives here side by side (spec 2026-09-28-context-compaction-design §
 * Success).
 */

type Trigger = CompactionMark['trigger'];

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function triggerOf(value: unknown): Trigger | null {
  return value === 'manual' || value === 'auto' ? value : null;
}

/**
 * The mark for a successful compaction from the SDK's boundary message.
 * `measuredMs` is the time between the `compacting` status and the one that
 * ended it — the one derived value the spec allows, used only when the CLI
 * did not report `duration_ms` itself. `fallbackTrigger` covers a boundary
 * with no readable trigger, which the SDK type does not allow but the stream
 * is not bound by.
 */
export function markFromSdkBoundary(
  msg: unknown,
  opts: { measuredMs?: number | null; fallbackTrigger?: Trigger } = {},
): CompactionMark {
  const meta = ((msg as { compact_metadata?: unknown } | null)?.compact_metadata ?? {}) as Record<string, unknown>;
  return {
    outcome: 'success',
    trigger: triggerOf(meta.trigger) ?? opts.fallbackTrigger ?? 'auto',
    preTokens: finite(meta.pre_tokens),
    postTokens: finite(meta.post_tokens),
    durationMs: finite(meta.duration_ms) ?? opts.measuredMs ?? null,
  };
}

/** The same mark from a transcript file's `compact_boundary` entry. */
export function markFromTranscriptBoundary(entry: unknown): CompactionMark {
  const meta = ((entry as { compactMetadata?: unknown } | null)?.compactMetadata ?? {}) as Record<string, unknown>;
  return {
    outcome: 'success',
    trigger: triggerOf(meta.trigger) ?? 'auto',
    preTokens: finite(meta.preTokens),
    postTokens: finite(meta.postTokens),
    durationMs: finite(meta.durationMs),
  };
}

/**
 * The summary text a compaction left, off the user frame that follows its
 * boundary — a string body in every real transcript, text blocks allowed in
 * case that changes. Empty text is no summary.
 */
export function compactSummaryText(content: unknown): string | null {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n');
  }
  text = text.trim();
  return text ? text : null;
}

/** A persisted failure, as `compaction_failures` holds it. */
export interface CompactionFailureRecord {
  id: string;
  at: number;
  error: string | null;
  preTokens: number | null;
  trigger: Trigger;
  durationMs: number | null;
}

/** The transcript row for a failed compaction — live and on reload alike. */
export function failureMessage(failure: CompactionFailureRecord): ChatMessage {
  return {
    id: failure.id,
    role: 'compaction',
    timestamp: new Date(failure.at).toISOString(),
    compaction: {
      outcome: 'failed',
      trigger: failure.trigger,
      preTokens: failure.preTokens,
      postTokens: null,
      durationMs: failure.durationMs,
      error: failure.error,
    },
  };
}

/**
 * Places each failure in the transcript at its timestamp. The CLI never writes
 * a failed compaction into the file, so without this the mark would vanish on
 * reload (spec § Failure).
 *
 * A failure goes before the first message stamped after it; messages with no
 * readable timestamp are passed over rather than compared, and a failure newer
 * than everything lands at the end. Stable: equal timestamps keep the message
 * first, since the failure is what a turn produced, not what started it.
 */
export function mergeCompactionFailures(
  messages: readonly ChatMessage[],
  failures: readonly CompactionFailureRecord[],
): ChatMessage[] {
  if (failures.length === 0) return messages.slice();
  const pending = failures.slice().sort((a, b) => a.at - b.at);
  const out: ChatMessage[] = [];
  let next = 0;
  for (const message of messages) {
    const at = message.timestamp ? Date.parse(message.timestamp) : NaN;
    if (!Number.isNaN(at)) {
      while (next < pending.length && pending[next].at < at) out.push(failureMessage(pending[next++]));
    }
    out.push(message);
  }
  while (next < pending.length) out.push(failureMessage(pending[next++]));
  return out;
}
