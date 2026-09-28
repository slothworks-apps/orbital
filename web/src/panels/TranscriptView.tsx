import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ChatMessage, OrbitalModel, Subagent } from '../lib/types'
import { modelNameForId } from '../lib/models'
import { formatToolDuration } from '../lib/format'
import { usePresence } from '../ui/usePresence'
import {
  compensatePrepend,
  createScroller,
  enteringKeys,
  isNearBottom,
  type Scroller,
} from './transcriptMotion'
import { MessageView } from './MessageView'
import { NoticeRow } from './NoticeRow'
import { CompactionMark } from './CompactionMark'
import { compactionOrdinals, newestFailedCompactionId } from '../lib/compaction'
import { QuestionCard } from './QuestionCard'
import { PermissionCard } from './PermissionCard'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolRow, salientInput, toolDurationMs } from './ToolRow'
import { QUESTION_TOOL_NAME } from '../lib/questionCard'
import { PLAN_TOOL_NAME } from '../lib/decisionCard'

/** The accent hue (`oklch(85% .12 205)`'s angle), for a mark drawn without a session tag. */
const NEUTRAL_MARK_HUE = 205

/** Initial size of the rendered window (in paired items) — windowing beyond
 * that (real virtualization) is explicitly deferred per the task brief. */
const MAX_VISIBLE_MESSAGES = 200

/** How many already-held rows one scroll to the top reveals when the window
 * has cut some off, before anything is fetched. */
const REVEAL_STEP = 100

/** How far above the top of the transcript the next page starts loading, so
 * a reader scrolling up meets older rows rather than a pause. */
const PAGING_MARGIN = '200px 0px 0px 0px'

/**
 * Minimal shape the transcript needs from an `IntersectionObserver` — lets
 * tests inject a fake, since jsdom has no real IO implementation (the same
 * seam `Sidebar`'s infinite scroll has).
 */
export interface ObserverLike {
  observe(el: Element): void
  disconnect(): void
}

/** Builds the observer watching the paging sentinel, rooted at the
 * transcript's own scroll container. */
export type ScrollObserverFactory = (callback: IntersectionObserverCallback, root: Element) => ObserverLike

/** Real `IntersectionObserver`, used outside tests. Absent (jsdom), nothing
 * pages on its own, which is what every test that is not about paging wants. */
export const defaultScrollObserverFactory: ScrollObserverFactory = (callback, root) =>
  typeof IntersectionObserver === 'undefined'
    ? { observe() {}, disconnect() {} }
    : new IntersectionObserver(callback, { root, rootMargin: PAGING_MARGIN })

export type TranscriptItem =
  | { kind: 'message'; key: string; message: ChatMessage }
  | { kind: 'tool'; key: string; toolUse: ChatMessage; toolResult?: ChatMessage }

/**
 * Pairs each `tool_use` message with the `tool_result` sharing its
 * `toolUseId`, folding the pair into a single renderable item. `tool_result`
 * rows never appear on their own — they're only ever attached to their
 * `tool_use`. Order of the original (non-tool_result) messages is preserved.
 *
 * IMPORTANT: callers must pair on the FULL message array before windowing
 * (slicing) it for display. Windowing raw messages first and pairing
 * second can split a pair across the window boundary — e.g. a tool_use
 * that falls just outside a size-200 window while its tool_result falls
 * just inside it — silently dropping the whole tool call (a lone
 * tool_result has nothing to attach to and is discarded). Pairing first
 * means every rendered item is a complete, atomic unit; windowing the
 * *paired* items afterwards can only ever include or exclude a pair as a
 * whole.
 */
export function pairMessages(messages: ChatMessage[]): TranscriptItem[] {
  const resultByToolUseId = new Map<string, ChatMessage>()
  for (const m of messages) {
    if (m.role === 'tool_result' && m.toolUseId) {
      resultByToolUseId.set(m.toolUseId, m)
    }
  }

  const items: TranscriptItem[] = []
  for (const m of messages) {
    if (m.role === 'tool_result') continue
    if (m.role === 'tool_use') {
      items.push({
        kind: 'tool',
        key: m.id,
        toolUse: m,
        toolResult: m.toolUseId ? resultByToolUseId.get(m.toolUseId) : undefined,
      })
      continue
    }
    items.push({ kind: 'message', key: m.id, message: m })
  }
  return items
}

/** A run of consecutive tool rows, a decision card (a question, a permission
 * prompt or a plan), a single message row, or a model-switch marker inserted
 * between two assistant or thinking messages (see `insertModelDividers`). */
export type TranscriptGroup =
  | { kind: 'tools'; key: string; items: Extract<TranscriptItem, { kind: 'tool' }>[] }
  | { kind: 'question'; key: string; item: Extract<TranscriptItem, { kind: 'tool' }> }
  | { kind: 'decision'; key: string; item: Extract<TranscriptItem, { kind: 'tool' }> }
  | { kind: 'message'; key: string; item: Extract<TranscriptItem, { kind: 'message' }> }
  | { kind: 'model-divider'; key: string; from: string; to: string; timestamp?: string }

