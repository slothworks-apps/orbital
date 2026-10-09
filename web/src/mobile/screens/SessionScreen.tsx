/*
 * SLOTS — where each feature of spec 2026-10-05-mobile-next lands on this
 * screen. Every slot takes `SlotProps` (`session/slot.ts`: the session and
 * whether the Mac sleeps) and reads anything else from the stores itself, so
 * a feature replaces its own file and never edits this one or the composer.
 * A tail piece also exports a key hook (`SlotKeyProps`, the session possibly
 * not yet there) that `TranscriptTail` folds into the transcript's footerKey.
 *
 *   slot                       file                              filled by
 *   header row 1, after title  session/ContextReadout.tsx        T5.1
 *   header row 1, last         session/SessionMenuButton.tsx     T4.1
 *   header row 2, first        session/StateLine.tsx             F2 (words: stateWords.ts)
 *   header row 2, after state  session/HarnessProgress.tsx       T1.2
 *   header row 2, after that   session/MoonsChip.tsx             T3.1
 *   transcript tail            session/TranscriptTail.tsx        F2: GateCard, LimitNotice, MenuOutcome, divider
 *     gate card + its key      session/GateCard.tsx              T1.1, T1.3 (thumbnails: harness/GateThumbs.tsx)
 *     limit notice + its key   session/LimitNotice.tsx           T5.1
 *     ✓ after End / Clear      menu/MenuOutcome.tsx              T4.1
 *   harness rows               session/harnessRows.ts            F2 (T1.3 adds the cached copy)
 *   tool rows: chips, images   session/TranscriptChip.tsx        Z1, through `PhoneToolRowContext`
 *   path and image presses     files/open.ts (`installFileOpen`) T2.1
 *   composer focus + hint      `focusComposer` (state)           T1.1 calls it on Reopen
 *
 * The model label and the mode dot stay labels (spec "Decided before").
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { sessionModelLabel } from '../../lib/models'
import { isReadOnly, tagColor, type BackgroundTask, type ChatMessage, type Subagent } from '../../lib/types'
import { getSocket } from '../../lib/socket'
import { ReplyMediaSession } from '../../panels/ReplyMedia'
import { PhoneToolRowContext } from '../../panels/ToolRow'
import { TranscriptView } from '../../panels/TranscriptView'
import { useMedia } from '../../store/media'
import { useOrbital, type SessionEvent } from '../../store/store'
import { ModeDot } from '../../ui/ModeDot'
import { notificationId } from '../notify'
import { readTranscriptCache } from '../platform/cache'
import { removeDeliveredNotification } from '../platform/localNotify'
import { ContextReadout } from '../session/ContextReadout'
import { HarnessProgress } from '../session/HarnessProgress'
import { useHarnessRows } from '../session/harnessRows'
import { MoonsChip } from '../session/MoonsChip'
import { SessionMenuButton } from '../session/SessionMenuButton'
import { StateLine } from '../session/StateLine'
import { usePhoneToolRow } from '../session/TranscriptChip'
import { TranscriptTail, useTranscriptTailKey } from '../session/TranscriptTail'
import { isMacAsleep, keepsSelection, useMobile } from '../state'
import { clientRef } from '../transport/clientRef'
import { MobileScreen } from '../ui'
import { WhereLine } from '../where/WhereLine'
import { SessionComposer } from './SessionComposer'

const EMPTY: ChatMessage[] = []
const NO_SUBAGENTS: Subagent[] = []
const NO_TASKS: BackgroundTask[] = []

/** 9b (spec § 5, § 6.1): one session's transcript and its composer. */
export function SessionScreen() {
  const id = useMobile((s) => s.sessionId)
  return id ? <SessionView key={id} id={id} /> : null
}

