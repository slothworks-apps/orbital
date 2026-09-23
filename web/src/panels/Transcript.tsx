import { useCallback, useLayoutEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { recordedFailureFor, useOrbital } from '../store/store'
import type { ChatMessage, Subagent } from '../lib/types'
import { Button } from '../ui/Button'
import { TranscriptView, pairMessages } from './TranscriptView'

/** Stable empty array — a fresh `[]` fallback on every selector call would
 * defeat `useShallow`'s equality check and re-render on every store tick. */
const NO_SUBAGENTS: Subagent[] = []

export { pairMessages, groupToolRuns, insertModelDividers, summarizeToolRun } from './TranscriptView'
export type { TranscriptItem, TranscriptGroup } from './TranscriptView'

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

export interface TranscriptProps {
  sessionId: string
}

/**
 * Store wiring for a session's transcript: reads the session's messages,
 * status and error state out of the store and hands them to `TranscriptView`
 * for rendering. `TranscriptView` owns everything generic over a message
 * array (pairing, folding, scroll anchoring); this component owns
 * everything that requires knowing this is a *session* — its "load older"
 * pagination and the SDK-crash error banner.
 */
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
  // The id of the tool call this session is parked on, so the row for it is
  // lifted out of the folding rules and drawn as a card. Read here rather than
  // inside the card, because grouping is what has to know — and read here
  // rather than in `TranscriptView`, because a pending decision belongs to a
  // session and the view does not know what a session is.
  const pendingDecisionId = useOrbital((s) => s.pendingDecisions[sessionId]?.id)
  // The session's own live subagents, for the `Agent`/`Task` row's `OPEN →`
  // control (spec § 5, canvas 11a) — `TranscriptView` joins each row against
  // this by `toolUseId`, `ToolRow`'s own doc has the reasoning.
  const subagents = useOrbital(useShallow((s) => s.sessions[sessionId]?.subagents ?? NO_SUBAGENTS))
  const openSubagent = useOrbital((s) => s.openSubagent)
  const handleOpenSubagent = useCallback(
    (subagent: Subagent) => {
      void openSubagent(sessionId, subagent)
    },
    [openSubagent, sessionId]
  )

  const [loadingOlder, setLoadingOlder] = useState(false)
  const [exhausted, setExhausted] = useState(false)

  // `TranscriptView` resets its own windowing/scroll state off `resetKey`,
  // but "exhausted" is this session's pagination state, not the view's, so
  // it resets here, off the same switch.
  useLayoutEffect(() => {
    setExhausted(false)
  }, [sessionId])

  // Fetches the next page and reports back how many messages it contained,
  // so `TranscriptView` can grow its visible window by exactly that many
  // (bounded growth — a click reveals that page, not the whole backlog).
  // `loadOlder` itself prepends the fetched messages into the store, which
  // is what actually grows `messages` above.
  const handleLoadOlder = useCallback(async () => {
    if (loadingOlder) return 0
    setLoadingOlder(true)
    try {
      const fetched = await loadOlder(sessionId)
      if (fetched.length === 0) setExhausted(true)
      return fetched.length
    } finally {
      setLoadingOlder(false)
    }
  }, [loadOlder, sessionId, loadingOlder])

  return (
    <TranscriptView
      messages={messages}
      isWorking={isWorking}
      models={models}
      resetKey={sessionId}
      sessionId={sessionId}
      pendingDecisionId={pendingDecisionId}
      onLoadOlder={handleLoadOlder}
      loadingOlder={loadingOlder}
      exhausted={exhausted}
      subagents={subagents}
      onOpenSubagent={handleOpenSubagent}
      footer={
        (recorded || hasError) && (
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
        )
      }
    />
  )
}
