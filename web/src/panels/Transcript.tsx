import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import type { ChatMessage } from '../lib/types'
import { Button } from '../ui/Button'
import { MessageView } from './MessageView'
import { ToolRow } from './ToolRow'

/** Only the last N messages are rendered — windowing beyond that (real
 * virtualization) is explicitly deferred per the task brief. */
const MAX_VISIBLE_MESSAGES = 200

export type TranscriptItem =
  | { kind: 'message'; key: string; message: ChatMessage }
  | { kind: 'tool'; key: string; toolUse: ChatMessage; toolResult?: ChatMessage }

/**
 * Pairs each `tool_use` message with the `tool_result` sharing its
 * `toolUseId`, folding the pair into a single renderable item. `tool_result`
 * rows never appear on their own — they're only ever attached to their
 * `tool_use`. Order of the original (non-tool_result) messages is preserved.
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

export interface TranscriptProps {
  sessionId: string
}

/**
 * Renders a session's transcript: the last `MAX_VISIBLE_MESSAGES` messages,
 * tool_use/tool_result pairs collapsed into `ToolRow`s, with a "load older"
 * button that prepends an earlier page via the store. Auto-scrolls to the
 * bottom on new messages, but only when the viewport was already scrolled
 * near the bottom (so reading scrollback isn't yanked out from under you).
 */
export function Transcript({ sessionId }: TranscriptProps) {
  const messages = useOrbital(useShallow((s) => s.transcripts[sessionId] ?? []))
  const loadOlder = useOrbital((s) => s.loadOlder)

  const [loadingOlder, setLoadingOlder] = useState(false)
  const [exhausted, setExhausted] = useState(false)

  const windowed = useMemo(
    () => messages.slice(-MAX_VISIBLE_MESSAGES),
    [messages]
  )
  const items = useMemo(() => pairMessages(windowed), [windowed])

  const containerRef = useRef<HTMLDivElement>(null)
  // Tracks whether the viewport was near the bottom, kept fresh by the
  // scroll listener below. Read (not recomputed) by the auto-scroll effect,
  // since by the time that effect runs the new content has already grown
  // scrollHeight — checking "near bottom" post-append would always read as
  // "not near bottom" for a container that hadn't scrolled yet.
  const stickToBottomRef = useRef(true)

  useEffect(() => {
    setExhausted(false)
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

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [items.length])

  const handleLoadOlder = useCallback(async () => {
    if (loadingOlder) return
    setLoadingOlder(true)
    try {
      const fetched = await loadOlder(sessionId)
      if (fetched.length === 0) setExhausted(true)
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