/**
 * Folds consecutive tool rows into one group. Canvas 1b sets the
 * transcript's row gap to 14px but packs a run of tool calls into a tight
 * 4px stack, so a multi-step tool sequence reads as one block of machine
 * work between two turns of conversation rather than as N loose rows.
 *
 * Decisions are the exception: they become their own group so the folding
 * rules can never reach them (spec:
 * 2026-09-20-interactive-decisions-design — "a pending card cannot be folded
 * by the transcript-folding rules"). A decision is not machine work to be
 * skimmed past; it is the moment the session stopped on the user. Being a
 * group of its own also breaks the run around it, which is right: the calls
 * before it and the calls after it are two different stretches of work.
 *
 * Three tool calls qualify. `AskUserQuestion` and `ExitPlanMode` always do —
 * the first IS the question and the second IS the plan, which stays worth
 * reading long after it was approved. An ordinary tool qualifies only while
 * the session is actually parked on it (`pendingDecisionId`): the CLI records
 * the tool call, never the prompt, so there is nothing to draw a permission
 * card from once the ask is over, and the row reverts to its usual form
 * (spec 2026-09-23-permission-and-plan-decisions-design § Web UI).
 */
export function groupToolRuns(
  items: TranscriptItem[],
  pendingDecisionId?: string,
): TranscriptGroup[] {
  const groups: TranscriptGroup[] = []
  for (const item of items) {
    if (item.kind === 'message') {
      groups.push({ kind: 'message', key: item.key, item })
      continue
    }
    if (item.toolUse.toolName === QUESTION_TOOL_NAME) {
      groups.push({ kind: 'question', key: item.key, item })
      continue
    }
    if (
      item.toolUse.toolName === PLAN_TOOL_NAME ||
      (pendingDecisionId !== undefined && item.toolUse.toolUseId === pendingDecisionId)
    ) {
      groups.push({ kind: 'decision', key: item.key, item })
      continue
    }
    const last = groups[groups.length - 1]
    if (last?.kind === 'tools') {
      last.items.push(item)
      continue
    }
    groups.push({ kind: 'tools', key: item.key, items: [item] })
  }
  return groups
}

/**
 * Header line of a folded tool run (canvas 6b): call count plus a kind
 * breakdown — kinds sorted by count desc then first appearance, `×n` only
 * when n > 1, top three kinds named and the rest folded into `+n more` —
 * plus, per canvas 11b, the run's total duration.
 *
 * `durationMs` is the sum of every item's `toolDurationMs`, but only when
 * EVERY item has one: a run with one call missing a timestamp (or one still
 * running) has an unknown total, and summing just the known ones would
 * silently under-report it as if it were complete — the same dishonesty
 * `formatToolDuration`'s "no fabricated 0s" rule exists to prevent, one
 * level up. `undefined` here means "don't render a run total", not "it took
 * no time".
 */
export function summarizeToolRun(
  items: Extract<TranscriptItem, { kind: 'tool' }>[]
): { count: number; breakdown: string; durationMs?: number } {
  const counts = new Map<string, number>()
  let durationMs: number | undefined = 0
  for (const item of items) {
    const name = item.toolUse.toolName ?? 'Tool'
    counts.set(name, (counts.get(name) ?? 0) + 1)
    if (durationMs !== undefined) {
      const d = toolDurationMs(item.toolUse, item.toolResult)
      durationMs = d === undefined ? undefined : durationMs + d
    }
  }
  const kinds = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const named = kinds.slice(0, 3).map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
  const more = kinds.length - 3
  return {
    count: items.length,
    breakdown: more > 0 ? `${named.join(', ')} +${more} more` : named.join(', '),
    durationMs,
  }
}

/**
 * Inserts a divider wherever the model behind consecutive assistant or
 * thinking messages changes (canvas 4a).
 *
 * Derived from the messages rather than recorded at switch time, so it
 * survives a reload, needs no storage, and also shows a switch made in a
 * terminal that Orbital never performed. Messages with no model at all (user
 * turns, tool rows, transcripts from a CLI too old to record one) are
 * skipped, never treated as a change — an absent model is unknown, not
 * different.
 *
 * `thinking` carries the same `model` field as `assistant` (both set from
 * the same SDK frame), and a turn frequently opens with a thinking block
 * before its first prose — so the divider reads it too, rather than only
 * landing on the text that follows it one row down (fix
 * `a-thinking-block-opens-a-turn-above-its-own-model-divider`).
 */
export function insertModelDividers(groups: TranscriptGroup[]): TranscriptGroup[] {
  const out: TranscriptGroup[] = []
  let previousModel: string | undefined
  for (const group of groups) {
    const message = group.kind === 'message' ? group.item.message : undefined
    const model =
      message?.role === 'assistant' || message?.role === 'thinking' ? message.model : undefined
    if (model && previousModel && model !== previousModel) {
      out.push({
        kind: 'model-divider',
        key: `model:${group.key}`,
        from: previousModel,
        to: model,
        timestamp: message?.timestamp,
      })
    }
    if (model) previousModel = model
    out.push(group)
  }
  return out
}

