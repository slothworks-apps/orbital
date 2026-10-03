import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useOrbital, parseSidebarWidth } from '../store/store'
import { api } from '../lib/api'
import type { HarnessEvent, SessionHarness } from '../lib/types'
import { useViewportWidth } from '../lib/useViewportWidth'
import { Panel, WINDOW_STRIP_INSET_PX } from '../ui/Panel'
import { useEscapeLayer } from '../ui/escapeLayer'
import { BackToSession, type SubagentPanelProps } from './SubagentPanel'
import { goBackToStep, somethingRuns } from './harness/actions'
import { GoBackDialog } from './harness/dialogs'
import { FullWindow } from './harness/FullWindow'
import { HarnessBody, navBack, type HarnessNav } from './harness/HarnessBody'
import { CloseGlyph, DashedSeam, HeadButton, type Chrome } from './harness/parts'
import { StartView } from './harness/StartView'

/** The docked panels' inset from the viewport edge, and the collapsed rail's width (canvas 30h: "88 · steps …"). */
const EDGE_PX = 16
const RAIL_PX = 56

/**
 * The full window's frame (canvas 30h): the harness takes the main area —
 * everything right of the sidebar — or the whole detached window. Portalled,
 * so no docked panel's stacking context can hold it under the others.
 */
function FullFrame({ inWindow, children }: { inWindow: boolean; children: ReactNode }) {
  const viewportWidth = useViewportWidth()
  const sidebarPx = useOrbital((s) => (s.ui.sidebarCollapsed ? RAIL_PX : parseSidebarWidth(s.settings, viewportWidth)))
  const frame = inWindow
    ? 'fixed inset-0 bg-space bg-[image:linear-gradient(180deg,rgba(10,15,27,.92),rgba(5,8,16,.95))]'
    : // Opaque under the gradient: the frame covers the docked panels, which must not show through.
      'fixed rounded-[14px] border border-[rgba(150,205,255,.12)] bg-space bg-[image:linear-gradient(180deg,rgba(10,15,27,.92),rgba(5,8,16,.95))]'
  return createPortal(
    <div
      role="region"
      aria-label="Harness, full window"
      className={`${frame} z-30 overflow-hidden font-sans text-text-bright`}
      style={inWindow ? undefined : { left: EDGE_PX + sidebarPx + EDGE_PX, right: EDGE_PX, top: EDGE_PX, bottom: EDGE_PX }}
    >
      {!inWindow && <DashedSeam />}
      {children}
    </div>,
    document.body,
  )
}

/** The header row's frame for the slot (30b), as the subagent panel draws its own (11b, 22b, 25b). */
function slotChrome({ inWindow, swap, back, close }: { inWindow: boolean; swap: boolean; back: ReactNode; close: ReactNode }): Chrome {
  return {
    inWindow,
    close: swap ? null : close,
    swapStrip: swap ? (
      <div
        className="orbital-drag-region -mx-[18px] -mt-4 flex h-10 items-center gap-2.5 pr-[18px] pt-3"
        style={{ paddingLeft: WINDOW_STRIP_INSET_PX }}
      >
        {back}
      </div>
    ) : null,
    row: (children) => (
      <div
        className={[
          'flex items-center gap-2',
          swap ? 'mt-3' : inWindow ? 'orbital-drag-region -mx-[18px] -mt-4 h-[38px] px-[18px] pt-4' : 'h-[22px]',
        ].join(' ')}
      >
        {children}
      </div>
    ),
  }
}

