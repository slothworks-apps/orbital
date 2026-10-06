import { useCallback, useEffect, useState } from 'react'
import { getSocket } from '../../lib/socket'
import { timeAgo } from '../../lib/format'
import { sessionModelLabel } from '../../lib/models'
import { stateColor } from '../../lib/stateStyle'
import { isReadOnly, sessionStateKey, tagColor, type ChatMessage } from '../../lib/types'
import { useNow } from '../../lib/useNow'
import { TranscriptView } from '../../panels/TranscriptView'
import { useOrbital, type SessionEvent } from '../../store/store'
import { ModeDot } from '../../ui/ModeDot'
import { CLOCK_TICK_MS } from '../constants'
import { notificationId } from '../notify'
import { basename } from '../format'
import { readTranscriptCache } from '../platform/cache'
import { removeDeliveredNotification } from '../platform/localNotify'
import { stateLine } from '../sessionList'
import { isMacAsleep, useMobile } from '../state'
import { clientRef } from '../transport/clientRef'
import { MobileScreen } from '../ui'
import { Glyph } from './Glyph'
import { HarnessStrip } from './HarnessStrip'
import { SessionComposer } from './SessionComposer'

const EMPTY: ChatMessage[] = []

/** 9b's header draws at most this many moons before the count. */
const MOONS_SHOWN = 3

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
  const asOf = useMobile((s) => s.asOf)
  const offline = useMobile(isMacAsleep)
  const goBack = useMobile((s) => s.goBack)
  const [exhausted, setExhausted] = useState(false)
  const now = useNow(true, CLOCK_TICK_MS)

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

  const key = session ? sessionStateKey(session) : null
  const tagHue = tag ? tagColor(tag.hue) : 'var(--state-neutral)'
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
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 whitespace-nowrap font-mono text-[10.5px] text-[rgba(160,190,225,.65)]">
              <span aria-hidden className="block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tagHue }} />
              <span className="shrink-0">{basename(session.cwd)}</span>
              {session.git && <span className="truncate">· ⎇ {session.git.ref}</span>}
            </div>
          )}
        </div>
      </div>
      {session && key && (
        <div className="flex h-11 min-w-0 items-center gap-0.5 pl-2.5">
          <span
            className="flex shrink-0 items-center gap-[7px] pr-2.5 font-mono text-[10.5px] tracking-[0.1em]"
            style={{ color: stateColor(key) }}
          >
            <Glyph session={session} offline={offline} />
            {stateLine(key, offline, asOf, now)}
            {/* Live, the last activity; offline, the state line already says when. */}
            {!offline && session.lastAt !== null && <span>· {timeAgo(session.lastAt, now)}</span>}
          </span>
          {session.subagents.length > 0 && (
            <span
              aria-label={`${session.subagents.length} ${session.subagents.length === 1 ? 'subagent' : 'subagents'}`}
              className="flex shrink-0 items-center gap-[5px] px-2 font-mono text-[10.5px] text-[rgba(200,220,245,.75)]"
            >
              {session.subagents.slice(0, MOONS_SHOWN).map((agent) => (
                <span
                  key={agent.id}
                  aria-hidden
                  className={[
                    'block h-2 w-2 rounded-full border bg-[oklch(30%_.05_220)]',
                    !offline && agent.state !== 'ended' ? 'orbital-pulse' : '',
                  ].join(' ')}
                  style={{ borderColor: tagHue }}
                />
              ))}
              {session.subagents.length}
            </span>
          )}
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
      {!offline && <HarnessStrip sessionId={id} />}
    </div>
  )

  // Where the data ends while the Mac sleeps (9b offline).
  const divider = offline ? (
    <div className="my-4 flex items-center gap-3 font-mono text-[10px] tracking-[0.14em] text-text-muted">
      <span className="h-px flex-1 bg-panel-border" />
      <span>NOTHING NEWER · MAC ASLEEP</span>
      <span className="h-px flex-1 bg-panel-border" />
    </div>
  ) : undefined

  return (
    // No footer until the row exists: 9d opens a session before its upsert lands,
    // and a footer then would flash the terminal line.
    <MobileScreen header={header} footer={session ? <SessionComposer id={id} /> : undefined} scroll={false}>
      <TranscriptView
        messages={messages}
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
        footer={divider}
        footerKey={offline ? 'offline' : 'live'}
      />
    </MobileScreen>
  )
}