export interface TranscriptViewProps {
  /** The full message array to render. Paired on the FULL array first (see
   * `pairMessages`' doc comment), then windowed — never the other way
   * around. */
  messages: ChatMessage[]
  /** Drives 1b's blinking caret on the turn that's still being written. */
  isWorking: boolean
  /** Names divider ids through the catalog (see modelNameForId) —
   * `insertModelDividers` itself stays catalog-free, carrying only raw
   * ids. */
  models: OrbitalModel[]
  /** The id of whatever `messages` is currently pointed at (a session, a
   * subagent buffer, …). The view does not know what that thing is — it
   * only needs to know when it has been pointed at something new, so it can
   * reset the scroll/windowing state and jump to the bottom without
   * animation. */
  resetKey: string
  /** The session a rendered `AskUserQuestion` answers into. `QuestionCard`
   * is interactive and needs a real session id even when the view itself is
   * generic over its message source. */
  sessionId: string
  /** The tool call the session is parked on, if any — its row is lifted out
   * of the folding rules and drawn as a permission card (see
   * `groupToolRuns`). The caller reads it, because a pending decision belongs
   * to a session and this view does not know what a session is. */
  pendingDecisionId?: string
  /** Fetches the next page of older history (the fetch itself prepends it
   * into whatever backs `messages`) and resolves to how many messages that
   * page added — 0 meaning exhausted, `null` a failed fetch that scrolling
   * up again may retry. Called by the infinite scroll when the reader nears
   * the top. Omitted entirely (rather than passed as a no-op) when there is
   * nothing to page — a subagent buffer is finite and unpaginated. */
  onLoadOlder?: () => Promise<number | null>
  /** Nothing older exists to fetch; the view stops asking. */
  exhausted?: boolean
  /** Injectable observer for the paging sentinel; defaults to the real one. */
  observerFactory?: ScrollObserverFactory
  /** Rendered exactly where the error banner sits today, in the same
   * position inside the same scroll container, so DOM order is unchanged. */
  footer?: ReactNode
  /**
   * Changes when the footer's content does. A footer that grows while the
   * reader sits at the bottom — the live compaction block arriving — is
   * followed there, as a new row would be.
   */
  footerKey?: string
  /**
   * Selects the subagent panel's rendering of a `thinking` message — a left
   * hairline rule instead of canvas 1b's boxed treatment, expanded by
   * default instead of collapsed — over the parent transcript's own (spec
   * `2026-09-22-subagent-transcript-panel-design.md` § 7: a 380px panel
   * stacks boxed blocks badly). Named for what it changes, not for who
   * passes it — the subagent panel this exists for lands in a later task.
   */
  compact?: boolean
  /**
   * Forces every rendered `QuestionCard` into its non-interactive forms —
   * passed straight through as that component's own `readOnly` prop. Added
   * for the subagent panel (task 7 review, finding 1): `QuestionCard`'s own
   * `isPending` check cannot be trusted to be false there, because
   * `decide()` (`server/src/runner/runner.ts`) does not read the SDK's
   * `opts.agentID` and so cannot tell a subagent-originated
   * `AskUserQuestion` apart from the parent's own — both land in
   * `pendingDecisions[sessionId]` keyed by the same kind of id. This makes
   * the panel read-only BY CONSTRUCTION rather than by an id happening not
   * to match (fix: subagent-question-ignores-agent-id).
   */
  readOnly?: boolean
  /**
   * What the compaction marks need to know about the session they sit in
   * (spec 2026-09-28-context-compaction-design § The permanent mark). Absent
   * — the subagent panel — they draw with a neutral hue and no actions.
   *
   * `onCompactAgain` is passed only while the session is live; it lands on
   * the newest failure alone. `reveal` scrolls that newest failure into view
   * once, and `onRevealed` reports it done.
   */
  compaction?: {
    terminal: boolean
    contextWindow: number | null
    hue: number
    onCompactAgain?: () => void
    reveal?: boolean
    onRevealed?: () => void
  }
  /**
   * The session's own live `subagents`, threaded straight through to every
   * `ToolRow` this view renders (spec § 5, canvas 11a: the `Agent`/`Task`
   * row's `OPEN →` control). `Transcript` (the parent session's own
   * transcript) passes the real list; `SubagentPanel` never does, so a
   * nested Agent/Task call inside a subagent's OWN transcript stays a plain
   * row — see `ToolRow`'s own doc for why that is correct rather than an
   * oversight.
   */
  subagents?: Subagent[]
  /** Opens the subagent panel for a row's matched agent. Absent alongside
   * `subagents` for the same reason. */
  onOpenSubagent?: (subagent: Subagent) => void
}

/**
 * How long a run takes to fold or unfold. Matches the caret's rotation rather
 * than `ui/motion.ts`'s shorter-exit pair: the caret and the stack are one
 * gesture, and a stack that closes faster than the arrow turning above it
 * reads as two things happening instead of one.
 */
const FOLD_MS = 160

