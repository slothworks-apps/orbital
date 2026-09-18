import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { recordedFailureFor, useOrbital } from '../store/store'
import type { ChatMessage } from '../lib/types'
import { modelNameForId } from '../lib/models'
import { Button } from '../ui/Button'
import { MessageView } from './MessageView'
import { ToolRow, salientInput } from './ToolRow'

/** Initial size of the rendered window (in paired items), and the amount a
 * successful "load older" grows it by (bounded — see `handleLoadOlder`
 * below) — windowing beyond that (real virtualization) is explicitly
 * deferred per the task brief. */
const MAX_VISIBLE_MESSAGES = 200

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

/** A run of consecutive tool rows, a single message row, or a model-switch
 * marker inserted between two assistant messages (see `insertModelDividers`). */
export type TranscriptGroup =
  | { kind: 'tools'; key: string; items: Extract<TranscriptItem, { kind: 'tool' }>[] }
  | { kind: 'message'; key: string; item: Extract<TranscriptItem, { kind: 'message' }> }
  | { kind: 'model-divider'; key: string; from: string; to: string; timestamp?: string }

/**
 * Folds consecutive tool rows into one group. Canvas 1b sets the
 * transcript's row gap to 14px but packs a run of tool calls into a tight
 * 4px stack, so a multi-step tool sequence reads as one block of machine
 * work between two turns of conversation rather than as N loose rows.
 */