function HarnessSlot({
  sessionId,
  widthPx,
  inWindow,
  swap,
}: {
  sessionId: string
  widthPx: number
  inWindow: boolean
  swap: boolean
}) {
  const close = useOrbital((s) => s.closeHarness)
  const session = useOrbital((s) => s.sessions[sessionId])
  const harness = useOrbital((s) => s.harnesses[sessionId])
  const events = useOrbital((s) => s.harnessEvents[sessionId]) ?? NO_EVENTS
  const [nav, setNav] = useState<HarnessNav>({ kind: 'list' })
  const [full, setFull] = useState(() => useOrbital.getState().harnessPanel?.full === true)
  const [goingBack, setGoingBack] = useState<number | null>(null)

  // ⎋ peels one layer at a time: the full window, the diff, the record, then the panel.
  useEscapeLayer(true, () => {
    if (full) return setFull(false)
    const back = navBack(nav)
    if (back) return setNav(back)
    close()
  })

  const chrome = slotChrome({
    inWindow,
    swap,
    back: <BackToSession parent={session} onBack={close} />,
    close: (
      <HeadButton label="Close the harness panel" onClick={close}>
        <CloseGlyph />
      </HeadButton>
    ),
  })

  const live = harness ?? null
  const goBack = (index: number) => setGoingBack(index)

  return (
    <Panel side={swap ? 'right' : 'subagent'} widthPx={widthPx} fill={inWindow} className="relative flex h-full flex-col overflow-hidden">
      {!swap && <DashedSeam />}
      {harness === undefined ? null : live === null ? (
        <StartView sessionId={sessionId} chrome={chrome} />
      ) : (
        <HarnessBody
          sessionId={sessionId}
          harness={live}
          events={events}
          chrome={chrome}
          readOnly={false}
          nav={nav}
          setNav={setNav}
          onFull={() => setFull(true)}
          onGoBack={goBack}
        />
      )}
      {live && full && (
        <FullFrame inWindow={inWindow}>
          <FullWindow
            sessionId={sessionId}
            harness={live}
            events={events}
            sessionTitle={session?.title || 'session'}
            initialPick={nav.kind === 'list' ? null : nav.index}
            onExit={() => setFull(false)}
            onGoBack={goBack}
            inWindow={inWindow}
          />
        </FullFrame>
      )}
      {live && (
        <GoBackDialog
          harness={live}
          index={goingBack}
          running={goingBack !== null && somethingRuns(sessionId)}
          onClose={() => setGoingBack(null)}
          onConfirm={() => {
            const index = goingBack
            setGoingBack(null)
            if (index === null) return
            const state = live.state[index]
            setFull(false)
            setNav({ kind: 'list' })
            if (state) void goBackToStep(sessionId, index, state)
          }}
        />
      )}
    </Panel>
  )
}

const NO_EVENTS: HarnessEvent[] = []

/**
 * The session's harness in the side slot (canvas `Feature - Harness` 30b–30h;
 * spec 2026-10-02-harness-redesign-design): the start view, the running
 * checklist, a step's record and diff, and the full window. The subagent
 * panel's slot and shell (11a); renders nothing while `store.harnessPanel`
 * is null.
 */
export function HarnessPanel({ widthPx, inWindow: inWindowProp = false, swap = false }: SubagentPanelProps) {
  const view = useOrbital((s) => s.harnessPanel)
  if (!view) return null
  return <HarnessSlot key={view.sessionId} sessionId={view.sessionId} widthPx={widthPx} inWindow={inWindowProp || swap} swap={swap} />
}

/**
 * A session's harness record, read-only — for session stats → Harness, where
 * a removed harness stays readable (spec § 6; canvas 30b's Remove dialog:
 * "You can still read them from session stats → Harness"). Fetches its own
 * copy: the live harness if there is one, else the removed one. Fills the
 * column its caller gives it; ⎋ walks back from a diff or a record.
 */
export function HarnessRecordView({ sessionId, onClose }: { sessionId: string; onClose?: () => void }) {
  const [data, setData] = useState<{ sessionId: string; harness: SessionHarness | null; events: HarnessEvent[] } | null>(null)
  const [nav, setNav] = useState<HarnessNav>({ kind: 'list' })
  const [full, setFull] = useState(false)
  // Live updates matter here too: a harness still running moves on while it is read.
  const revision = useOrbital((s) => s.harnesses[sessionId])

  useEffect(() => {
    let current = true
    api
      .getSessionHarness(sessionId, { limit: 2000 })
      .then(({ harness, removed, events }) => current && setData({ sessionId, harness: harness ?? removed, events }))
      .catch(() => current && setData({ sessionId, harness: null, events: [] }))
    return () => {
      current = false
    }
  }, [sessionId, revision])

  useEscapeLayer(full || nav.kind !== 'list', () => {
    if (full) return setFull(false)
    const back = navBack(nav)
    if (back) setNav(back)
  })

  const harness = data?.sessionId === sessionId ? data.harness : undefined
  if (!harness || !data) {
    return harness === null ? <div className="p-4 text-[12px] text-[rgba(160,190,225,.6)]">This session has no harness record.</div> : null
  }
  const chrome: Chrome = {
    inWindow: false,
    swapStrip: null,
    close: onClose ? (
      <HeadButton label="Close" onClick={onClose}>
        <CloseGlyph />
      </HeadButton>
    ) : null,
    row: (children) => <div className="flex h-[22px] items-center gap-2">{children}</div>,
  }
  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <HarnessBody
        sessionId={sessionId}
        harness={harness}
        events={data.events}
        chrome={chrome}
        readOnly={harness.removedAt !== null}
        nav={nav}
        setNav={setNav}
        onFull={() => setFull(true)}
        onGoBack={null}
      />
      {full && (
        <FullFrame inWindow={false}>
          <FullWindow
            sessionId={sessionId}
            harness={harness}
            events={data.events}
            sessionTitle="session stats"
            initialPick={nav.kind === 'list' ? null : nav.index}
            onExit={() => setFull(false)}
            onGoBack={null}
          />
        </FullFrame>
      )}
    </div>
  )
}
