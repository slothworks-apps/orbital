import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { recordedFailureFor, useOrbital } from '../store/store'
import type { BackgroundTask, ChatMessage, HarnessEvent, SessionHarness, Subagent } from '../lib/types'
import { harnessEnabled } from '../lib/experimental'
import { withHarnessRows } from '../lib/harnessSession'
import { readHarnessOnce } from './HarnessPill'
import { Button } from '../ui/Button'
import { TranscriptView, pairMessages, type ScrollObserverFactory } from './TranscriptView'
import { CompactingBlock } from './CompactionMark'
import { LimitWaitNotice } from './LimitWaitNotice'
import { compactingOf } from '../lib/compaction'
import { contextWindowFor } from '../lib/models'
import { useCompactionUi } from '../store/compaction'
import { pickRewindTarget, useRewindUi } from '../store/rewind'
import { rewindTargetIds } from '../lib/rewind'

/** Stable empty array — a fresh `[]` fallback on every selector call would
 * defeat `useShallow`'s equality check and re-render on every store tick. */
const NO_SUBAGENTS: Subagent[] = []
const NO_TASKS: BackgroundTask[] = []
const NO_EVENTS: HarnessEvent[] = []

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
  const limitWait = session?.limitWait ?? null
  const contextWindow = session ? contextWindowFor(session, models, contextWindows) : null
  // The session's one tag, as the map and the header pick it.
  const hue =
    (session && (tags.find((t) => session.tagIds.includes(t.id)) ?? tags.find((t) => t.is_default === 1))?.hue) ??
    undefined
  const live = session?.source === 'web' && session.status !== 'ended'
  const handleCompactAgain = useCallback(() => {
    setComposerDraft(sessionId, '/compact')
    document.querySelector<HTMLElement>('[data-composer-field]')?.focus()
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

  // Rewind (spec 2026-09-29-rewind-design): pick mode, the pick held while
  // the stop dialog asks, and the pending rewind's end marker.
  const picking = useRewindUi((s) => s.pick === sessionId)
  const picked = useRewindUi((s) => (s.picked?.sessionId === sessionId ? s.picked : null))
  const sending = useOrbital((s) => Boolean(s.rewindSending[sessionId]))
  const pendingHidden = !sending ? (session?.rewindPending?.hiddenCount ?? null) : null
  const targets = useMemo(
    () => (picking || picked ? rewindTargetIds(messages) : null),
    [picking, picked, messages],
  )
  const handlePick = useCallback(
    (message: ChatMessage, hiddenCount: number) => pickRewindTarget(sessionId, message, hiddenCount),
    [sessionId],
  )
  const rewind = useMemo(
    () =>
      targets
        ? { targets, pickedId: picked?.messageId ?? null, onPick: picked ? undefined : handlePick }
        : undefined,
    [targets, picked, handlePick],
  )

  // The harness in the transcript (canvas 30b): Orbital's messages and the
  // log's events as dashed ◆ rows. The log is read with the harness and paged
  // back as far as the transcript held reaches.
  const harnessOn = useOrbital((s) => harnessEnabled(s.settings))
  const harness = useOrbital((s) => s.harnesses[sessionId])
  const removedHarness = useOrbital((s) => s.harnessRemoved[sessionId])
  const harnessEvents = useOrbital((s) => s.harnessEvents[sessionId] ?? NO_EVENTS)
  const moreEvents = useOrbital((s) => Boolean(s.harnessEventsMore[sessionId]))
  useEffect(() => {
    if (harnessOn && harness === undefined) readHarnessOnce(sessionId)
  }, [harnessOn, harness, sessionId])
  const since = useMemo(() => {
    if (exhausted) return null
    const first = messages.find((m) => m.timestamp)
    return first?.timestamp ? Date.parse(first.timestamp) : null
  }, [messages, exhausted])
  const oldestEventAt = harnessEvents.length > 0 ? harnessEvents[harnessEvents.length - 1].at : null
  useEffect(() => {
    if (moreEvents && oldestEventAt !== null && (since === null || oldestEventAt > since)) {
      void useOrbital.getState().loadOlderHarnessEvents(sessionId)
    }
  }, [moreEvents, oldestEventAt, since, sessionId])
  const shown = useMemo(() => {
    const harnesses = [harness, removedHarness].filter((h): h is SessionHarness => h != null)
    return withHarnessRows(messages, harnessEvents, harnesses, since)
  }, [messages, harnessEvents, harness, removedHarness, since])

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
      messages={shown}
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
      rewind={rewind}
      footerKey={
        compacting
          ? 'compacting'
          : pendingHidden !== null
            ? 'rewind-pending'
            : limitWait
              ? `limit-wait:${limitWait.queued.length}`
              : undefined
      }
      footer={
        <>
          {pendingHidden !== null && (
            // Canvas 27a/27c: where the transcript ends while a rewind is
            // pending — dashed, because nothing is final yet.
            <div
              data-rewind-pending
              className="flex shrink-0 items-center gap-2.5 whitespace-nowrap py-1 font-mono text-[9.5px] tracking-[0.14em] text-[rgba(200,220,245,.75)]"
            >
              <span aria-hidden className="flex-1 border-t border-dashed border-[rgba(150,205,255,.3)]" />
              {pendingHidden} HIDDEN · BACK ON CANCEL
              <span aria-hidden className="flex-1 border-t border-dashed border-[rgba(150,205,255,.3)]" />
            </div>
          )}
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
          {/* Always last, under the agent's final message (31d). */}
          {limitWait && <LimitWaitNotice sessionId={sessionId} wait={limitWait} hue={hue ?? 205} />}
        </>
      }
    />
  )
}
