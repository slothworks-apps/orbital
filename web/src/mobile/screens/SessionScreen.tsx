import { useCallback, useEffect, useState } from 'react'
import { getSocket } from '../../lib/socket'
import { stateColor } from '../../lib/stateStyle'
import { isReadOnly, sessionStateKey, tagColor, type ChatMessage } from '../../lib/types'
import { useNow } from '../../lib/useNow'
import { TranscriptView } from '../../panels/TranscriptView'
import { useOrbital, type SessionEvent } from '../../store/store'
import { CLOCK_TICK_MS } from '../constants'
import { basename } from '../format'
import { readTranscriptCache } from '../platform/cache'
import { stateLine } from '../sessionList'
import { useMobile } from '../state'
import { clientRef } from '../transport/clientRef'
import { MobileScreen } from '../ui'
import { Glyph } from './Glyph'

const EMPTY: ChatMessage[] = []

/** 9b (spec § 5): one session's transcript, read-only in 2a. */
export function SessionScreen() {
  const id = useMobile((s) => s.sessionId)
  return id ? <SessionView key={id} id={id} /> : null
}

function SessionView({ id }: { id: string }) {
  const session = useOrbital((s) => s.sessions[id])
  const messages = useOrbital((s) => s.transcripts[id] ?? EMPTY)
  const models = useOrbital((s) => s.models)
  const tag = useOrbital((s) => (session ? s.tags.find((t) => t.id === session.tagIds[0]) : undefined))
  const select = useOrbital((s) => s.select)
  const loadOlder = useOrbital((s) => s.loadOlder)
  const applySessionEvent = useOrbital((s) => s.applySessionEvent)
  const ready = useMobile((s) => s.ready)
  const asOf = useMobile((s) => s.asOf)
  const goBack = useMobile((s) => s.goBack)
  const [exhausted, setExhausted] = useState(false)
  const offline = !ready
  const now = useNow(offline, CLOCK_TICK_MS)

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
  const header = (
    <div className="pb-1.5 pt-1">
      <div className="flex items-center gap-1 pr-4">
        <button type="button" aria-label="Back" onClick={() => goBack()} className="min-h-11 min-w-11 text-[22px] text-text-soft">
          ‹
        </button>
        <h1 className="min-w-0 flex-1 truncate text-[16px] font-semibold">{session?.title || 'Untitled session'}</h1>
        {session && key && (
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] tracking-[0.1em]" style={{ color: stateColor(key) }}>
            <Glyph session={session} offline={offline} />
            {stateLine(key, offline, asOf, now)}
          </span>
        )}
      </div>
      {session && (
        <div className="flex min-w-0 items-center gap-2 pl-11 pr-4 font-mono text-[11px] text-text-muted">
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tag ? tagColor(tag.hue) : 'var(--state-neutral)' }} />
          <span className="truncate">{basename(session.cwd)}</span>
          {session.git && <span className="truncate">⎇ {session.git.ref}</span>}
        </div>
      )}
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

  // The composer's place: 9p's line for a terminal session; nothing for an Orbital one until 2b.
  const footer =
    session && isReadOnly(session) ? (
      <div className="border-t border-panel-border px-4 py-3 text-center font-mono text-[11px] text-text-muted">
        terminal session · no composer
      </div>
    ) : undefined

  return (
    <MobileScreen header={header} footer={footer} scroll={false}>
      <TranscriptView
        messages={messages}
        isWorking={!offline && session?.status === 'working'}
        models={models}
        resetKey={id}
        sessionId={id}
        onLoadOlder={ready ? handleLoadOlder : undefined}
        exhausted={exhausted}
        readOnly
        footer={divider}
        footerKey={offline ? 'offline' : 'live'}
      />
    </MobileScreen>
  )
}
