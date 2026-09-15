import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import type { ChatMessage } from '../lib/types'
import { Button } from '../ui/Button'
import { MessageView } from './MessageView'
import { ToolRow } from './ToolRow'

/** Initial size of the rendered window (in paired items) — windowing beyond
 * that (real virtualization) is explicitly deferred per the task brief. A
 * successful "load older" grows this to guarantee the newly fetched page is
 * visible; see `handleLoadOlder` below. */
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
 * growing as "load older" pulls more history in. Auto-scrolls to the
 * bottom on new messages, but only when the viewport was already scrolled
 * near the bottom (so reading scrollback isn't yanked out from under you);
 * prepending older history instead compensates `scrollTop` to keep the
 * reader's position visually anchored.
 */
export function Transcript({ sessionId }: TranscriptProps) {
  const messages = useOrbital(useShallow((s) => s.transcripts[sessionId] ?? []))
  const loadOlder = useOrbital((s) => s.loadOlder)

  const [loadingOlder, setLoadingOlder] = useState(false)
  const [exhausted, setExhausted] = useState(false)
  const [visibleCount, setVisibleCount] = useState(MAX_VISIBLE_MESSAGES)

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
  // Remembers the first item's key and the container's scrollHeight as of
  // the end of the last layout effect run, so the next run can tell a
  // prepend (first key changed) apart from an append, and compute how much
  // the content grew for the scroll-position compensation.
  const prevFirstKeyRef = useRef<string | undefined>(undefined)
  const prevHeightRef = useRef(0)

  useEffect(() => {
    setExhausted(false)
    setVisibleCount(MAX_VISIBLE_MESSAGES)
    prevFirstKeyRef.current = undefined
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

    const firstKey = items[0]?.key
    const wasPrepend =
      prevFirstKeyRef.current !== undefined && firstKey !== undefined && firstKey !== prevFirstKeyRef.current

    if (wasPrepend && !stickToBottomRef.current) {
      el.scrollTop = compensatePrepend(prevHeightRef.current, el.scrollHeight, el.scrollTop)
    } else if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }

    prevFirstKeyRef.current = firstKey
    prevHeightRef.current = el.scrollHeight
  }, [items])

  const handleLoadOlder = useCallback(async () => {
    if (loadingOlder) return
    setLoadingOlder(true)
    try {
      const fetched = await loadOlder(sessionId)
      if (fetched.length === 0) {
        setExhausted(true)
      } else {
        // Growing visibleCount by just fetched.length is NOT enough to
        // guarantee the newly prepended page is actually revealed: if the
        // window was already behind the store's total before this click
        // (e.g. several loadOlder pages accumulated, or the initial fetch
        // already exceeded MAX_VISIBLE_MESSAGES), that pre-existing
        // backlog sits *between* the old window boundary and the new
        // page, and simply growing by the new page's size only eats into
        // that backlog — the freshly fetched messages stay just as hidden
        // as before. Reading the store directly for the up-to-date total
        // and taking the max guarantees the whole thing (backlog + new
        // page) becomes visible, while never shrinking the window.
        const total = pairMessages(useOrbital.getState().transcripts[sessionId] ?? []).length
        setVisibleCount((count) => Math.max(count + fetched.length, total))
      }
    } finally {
      setLoadingOlder(false)
    }
  }, [loadOlder, sessionId, loadingOlder])

  return (
    <div ref={containerRef} className="flex h-full flex-col gap-3 overflow-y-auto">
      {!exhausted && messages.length > 0 && (
        <div className="flex justify-center pb-1">
          <Button variant="ghost" size="sm" onClick={() => void handleLoadOlder()} disabled={loadingOlder}>
            {loadingOlder ? 'Loading…' : 'Load older'}
          </Button>
        </div>
      )}
      {items.map((item) =>
        item.kind === 'tool' ? (
          <ToolRow key={item.key} toolUse={item.toolUse} toolResult={item.toolResult} />
        ) : (
          <MessageView key={item.key} message={item.message} />
        )
      )}
    </div>
  )
}