/**
 * Which call a folded run holds beneath its header, if any: the run's
 * leading edge. Only a run that is the transcript's last group, while the
 * turn is still live, has one — and it is always the run's LAST call,
 * finished or not. Picking the unfinished call instead made the row vanish
 * at every boundary between two calls (one finished, the next not yet
 * arrived) and come back a moment later: a layout jump on every call. The
 * row now leaves only when the run stops being the leading edge — something
 * other than a tool call follows it, or the turn ends.
 */
export function leadingEdgeItem<T>(items: T[], isLastGroup: boolean, turnLive: boolean): T | undefined {
  if (!isLastGroup || !turnLive) return undefined
  return items[items.length - 1]
}

/**
 * A folded run of 2+ consecutive tool calls (canvas 6b). Folded is the
 * default; a run containing a failed call defaults OPEN and its right slot
 * says `n failed`; a live run (the last group, while the turn runs) stays
 * folded with its latest call visible beneath the header, finished or not —
 * the run's leading edge, not a child (see `leadingEdgeItem`).
 * The right slot holds one value at a time: `running`, `n failed`, or (on
 * hover) the verb. `toggled` is the user's explicit choice and always wins.
 *
 * The stack travels on `grid-template-rows: 0fr -> 1fr`, which is the one way
 * to transition to a height nobody has measured. `usePresence` keeps it
 * mounted for the closing pass and then removes it, so a folded run holds no
 * rows — neither for a screen reader nor for a `Cmd-F`.
 */