export function groupToolRuns(items: TranscriptItem[]): TranscriptGroup[] {
  const groups: TranscriptGroup[] = []
  for (const item of items) {
    if (item.kind === 'message') {
      groups.push({ kind: 'message', key: item.key, item })
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
 * when n > 1, top three kinds named and the rest folded into `+n more`.
 */
export function summarizeToolRun(
  items: Extract<TranscriptItem, { kind: 'tool' }>[]
): { count: number; breakdown: string } {
  const counts = new Map<string, number>()
  for (const item of items) {
    const name = item.toolUse.toolName ?? 'Tool'
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const kinds = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const named = kinds.slice(0, 3).map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
  const more = kinds.length - 3
  return {
    count: items.length,
    breakdown: more > 0 ? `${named.join(', ')} +${more} more` : named.join(', '),
  }
}

/**
 * Inserts a divider wherever the model behind consecutive assistant messages
 * changes (canvas 4a).
 *
 * Derived from the messages rather than recorded at switch time, so it
 * survives a reload, needs no storage, and also shows a switch made in a
 * terminal that Orbital never performed. Messages with no model at all (user
 * turns, tool rows, transcripts from a CLI too old to record one) are
 * skipped, never treated as a change — an absent model is unknown, not
 * different.
 */
export function insertModelDividers(groups: TranscriptGroup[]): TranscriptGroup[] {
  const out: TranscriptGroup[] = []
  let previousModel: string | undefined
  for (const group of groups) {
    const message = group.kind === 'message' ? group.item.message : undefined
    const model = message?.role === 'assistant' ? message.model : undefined
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

/**
 * The most recent tool call still awaiting its result — i.e. what's
 * mid-edit right now — or `undefined` if nothing is running. Reuses
 * `pairMessages` (built for `Transcript`'s own rendering) rather than
 * re-deriving the tool_use/tool_result pairing logic, so `StopDialog` can
 * show the same "what's running" row the transcript itself would.
 */
export function openToolUse(messages: ChatMessage[]): ChatMessage | undefined {
  const items = pairMessages(messages)
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (item.kind === 'tool' && !item.toolResult) return item.toolUse
  }
  return undefined
}

/** Minimal shape `isNearBottom` needs from a scroll container — lets tests
 * inject fixture values, since jsdom never computes real scroll metrics. */
export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** True when the bottom of the scrollable content is within `threshold`
 * pixels of the current scroll position. */
export function isNearBottom(el: ScrollMetrics, threshold = 80): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
}

/**
 * Scroll offset that keeps the same content anchored under the viewport
 * after older content was prepended above it (which grows `scrollHeight`
 * out from under a `scrollTop` that hasn't moved, visually yanking
 * whatever the user was reading downward). Pure arithmetic, factored out
 * so it's testable without a real DOM: the container grew by
 * `newHeight - prevHeight` pixels, all of it above the old content, so
 * `scrollTop` needs to grow by exactly that much to keep the same pixel
 * under the viewport's top edge.
 */
export function compensatePrepend(prevHeight: number, newHeight: number, scrollTop: number): number {
  return scrollTop + (newHeight - prevHeight)
}

export interface TranscriptProps {
  sessionId: string
}

/**
 * Renders a session's transcript: tool_use/tool_result pairs collapsed into
 * `ToolRow`s (paired on the full history, then windowed — see
 * `pairMessages`), starting at the last `MAX_VISIBLE_MESSAGES` items and
 * growing by each fetched page's size as "load older" pulls more history
 * in (bounded growth — a click reveals that page, not the whole backlog;
 * `slice(-N)` clamps naturally once N reaches the array length). Auto-
 * scrolls to the bottom on new messages, but only when the viewport was
 * already scrolled near the bottom (so reading scrollback isn't yanked out
 * from under you); prepending older history instead compensates
 * `scrollTop` to keep the reader's position visually anchored.
 */
/**
 * A folded run of 2+ consecutive tool calls (canvas 6b). Folded is the
 * default; a run containing a failed call defaults OPEN and its right slot
 * says `n failed`; a live run stays folded with only its one unfinished
 * call visible beneath the header — the run's leading edge, not a child.
 * The right slot holds one value at a time: `running`, `n failed`, or (on
 * hover) the verb. `toggled` is the user's explicit choice and always wins.
 */
function ToolRunGroup({
  items,
  toggled,
  onToggle,
}: {
  items: Extract<TranscriptItem, { kind: 'tool' }>[]
  toggled: boolean | undefined
  onToggle: (next: boolean) => void
}) {
  const summary = summarizeToolRun(items)
  const unfinished = items.find((item) => !item.toolResult)
  const failed = items.filter((item) => item.toolResult?.isError).length
  const open = toggled ?? failed > 0
  const rightSlot = unfinished ? 'running' : failed > 0 ? `${failed} failed` : ''
  const liveLabel = unfinished ? salientInput(unfinished.toolUse.toolName, unfinished.toolUse.toolInput) : ''

  return (
    <div data-tool-run data-folded={!open} className="flex flex-col gap-1">
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
        {/* One slot, never two values at once (6d): hover swaps in the verb. */}
        <span className="shrink-0 text-[rgba(160,190,225,.5)]">
          <span className="group-hover:hidden">{rightSlot}</span>
          <span className="hidden group-hover:inline">{open ? 'collapse' : 'expand'}</span>
        </span>
      </button>

      {open ? (
        items.map((item) => (
          <ToolRow key={item.key} toolUse={item.toolUse} toolResult={item.toolResult} />
        ))
      ) : unfinished ? (
        // The live row: a plain trace with its caret slot left EMPTY — it
        // isn't openable yet — and the ⚙ blinking at the WORKING tempo.
        <div
          data-live-tool
          className="flex items-center gap-2 rounded-[7px] border border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.45)] px-2.5 py-[7px] font-mono text-[11.5px] text-[rgba(200,220,245,.8)]"
        >
          <span aria-hidden className="w-2" />
          <span aria-hidden className="orbital-pulse text-[rgba(160,190,225,.6)]">⚙</span>
          <span className="min-w-0 flex-1 truncate">
            {unfinished.toolUse.toolName}
            {liveLabel ? ': ' : ''}
            <span className="text-text-bright">{liveLabel}</span>
            <span className="text-[rgba(160,190,225,.5)]">…</span>
          </span>
        </div>
      ) : null}
    </div>
  )
}

export function Transcript({ sessionId }: TranscriptProps) {
  const messages = useOrbital(useShallow((s) => s.transcripts[sessionId] ?? []))
  const loadOlder = useOrbital((s) => s.loadOlder)
  // Drives 1b's blinking caret on the turn that's still being written.
  const isWorking = useOrbital((s) => s.sessions[sessionId]?.status === 'working')
  // SDK process crash error state (spec § Error states): set by the store
  // when this session went `working` -> `ended` without a `turn_result` in
  // between. See `store.ts`'s `turnResultSeen` bookkeeping.
  const hasError = useOrbital((s) => Boolean(s.transcriptErrors[sessionId]))
  // What replaces the guess: the session's most recent row in the shared
  // error log. When there is one it carries the real reason, and — because
  // it comes from the database rather than from a live WS transition — it
  // survives a reload, which `transcriptErrors` never did. Returns an
  // element of the array, so the reference is stable between renders.
  const recorded = useOrbital((s) => recordedFailureFor(s, sessionId))
  const setDialog = useOrbital((s) => s.setDialog)
  // Names the divider's raw ids through the catalog (see modelNameForId) —
  // insertModelDividers itself stays catalog-free, carrying only raw ids.
  const models = useOrbital(useShallow((s) => s.models))

  const [loadingOlder, setLoadingOlder] = useState(false)
  const [exhausted, setExhausted] = useState(false)
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

  const containerRef = useRef<HTMLDivElement>(null)
  // Tracks whether the viewport was near the bottom, kept fresh by the
  // scroll listener below. Read (not recomputed) by the auto-scroll effect,
  // since by the time that effect runs the new content has already grown
  // scrollHeight — checking "near bottom" post-append would always read as
  // "not near bottom" for a container that hadn't scrolled yet.
  const stickToBottomRef = useRef(true)
  // Explicit "a prepend is about to land" signal, set by handleLoadOlder
  // right before it awaits loadOlder and consumed (cleared) by the layout
  // effect below. This is deliberately NOT inferred from `items[0]`
  // changing: at the MAX_VISIBLE_MESSAGES cap, a live WS-appended message
  // at the *bottom* evicts the oldest visible item from the window too,
  // which also changes `items[0]` — inferring prepend from that would
  // misfire scroll-compensation (meant for content added above the
  // viewport) on a bottom append, yanking the view for anyone reading
  // scrollback during a long streaming session.
  const prependPendingRef = useRef(false)
  // The container's scrollHeight as of the end of the last layout effect
  // run, used to compute how much a pending prepend grew the content by.
  const prevHeightRef = useRef(0)

  useLayoutEffect(() => {
    setExhausted(false)
    setVisibleCount(MAX_VISIBLE_MESSAGES)
    prependPendingRef.current = false
    prevHeightRef.current = 0
  }, [sessionId])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onScroll = () => {
      stickToBottomRef.current = isNearBottom(el)
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
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
      el.scrollTop = compensatePrepend(prevHeightRef.current, el.scrollHeight, el.scrollTop)
      prependPendingRef.current = false
    } else if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
    // else: an `items` change that's neither a pending prepend nor while
    // stuck to the bottom — e.g. a WS append evicting the window's oldest
    // item while the reader is scrolled up. Left untouched on purpose
    // (acceptable v1): that eviction can shift content by one row, but
    // applying prepend-style compensation here would be the exact
    // misclassification this ref exists to avoid.

    prevHeightRef.current = el.scrollHeight
  }, [items])

  const handleLoadOlder = useCallback(async () => {
    if (loadingOlder) return
    setLoadingOlder(true)
    prependPendingRef.current = true
    try {
      const fetched = await loadOlder(sessionId)
      if (fetched.length === 0) {
        setExhausted(true)
        // No content is actually landing above the viewport, so there's
        // nothing for the layout effect to compensate — don't leave the
        // flag armed for some unrelated later change to misfire on.
        prependPendingRef.current = false
      } else {
        // Bounded growth: reveal exactly this page, no more. `slice(-N)`
        // clamps naturally when N exceeds the array length, so this never
        // needs to know the store's total — it just grows the window by
        // what was actually fetched, same as the "last 200" cap it started
        // from, keeping the window's size predictable on every click.
        setVisibleCount((count) => count + fetched.length)
      }
    } finally {
      setLoadingOlder(false)
    }
  }, [loadOlder, sessionId, loadingOlder])

  return (
    // Canvas 1b: the transcript owns the panel's 18px/22px inset and stacks
    // its rows 14px apart.
    <div
      ref={containerRef}
      className="flex h-full flex-col gap-[14px] overflow-y-auto px-[22px] py-[18px]"
    >
      {!exhausted && messages.length > 0 && (
        <div className="flex justify-center pb-1">
          <Button variant="ghost" size="sm" onClick={() => void handleLoadOlder()} disabled={loadingOlder}>
            {loadingOlder ? 'Loading…' : 'Load older'}
          </Button>
        </div>
      )}
      {insertModelDividers(groupToolRuns(items)).map((group, index, groups) =>
        group.kind === 'model-divider' ? (
          // Canvas 4a "Transcript model divider": 9.5px mono, .14em tracking,
          // a hairline on each side, sitting in the transcript's own 14px
          // row rhythm like any other group.
          <div
            key={group.key}
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
        ) : group.kind === 'tools' ? (
          group.items.length === 1 ? (
            // A lone call is not a run — no header, today's row (canvas 6b A).
            <div key={group.key} data-tool-run className="flex flex-col gap-1">
              <ToolRow toolUse={group.items[0].toolUse} toolResult={group.items[0].toolResult} />
            </div>
          ) : (
            <ToolRunGroup
              key={group.key}
              items={group.items}
              toggled={runToggles[group.key]}
              onToggle={(next) => setRunToggles((t) => ({ ...t, [group.key]: next }))}
            />
          )
        ) : (
          <MessageView
            key={group.key}
            message={group.item.message}
            streaming={
              isWorking &&
              index === groups.length - 1 &&
              group.item.message.role === 'assistant'
            }
          />
        )
      )}
      {(recorded || hasError) && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md border border-red-400/30 bg-red-400/10 px-3 py-2 font-mono text-xs text-red-300"
        >
          <span aria-hidden>⚠</span>
          {/* The heuristic stays underneath as the fallback: a CLI that exits
              non-zero without the generator throwing records nothing, and for
              that case the generic sentence is still the honest answer. */}
          <span className="min-w-0 flex-1 break-words">
            {recorded
              ? recorded.message
              : 'Session ended unexpectedly — the assistant process may have crashed.'}
          </span>
          {recorded && (
            <Button variant="ghost" size="sm" onClick={() => setDialog('errors')}>
              Detail
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