function SessionView({ id }: { id: string }) {
  const session = useOrbital((s) => s.sessions[id])
  const messages = useOrbital((s) => s.transcripts[id] ?? EMPTY)
  const models = useOrbital((s) => s.models)
  const pendingDecisionId = useOrbital((s) => s.pendingDecisions[id]?.id)
  const tag = useOrbital((s) => (session ? s.tags.find((t) => t.id === session.tagIds[0]) : undefined))
  const select = useOrbital((s) => s.select)
  const loadOlder = useOrbital((s) => s.loadOlder)
  const applySessionEvent = useOrbital((s) => s.applySessionEvent)
  const ready = useMobile((s) => s.ready)
  const offline = useMobile(isMacAsleep)
  const goBack = useMobile((s) => s.goBack)
  const openSubagent = useMobile((s) => s.openSubagent)
  const openTask = useMobile((s) => s.openTask)
  const [exhausted, setExhausted] = useState(false)

  // Open: from the cache while the Mac is away, over the tunnel when it is
  // not (spec § 4). Seated as loaded, so the reconnect's resync replaces it
  // with the Mac's page rather than prepending to it.
  useEffect(() => {
    let live = true
    void (async () => {
      if (!useMobile.getState().ready) {
        const cached = await readTranscriptCache(id)
        if (live && cached && !useOrbital.getState().historyLoaded[id]) {
          useOrbital.setState((s) => ({
            transcripts: { ...s.transcripts, [id]: cached.value },
            historyLoaded: { ...s.historyLoaded, [id]: true },
          }))
        }
      }
      if (live) await select(id)
    })()
    clientRef.seen(id)
    // Its notification, if the shade still holds one, has been read now.
    void removeDeliveredNotification(notificationId(id))
    return () => {
      live = false
      // A subagent, a task or a file pushed over this session keeps it selected:
      // the store would otherwise close the very view being opened (spec
      // 2026-10-05-mobile-next § 3).
      if (keepsSelection(useMobile.getState(), id)) return
      // Leaving drops the held transcript (the store's own rule), so coming back reads the file again.
      useOrbital.setState((s) => (s.ui.selectedId === id ? { ui: { ...s.ui, selectedId: null } } : s))
    }
  }, [id, select])

  useEffect(
    () => getSocket().subscribe(`session:${id}`, (msg: SessionEvent) => applySessionEvent(id, msg)),
    [id, applySessionEvent],
  )

  // Pages of TRANSCRIPT_PAGE_SIZE, "older" as the reader nears the top.
  const handleLoadOlder = useCallback(async () => {
    const added = await loadOlder(id)
    if (added === null) return null
    if (added.length === 0) setExhausted(true)
    return added.length
  }, [loadOlder, id])

  const shown = useHarnessRows(session, messages, exhausted, ready)

  // A transcript chip opens its subagent or task over this session (canvas
  // 10g); a moon without a `toolUseId` has no transcript to open.
  const handleOpenSubagent = useCallback(
    (agent: Subagent) => {
      if (agent.toolUseId) openSubagent({ sessionId: id, toolUseId: agent.toolUseId })
    },
    [openSubagent, id],
  )
  const handleOpenTask = useCallback((task: BackgroundTask) => openTask({ sessionId: id, taskId: task.id }), [openTask, id])

  const tailKey = useTranscriptTailKey({ session, offline })

  // ↩ Show in chat from the media viewer (canvas 24g): page back to the message and scroll to it.
  const jump = useMedia((s) => (s.jump?.sessionId === id ? s.jump : null))
  const jumpTo = useMemo(
    () => (jump ? { messageId: jump.messageId, onDone: () => useMedia.getState().endJump(jump.seq) } : undefined),
    [jump],
  )

  const tagHue = tag ? tagColor(tag.hue) : 'var(--state-neutral)'
  const phoneRows = usePhoneToolRow(id, tagHue, offline)
  const header = (
    <div className="px-1.5 pb-0.5">
      <div className="flex h-13 items-center gap-1">
        <button
          type="button"
          aria-label="Back to sessions"
          onClick={() => goBack()}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-[12px] text-[28px] leading-none text-[rgba(220,235,255,.85)]"
        >
          ‹
        </button>
        <div className="min-w-0 flex-1 pr-2">
          <h1 className="truncate text-[16.5px] font-bold tracking-[-0.01em]">{session?.title || 'Untitled session'}</h1>
          {session && (
            // 9b's cwd · branch line; 2h adds the worktree count, which opens their list.
            <div className="mt-0.5 min-w-0">
              <WhereLine session={session} dotColor={tagHue} variant="header" />
            </div>
          )}
        </div>
        {session && <ContextReadout session={session} offline={offline} />}
        {session && <SessionMenuButton session={session} offline={offline} />}
      </div>
      {session && (
        <div className="flex h-11 min-w-0 items-center gap-0.5 pl-2.5">
          <StateLine session={session} offline={offline} />
          <HarnessProgress session={session} offline={offline} />
          <MoonsChip session={session} offline={offline} />
          <span aria-hidden className="flex-1" />
          {/* The phone reads the model and the mode; switching either stays on the Mac for now. */}
          {(session.model || session.resolvedModel) && (
            <span className="mx-1.5 flex h-7 min-w-0 items-center rounded-[6px] border border-[rgba(150,205,255,.2)] px-[9px] font-mono text-[11px] text-text-bright">
              <span className="truncate">{sessionModelLabel(session, models)}</span>
            </span>
          )}
          {session.permissionMode && (
            <span
              role="img"
              aria-label={`Permission mode ${session.permissionMode}`}
              className="mx-2 grid h-7 w-7 shrink-0 place-items-center rounded-[6px] border border-[rgba(150,205,255,.2)]"
            >
              <ModeDot mode={session.permissionMode} size={8} />
            </span>
          )}
        </div>
      )}
    </div>
  )

  return (
    // No footer until the row exists: 9d opens a session before its upsert lands,
    // and a footer then would flash the terminal line.
    <MobileScreen header={header} footer={session ? <SessionComposer id={id} /> : undefined} scroll={false}>
      {/* The phone's tool rows: 10g's chips, 10d's wide image results. */}
      <PhoneToolRowContext.Provider value={phoneRows}>
      {/* Reply thumbnails read named files through this session (canvas 24f A, 24g). */}
      <ReplyMediaSession.Provider value={id}>
      <TranscriptView
        messages={shown}
        jumpTo={jumpTo}
        isWorking={!offline && session?.status === 'working'}
        models={models}
        resetKey={id}
        sessionId={id}
        surface="phone"
        // The parked tool call is lifted out of its run and drawn as its card (§ 6.3).
        pendingDecisionId={pendingDecisionId}
        onLoadOlder={ready ? handleLoadOlder : undefined}
        exhausted={exhausted}
        // An Orbital session's cards answer; a terminal session's say where to (§ 6.3).
        readOnly={session ? isReadOnly(session) : true}
        subagents={session?.subagents ?? NO_SUBAGENTS}
        onOpenSubagent={handleOpenSubagent}
        backgroundTasks={session?.backgroundTasks ?? NO_TASKS}
        onOpenTaskOutput={handleOpenTask}
        footer={session ? <TranscriptTail session={session} offline={offline} /> : undefined}
        footerKey={tailKey}
      />
      </ReplyMediaSession.Provider>
      </PhoneToolRowContext.Provider>
    </MobileScreen>
  )
}