function ToolRunGroup({
  items,
  leadingEdge,
  toggled,
  onToggle,
  onHeightSettled,
  subagents,
  onOpenSubagent,
}: {
  items: Extract<TranscriptItem, { kind: 'tool' }>[]
  /** The call held beneath the folded header — see `leadingEdgeItem`. */
  leadingEdge: Extract<TranscriptItem, { kind: 'tool' }> | undefined
  toggled: boolean | undefined
  onToggle: (next: boolean) => void
  onHeightSettled: () => void
  subagents?: Subagent[]
  onOpenSubagent?: (subagent: Subagent) => void
}) {
  const summary = summarizeToolRun(items)
  const unfinished = items.find((item) => !item.toolResult)
  const failed = items.filter((item) => item.toolResult?.isError).length

  // The default is decided once, on this group's first render, and then left
  // alone. Recomputing it meant a call that failed WHILE you were reading
  // threw the run open under your eyes and shoved everything below it down
  // the page — the single largest unasked-for jump in the transcript. A run
  // whose failure is already in the history when it first renders (a reload,
  // scrolling back) still opens, which is what the spec asks for; what stops
  // is the live flip. The failure is not lost meanwhile — the right slot says
  // `n failed` either way. The group's key is its first message id, so this
  // ref survives every append to the run.
  const defaultOpen = useRef<boolean | null>(null)
  if (defaultOpen.current === null) defaultOpen.current = failed > 0

  const open = toggled ?? defaultOpen.current
  const stack = usePresence(open, FOLD_MS, FOLD_MS)
  const rightSlot = unfinished ? 'running' : failed > 0 ? `${failed} failed` : ''
  const liveLabel = leadingEdge ? salientInput(leadingEdge.toolUse.toolName, leadingEdge.toolUse.toolInput) : ''
  const liveRunning = leadingEdge !== undefined && !leadingEdge.toolResult
  const liveDuration = leadingEdge
    ? formatToolDuration(toolDurationMs(leadingEdge.toolUse, leadingEdge.toolResult))
    : undefined

  return (
    <div data-tool-run data-folded={!open} className="flex flex-col">
      <button
        type="button"
        onClick={() => onToggle(!open)}
        aria-expanded={open}
        className={[
          'group flex w-full items-center gap-2 rounded-[7px] border px-2.5 py-[7px] text-left font-mono text-[11.5px] text-[rgba(200,220,245,.8)]',
          // Canvas 6b: open header keeps a brighter border + faint fill so
          // the group reads as one block; hover brightens further (6b D).
          open
            ? 'border-[rgba(150,205,255,.18)] bg-[rgba(150,205,255,.05)]'
            : 'border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.45)]',
          'hover:border-[rgba(150,205,255,.22)] hover:bg-[rgba(150,205,255,.07)]',
          'focus-visible:border-[oklch(85%_0.12_205_/_0.7)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[oklch(85%_0.12_205_/_0.18)]',
        ].join(' ')}
      >
        {/* One glyph, rotated when open — never swapped, so it animates (6d). */}
        <span
          aria-hidden
          className={[
            'w-2 text-[9px] text-[rgba(160,190,225,.6)] transition-transform duration-[160ms] ease-out',
            open ? 'rotate-90' : '',
          ].join(' ')}
        >
          ▸
        </span>
        <span aria-hidden className="text-[rgba(160,190,225,.6)]">⚙</span>
        <span className="shrink-0 text-text-bright">{summary.count} tool calls</span>
        <span aria-hidden className="text-[rgba(150,205,255,.28)]">·</span>
        <span className="min-w-0 flex-1 truncate text-[rgba(160,190,225,.6)]">{summary.breakdown}</span>
        {formatToolDuration(summary.durationMs) && (
          // Canvas 11b: the run's summed duration, appended to the
          // breakdown ("4 tool calls · Read ×3, Grep ×1 · 6.2s") rather than
          // sharing the right slot below — that slot already holds one of
          // three mutually exclusive values (running / n failed / the hover
          // verb) and a duration is none of those.
          <span className="shrink-0 text-[rgba(160,190,225,.5)]">· {formatToolDuration(summary.durationMs)}</span>
        )}
        {/* One slot, never two values at once (6d): hover swaps in the verb. */}
        <span className="shrink-0 text-[rgba(160,190,225,.5)]">
          <span className="group-hover:hidden">{rightSlot}</span>
          <span className="hidden group-hover:inline">{open ? 'collapse' : 'expand'}</span>
        </span>
      </button>

      {stack.mounted ? (
        <div
          className={[
            'grid motion-safe:transition-[grid-template-rows] motion-safe:duration-[160ms]',
            'motion-safe:ease-[cubic-bezier(.2,.8,.2,1)]',
            stack.state === 'entered' ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
          ].join(' ')}
          // Only this element's own height settling counts — a `ToolRow`'s
          // hover transition bubbles up here too and means nothing to the
          // scroll position.
          onTransitionEnd={(e) => {
            if (e.target === e.currentTarget && e.propertyName === 'grid-template-rows') onHeightSettled()
          }}
        >
          {/* `min-h-0` is what lets the 0fr row actually collapse: a grid item
              floors at its content's min-content height without it. */}
          <div className="min-h-0 overflow-hidden">
            {/* The run's 4px stack and its gap below the header both live
                inside the clip, so a folded run leaves no orphaned gap. */}
            <div className="flex flex-col gap-1 pt-1">
              {items.map((item) => (
                <ToolRow
                  key={item.key}
                  toolUse={item.toolUse}
                  toolResult={item.toolResult}
                  subagents={subagents}
                  onOpenSubagent={onOpenSubagent}
                />
              ))}
            </div>
          </div>
        </div>
      ) : leadingEdge ? (
        // The live row: a plain trace with its caret slot left EMPTY — it is
        // the leading edge, not an openable child — and, while its call
        // runs, the ⚙ blinking at the WORKING tempo. Once the call finishes
        // the same row stays put showing the finished call, so the run does
        // not shrink in the gap before the next call arrives.
        // Gated on `mounted`, not on `open`, so it doesn't stand alongside a
        // copy of itself in the stack that is still closing.
        <div
          data-live-tool
          className="mt-1 flex items-center gap-2 rounded-[7px] border border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.45)] px-2.5 py-[7px] font-mono text-[11.5px] text-[rgba(200,220,245,.8)]"
        >
          <span aria-hidden className="w-2" />
          <span
            aria-hidden
            className={[liveRunning ? 'orbital-pulse' : '', 'text-[rgba(160,190,225,.6)]'].join(' ')}
          >
            ⚙
          </span>
          <span className="min-w-0 flex-1 truncate">
            {leadingEdge.toolUse.toolName}
            {liveLabel ? ': ' : ''}
            <span className="text-text-bright">{liveLabel}</span>
            {liveRunning && <span className="text-[rgba(160,190,225,.5)]">…</span>}
          </span>
          {!liveRunning && liveDuration && (
            // The same "· 0.3s" a `ToolRow` carries (canvas 11b).
            <span className="shrink-0 text-[rgba(160,190,225,.5)]">· {liveDuration}</span>
          )}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Renders a message array: tool_use/tool_result pairs collapsed into
 * `ToolRow`s (paired on the full history, then windowed — see
 * `pairMessages`), starting at the last `MAX_VISIBLE_MESSAGES` items. Scrolling
 * near the top grows the window — first over rows already held but cut off,
 * then by each fetched page's size as `onLoadOlder` pulls more history in
 * (bounded growth — one scroll reveals one page, not the whole backlog;
 * `slice(-N)` clamps naturally once N reaches the array length). Auto-
 * scrolls to the bottom on new messages, but only when the viewport was
 * already scrolled near the bottom (so reading scrollback isn't yanked out
 * from under you); prepending older history instead compensates
 * `scrollTop` to keep the reader's position visually anchored.
 */
export function TranscriptView({
  messages,
  isWorking,
  models,
  resetKey,
  sessionId,
  pendingDecisionId,
  onLoadOlder,
  exhausted,
  observerFactory = defaultScrollObserverFactory,
  footer,
  footerKey,
  compact = false,
  readOnly = false,
  subagents,
  onOpenSubagent,
  compaction,
}: TranscriptViewProps) {
  const [visibleCount, setVisibleCount] = useState(MAX_VISIBLE_MESSAGES)
  // Folded tool runs (spec: 2026-09-18-transcript-folding-design). An
  // explicit toggle always wins over the default (folded, or open for a run
  // containing a failure). Keyed by the group's first message id — stable
  // while streaming appends to the run. Reset on session switch is accepted.
  const [runToggles, setRunToggles] = useState<Record<string, boolean>>({})

  // Pair on the FULL array first (see pairMessages' doc comment), then
  // window the paired rows — never the other way around.
  const pairedAll = useMemo(() => pairMessages(messages), [messages])
  const items = useMemo(() => pairedAll.slice(-visibleCount), [pairedAll, visibleCount])
  const groups = useMemo(
    () => insertModelDividers(groupToolRuns(items, pendingDecisionId)),
    [items, pendingDecisionId],
  )

  // Over the FULL array: `N OF M` counts every compaction held, not only the
  // windowed ones.
  const ordinals = useMemo(() => compactionOrdinals(messages), [messages])
  const newestFailedId = useMemo(() => newestFailedCompactionId(messages), [messages])

  const containerRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<Scroller | null>(null)
  // Tracks whether the viewport was near the bottom, kept fresh by the
  // scroll listener below. Read (not recomputed) by the auto-scroll effect,
  // since by the time that effect runs the new content has already grown
  // scrollHeight — checking "near bottom" post-append would always read as
  // "not near bottom" for a container that hadn't scrolled yet.
  const stickToBottomRef = useRef(true)
  // Arriving at a session — and the first paint of any session — lands at the
  // bottom with no animation. Easing down through a whole backlog would read
  // as the view running away, and there is nothing along the way to see.
  const jumpNextRef = useRef(true)
  // Explicit "a prepend is about to land" signal, set by `loadOlder` below
  // right before it awaits onLoadOlder and consumed (cleared) by the layout
  // effect below. This is deliberately NOT inferred from `items[0]`
  // changing: at the MAX_VISIBLE_MESSAGES cap, a live WS-appended message
  // at the *bottom* evicts the oldest visible item from the window too,
  // which also changes `items[0]` — inferring prepend from that would
  // misfire scroll-compensation (meant for content added above the
  // viewport) on a bottom append, yanking the view for anyone reading
  // scrollback during a long streaming session.
  const prependPendingRef = useRef(false)
  // The container's scrollHeight at the moment an older page was asked for,
  // which is what a landing prepend has to be measured against. Captured
  // there rather than carried forward from the last render, because plenty
  // changes the height without changing `items` at all — folding a run,
  // an image finishing its load — and a carried-forward value would have the
  // compensation below correct by the wrong number of pixels.
  const heightBeforePrependRef = useRef(0)

  // The previous render's keys, for deciding which rows just arrived — tagged
  // with the resetKey they belong to, because the comparison happens during
  // render and a layout effect would clear them a beat too late: the first
  // render after a switch would diff the new backlog against the
  // old resetKey's keys and light the whole thing up.
  const seenRef = useRef<{ resetKey: string; keys: string[] } | null>(null)

  useLayoutEffect(() => {
    setVisibleCount(MAX_VISIBLE_MESSAGES)
    prependPendingRef.current = false
    heightBeforePrependRef.current = 0
    stickToBottomRef.current = true
    jumpNextRef.current = true
    scrollerRef.current?.cancel()
  }, [resetKey])

  // A layout effect, and declared above the auto-scroll one, so the scroller
  // exists before the first paint's scroll-to-bottom needs it.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const scroller = createScroller(el)
    scrollerRef.current = scroller
    const onScroll = () => {
      // Positions the scroller itself produced say nothing about where the
      // reader wants to be: mid-flight it is by definition not at the bottom
      // yet, and believing that would un-stick the container halfway through
      // its own scroll.
      if (!scroller.isAnimating()) stickToBottomRef.current = isNearBottom(el)
    }
    el.addEventListener('scroll', onScroll)
    return () => {
      el.removeEventListener('scroll', onScroll)
      scroller.destroy()
      scrollerRef.current = null
    }
  }, [])

  // NOTE: the branching below (prepend-compensation vs stick-to-bottom) is
  // inspection-verified rather than covered by a jsdom test — jsdom never
  // computes real scrollHeight/clientHeight layout, so a DOM-level test
  // here would just be asserting against hand-set fixture properties, not
  // real behavior. `isNearBottom` and `compensatePrepend`, the two pieces
  // of actual logic, are unit-tested directly instead.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return

    if (prependPendingRef.current) {
      // Anchoring is a correction, not a move: it puts the reader back where
      // they already were, so it has to be instant. Any scroll still in
      // flight is cancelled first — it was aiming at a bottom that the
      // prepend has just moved.
      scrollerRef.current?.cancel()
      el.scrollTop = compensatePrepend(heightBeforePrependRef.current, el.scrollHeight, el.scrollTop)
      prependPendingRef.current = false
    } else if (stickToBottomRef.current) {
      scrollerRef.current?.toBottom({ instant: jumpNextRef.current })
    }
    // else: an `items` change that's neither a pending prepend nor while
    // stuck to the bottom — e.g. a WS append evicting the window's oldest
    // item while the reader is scrolled up. Left untouched on purpose
    // (acceptable v1): that eviction can shift content by one row, but
    // applying prepend-style compensation here would be the exact
    // misclassification this ref exists to avoid.

    jumpNextRef.current = false
  }, [items])

  /**
   * Re-reads whether the reader is at the bottom after something changed the
   * content's height without moving the scrollbar — folding a run is the one
   * that matters. Expanding a run at the bottom of the transcript pushes the
   * bottom away without firing a `scroll` event, so without this the
   * container still believes it is stuck and the next message yanks the view
   * down. Called when the fold animation settles, and again on the toggle
   * itself for the reduced-motion path, where there is no animation to end.
   */
  // The map's COMPACT FAILED badge opens the session at its mark. After the
  // stick-to-bottom effect above, so the landing is not undone by it; the
  // reader is then deliberately not at the bottom.
  const reveal = compaction?.reveal === true
  const onRevealed = compaction?.onRevealed
  useLayoutEffect(() => {
    if (!reveal || !newestFailedId) return
    const el = containerRef.current?.querySelector(`[data-compaction-id="${newestFailedId}"]`)
    if (!el) return
    scrollerRef.current?.cancel()
    el.scrollIntoView?.({ block: 'center' })
    stickToBottomRef.current = false
    onRevealed?.()
  }, [reveal, newestFailedId, items, onRevealed])

  useLayoutEffect(() => {
    if (footerKey && stickToBottomRef.current) scrollerRef.current?.toBottom({ instant: false })
  }, [footerKey])

  const refreshStick = useCallback(() => {
    const el = containerRef.current
    if (el && !scrollerRef.current?.isAnimating()) stickToBottomRef.current = isNearBottom(el)
  }, [])

  useLayoutEffect(() => {
    refreshStick()
  }, [runToggles, refreshStick])

  // Derived in a memo rather than during render so StrictMode's second pass
  // can't consume the arrivals before the first one has painted them; the
  // layout effect below is what moves the window forward, once per commit.
  const entering = useMemo(() => {
    const prev = seenRef.current?.resetKey === resetKey ? seenRef.current.keys : null
    return new Set(enteringKeys(prev, groups.map((g) => g.key)))
  }, [groups, resetKey])
  useLayoutEffect(() => {
    seenRef.current = { resetKey, keys: groups.map((g) => g.key) }
  }, [groups, resetKey])

  // Rows already held but cut off by the window. They come first: they are
  // older than anything held on screen and newer than anything a fetch
  // would bring, and a fetch cursored on the store's oldest message would
  // skip right over them.
  const hiddenCount = pairedAll.length - items.length
  const canFetch = Boolean(onLoadOlder) && !exhausted && messages.length > 0
  const pages = hiddenCount > 0 || canFetch

  // One load at a time. A ref, not state: the observer can report twice
  // before a render lands, and a second call must never clear the "a
  // prepend is about to land" signal out from under the fetch that IS going
  // to land content — the misclassification `prependPendingRef` exists to
  // avoid. Checked before either ref below is touched.
  const loadingRef = useRef(false)
  // The resetKey a load started under; a page that resolves after the view
  // was pointed somewhere else belongs to the old key and is ignored.
  const resetKeyRef = useRef(resetKey)
  resetKeyRef.current = resetKey

  // Called when the reader nears the top. Arms the scroll-anchoring signal
  // (see `prependPendingRef` and `heightBeforePrependRef` above), then grows
  // `visibleCount` by exactly what landed — bounded growth: one scroll to the
  // top reveals one page, not the whole backlog.
  const loadOlder = useCallback(async () => {
    if (loadingRef.current) return
    const el = containerRef.current
    if (hiddenCount > 0) {
      heightBeforePrependRef.current = el?.scrollHeight ?? 0
      prependPendingRef.current = true
      setVisibleCount((count) => count + Math.min(REVEAL_STEP, hiddenCount))
      return
    }
    if (!canFetch || !onLoadOlder) return
    loadingRef.current = true
    const key = resetKey
    heightBeforePrependRef.current = el?.scrollHeight ?? 0
    prependPendingRef.current = true
    try {
      const fetchedCount = await onLoadOlder()
      if (resetKeyRef.current !== key) return
      if (!fetchedCount) {
        // No content is actually landing above the viewport, so there's
        // nothing for the layout effect to compensate — don't leave the flag
        // armed for some unrelated later change to misfire on.
        prependPendingRef.current = false
      } else {
        setVisibleCount((count) => count + fetchedCount)
      }
    } finally {
      loadingRef.current = false
    }
  }, [hiddenCount, canFetch, onLoadOlder, resetKey])

  // Infinite scroll, `Sidebar`'s pattern turned upside down: a sentinel above
  // the first row, observed against the transcript's own scroll container.
  // Re-observed whenever the transcript grows, because an observer only
  // reports CHANGES — a sentinel still in view after a page landed (a short
  // transcript) says nothing more on its own, and re-observing is what asks
  // again. It stops when there is nothing left to page: the sentinel leaves
  // the DOM. On arrival the layout effect above has already jumped to the
  // bottom before an observer reports anything, so a long transcript loads
  // nothing until the reader scrolls up; a short one, whose top is in view,
  // asks until a page comes back empty.
  const sentinelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = containerRef.current
    const el = sentinelRef.current
    if (!root || !el || !pages) return
    const observer = observerFactory((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadOlder()
    }, root)
    observer.observe(el)
    return () => observer.disconnect()
  }, [observerFactory, loadOlder, pages, messages.length, visibleCount])

  return (
    // Canvas 1b: the transcript owns the panel's 18px/22px inset and stacks
    // its rows 14px apart.
    <div
      ref={containerRef}
      className="flex h-full flex-col gap-[14px] overflow-y-auto px-[22px] py-[18px]"
    >
      {/* The negative margin takes back the row gap the sentinel would
          otherwise add above the first row. */}
      {pages && (
        <div ref={sentinelRef} data-testid="transcript-sentinel" aria-hidden className="-mb-[15px] h-px shrink-0" />
      )}
      {groups.map((group, index, all) => (
        // One wrapper per group, unconditionally — the entrance belongs to
        // the transcript (it is the transcript that knows what just arrived),
        // not to four different row components, and a wrapper that came and
        // went with the animation would remount the row underneath it.
        //
        // `shrink-0` because this is now the flex item, and the flex item is
        // what the column crushes when its content overflows. `QuestionCard`
        // carries the same class and the comment explaining it (it rendered
        // 2px tall — its borders — without it); here it covers every row
        // kind, which is what the container wanted all along. jsdom cannot
        // catch this; only the browser can.
        <div
          key={group.key}
          className={['shrink-0', entering.has(group.key) ? 'orbital-row-enter' : ''].join(' ')}
        >
        {group.kind === 'model-divider' ? (
          // Canvas 4a "Transcript model divider": 9.5px mono, .14em tracking,
          // a hairline on each side, sitting in the transcript's own 14px
          // row rhythm like any other group.
          <div
            data-model-divider
            className="flex items-center gap-2.5 font-mono text-[9.5px] tracking-[0.14em] text-[rgba(160,190,225,.55)]"
          >
            <span aria-hidden className="h-px flex-1 bg-[rgba(150,205,255,.12)]" />
            <span>
              {/* shortVersion, not modelChipLabel's chip form — a divider has
                  no room for the variant, and the canvas writes the plain
                  short form ("SONNET 4.5", not "SONNET 4.5 (1M)"). */}
              {modelNameForId(group.from, models).toUpperCase()} →{' '}
              {modelNameForId(group.to, models).toUpperCase()}
              {group.timestamp
                ? ` · ${new Date(group.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
                : ''}
            </span>
            <span aria-hidden className="h-px flex-1 bg-[rgba(150,205,255,.12)]" />
          </div>
        ) : group.kind === 'question' ? (
          <QuestionCard
            sessionId={sessionId}
            toolUse={group.item.toolUse}
            toolResult={group.item.toolResult}
            readOnly={readOnly}
          />
        ) : group.kind === 'decision' ? (
          <PermissionCard
            sessionId={sessionId}
            toolUse={group.item.toolUse}
            toolResult={group.item.toolResult}
          />
        ) : group.kind === 'tools' ? (
          group.items.length === 1 ? (
            // A lone call is not a run — no header, today's row (canvas 6b A).
            <div data-tool-run className="flex flex-col gap-1">
              <ToolRow
                toolUse={group.items[0].toolUse}
                toolResult={group.items[0].toolResult}
                subagents={subagents}
                onOpenSubagent={onOpenSubagent}
              />
            </div>
          ) : (
            <ToolRunGroup
              items={group.items}
              leadingEdge={leadingEdgeItem(group.items, index === all.length - 1, isWorking)}
              toggled={runToggles[group.key]}
              onToggle={(next) => setRunToggles((t) => ({ ...t, [group.key]: next }))}
              onHeightSettled={refreshStick}
              subagents={subagents}
              onOpenSubagent={onOpenSubagent}
            />
          )
        ) : group.item.message.role === 'compaction' ? (
          <CompactionMark
            message={group.item.message}
            sessionId={sessionId}
            ordinal={ordinals.get(group.item.message.id)}
            terminal={compaction?.terminal ?? false}
            contextWindow={compaction?.contextWindow ?? null}
            hue={compaction?.hue ?? NEUTRAL_MARK_HUE}
            onCompactAgain={group.item.message.id === newestFailedId ? compaction?.onCompactAgain : undefined}
          />
        ) : group.item.message.role === 'notice' ? (
          // The CLI answering for itself — a locally-answered slash command,
          // a hook's banner. Never `MessageView`: it is neither speech nor a
          // turn, and it carries no model, so the divider logic above leaves
          // it alone as well.
          <NoticeRow message={group.item.message} />
        ) : group.item.message.role === 'thinking' ? (
          // `role: 'thinking'` gets its own path, never `MessageView` — that
          // component computes `isUser = role === 'user'` and draws
          // anything else as an assistant markdown bubble, which is the bug
          // this closes: raw chain-of-thought rendering as if the model had
          // said it out loud (spec § 7, "the live defect").
          <ThinkingBlock message={group.item.message} compact={compact} />
        ) : (
          <MessageView
            message={group.item.message}
            streaming={
              isWorking &&
              index === all.length - 1 &&
              group.item.message.role === 'assistant'
            }
          />
        )}
        </div>
      ))}
      {footer}
    </div>
  )
}
