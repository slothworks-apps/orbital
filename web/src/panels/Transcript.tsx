import { useCallback, useLayoutEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { recordedFailureFor, useOrbital } from '../store/store'
import type { BackgroundTask, ChatMessage, Subagent } from '../lib/types'
import { Button } from '../ui/Button'
import { TranscriptView, pairMessages, type ScrollObserverFactory } from './TranscriptView'
import { CompactingBlock } from './CompactionMark'
import { compactingOf } from '../lib/compaction'
import { contextWindowFor } from '../lib/models'
import { useCompactionUi } from '../store/compaction'

/** Stable empty array — a fresh `[]` fallback on every selector call would
 * defeat `useShallow`'s equality check and re-render on every store tick. */
const NO_SUBAGENTS: Subagent[] = []
const NO_TASKS: BackgroundTask[] = []

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
  /** Injectable observer for the infinite scroll's sentinel (tests). */
  observerFactory?: ScrollObserverFactory
}

/**
 * Store wiring for a session's transcript: reads the session's messages,
 * status and error state out of the store and hands them to `TranscriptView`
 * for rendering. `TranscriptView` owns everything generic over a message
 * array (pairing, folding, scroll anchoring); this component owns
 * everything that requires knowing this is a *session* — fetching its older
 * history and the SDK-crash error banner.
 */
export function Transcript({ sessionId, observerFactory }: TranscriptProps) {
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
  // And its background tasks, for a background `Bash` or `Monitor` row's
  // `OUTPUT →` (spec 2026-09-28-background-tasks-design § 3).
  const backgroundTasks = useOrbital(useShallow((s) => s.sessions[sessionId]?.backgroundTasks ?? NO_TASKS))
  const openTaskOutput = useOrbital((s) => s.openTaskOutput)
  const handleOpenTaskOutput = useCallback(
    (task: BackgroundTask) => {
      void openTaskOutput(sessionId, task.id)
    },
    [openTaskOutput, sessionId]
  )

  const [exhausted, setExhausted] = useState(false)

  // Context compaction (spec 2026-09-28-context-compaction-design): what the
  // marks draw against, and the live block while one runs.
  const session = useOrbital((s) => s.sessions[sessionId])
  const tags = useOrbital(useShallow((s) => s.tags))
  const contextWindows = useOrbital(useShallow((s) => s.contextWindows))
  const setComposerDraft = useOrbital((s) => s.setComposerDraft)
  const reveal = useCompactionUi((s) => s.reveal === sessionId)
  const setReveal = useCompactionUi((s) => s.setReveal)
  const compacting = session ? compactingOf(session) : null
  const contextWindow = session ? contextWindowFor(session, models, contextWindows) : null
  // The session's one tag, as the map and the header pick it.
  const hue =
    (session && (tags.find((t) => session.tagIds.includes(t.id)) ?? tags.find((t) => t.is_default === 1))?.hue) ??
    undefined
  const live = session?.source === 'web' && session.status !== 'ended'
  const handleCompactAgain = useCallback(() => {
    setComposerDraft(sessionId, '/compact')
    document.querySelector<HTMLTextAreaElement>('[data-composer-well] textarea')?.focus()
  }, [setComposerDraft, sessionId])
  const handleRevealed = useCallback(() => setReveal(null), [setReveal])
  const compaction = useMemo(
    () => ({
      terminal: session?.source === 'terminal',
      contextWindow,
      hue: hue ?? 205,
      onCompactAgain: live ? handleCompactAgain : undefined,
      reveal,
      onRevealed: handleRevealed,
    }),
    [session?.source, contextWindow, hue, live, handleCompactAgain, reveal, handleRevealed],
  )

  // `TranscriptView` resets its own windowing/scroll state off `resetKey`,
  // but "exhausted" is this session's pagination state, not the view's, so
  // it resets here, off the same switch.
  useLayoutEffect(() => {
    setExhausted(false)
  }, [sessionId])

  // Fetches the next page and reports back how many messages it added, so
  // `TranscriptView` can grow its visible window by exactly that many
  // (bounded growth — one scroll to the top reveals that page, not the whole
  // backlog). `loadOlder` itself prepends the fetched messages into the
  // store, which is what actually grows `messages` above. An empty page ends
  // the paging for this session; a failed one (`null`) does not, so the next
  // scroll up tries again. The view guards against overlapping calls.
  const handleLoadOlder = useCallback(async () => {
    const added = await loadOlder(sessionId)
    if (added === null) return null
    if (added.length === 0) setExhausted(true)
    return added.length
  }, [loadOlder, sessionId])

  return (
    <TranscriptView
      messages={messages}
      isWorking={isWorking}
      models={models}
      resetKey={sessionId}
      sessionId={sessionId}
      pendingDecisionId={pendingDecisionId}
      onLoadOlder={handleLoadOlder}
      exhausted={exhausted}
      observerFactory={observerFactory}
      subagents={subagents}
      onOpenSubagent={handleOpenSubagent}
      backgroundTasks={backgroundTasks}
      onOpenTaskOutput={handleOpenTaskOutput}
      compaction={compaction}
      footerKey={compacting ? 'compacting' : undefined}
      footer={
        <>
          {compacting && (
            <CompactingBlock
              startedAt={compacting.startedAt}
              trigger={compacting.trigger}
              preTokens={session?.contextUsedTokens ?? null}
              contextWindow={contextWindow}
            />
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
        </>
      }
    />
  )
}
