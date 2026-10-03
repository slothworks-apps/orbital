import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import {
  mapStatePills,
  parseContextThresholds,
  showCompactBadge,
  showTrash,
  trashDropFor,
  useOrbital,
} from '../../store/store'
import { sendCompactAware, useCompactionUi } from '../../store/compaction'
import {
  gateWaits,
  isReadOnly,
  sessionStateKey,
  statePill,
  type PendingDecision,
  type SessionStateKey,
  type Subagent,
} from '../../lib/types'
import { stateColor, stateDot } from '../../lib/stateStyle'
import { decisionHeadline } from '../../lib/decisionCard'
import { contextLevelOklch, oklchCss, CONTEXT_CRITICAL_OKLCH } from '../../lib/usage'
import { reportError } from '../../lib/errors'
import { useNow } from '../../lib/useNow'
import { useDocumentHidden, useWindowFocused } from '../../lib/useWindowFocused'
import { StateDot } from '../../ui/StateDot'
import { useSceneModel } from '../useSceneModel'
import type { ScenePlanet } from '../sceneModel'
import { COMPACT_COMMAND } from '../Planet'
import { MapShell, useMapInsets } from '../shell/MapShell'
import { anchorForMatMove, cardOrder, matDropSlot, matOrder } from './order'

const DRAG_THRESHOLD_PX = 3
/** Canvas `Feature - Desk theme` 41a: mats are 336 px wide, 14 px apart. */
const MAT_WIDTH_PX = 336
const MAT_GAP_PX = 14
const STRIP_WINDOW_MS = 120_000

/** 41a/41b surfaces: panel glass for the mat, one step brighter for the card. */
const MAT_GLASS = 'linear-gradient(180deg,rgba(14,20,34,.6),rgba(8,12,22,.68))'
const MAT_LIFTED = 'linear-gradient(180deg,rgb(16,23,38),rgb(10,14,25))'
const CARD_GLASS = 'linear-gradient(180deg,rgba(16,24,40,.72),rgba(9,14,26,.78))'
const CARD_LIFTED = 'linear-gradient(180deg,rgb(17,25,41),rgb(10,15,27))'
const LIFTED_BORDER = 'rgba(150,205,255,.32)'
const INSET_LIGHT = 'inset 0 1px 0 rgba(255,255,255,.04)'
const ACCENT = 'oklch(85% .12 205)'

const tagInk = (hue: number, alpha?: number) =>
  `oklch(80% .13 ${hue}${alpha === undefined ? '' : ` / ${alpha}`})`

type Drag =
  | {
      kind: 'card'
      id: string
      pointerId: number
      startX: number
      startY: number
      moved: boolean
      dx: number
      dy: number
    }
  | {
      kind: 'mat'
      tagId: number
      pointerId: number
      startX: number
      startY: number
      moved: boolean
      dx: number
    }

/**
 * The Desk theme (spec 2026-10-01-map-themes-design § 4, canvas `Feature -
 * Desk theme` 41a–41e): one mat per tag cluster, ordered by the tag anchors
 * the map stores (ADR `desk-mats-order-by-tag-anchors`); one card per
 * session, in a stable order; a history drawer to drop a card in. No camera —
 * the desk scrolls sideways. The only continuous motion is the tool strip.
 */
export function DeskMap() {
  const model = useSceneModel()
  const settings = useOrbital((s) => s.settings)
  const select = useOrbital((s) => s.select)
  const trashSession = useOrbital((s) => s.trashSession)
  const setTagAnchor = useOrbital((s) => s.setTagAnchor)
  const revealHistory = useOrbital((s) => s.revealHistory)
  const setDialog = useOrbital((s) => s.setDialog)
  const selectedId = useOrbital((s) => s.ui.selectedId)
  const { insets } = useMapInsets()
  const focused = useWindowFocused(true)
  const hidden = useDocumentHidden()
  const paused = !focused || hidden

  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const [drop, setDrop] = useState<DrawerState>('resting')
  const [confirmEndId, setConfirmEndId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const drawerRef = useRef<HTMLButtonElement>(null)

  const mats = useMemo(() => {
    const byTag = new Map<number, ScenePlanet[]>()
    for (const p of model.planets) byTag.set(p.tagId, [...(byTag.get(p.tagId) ?? []), p])
    return matOrder(model.anchors.filter((a) => byTag.has(a.tagId))).map((a) => ({
      anchor: a,
      label: model.labels.find((l) => l.tagId === a.tagId)?.text ?? '',
      cards: cardOrder(byTag.get(a.tagId)!),
    }))
  }, [model])

  const selectSession = useCallback(
    (id: string) => {
      const { subagentPanel, taskOutput, closeSubagent, closeTaskOutput } = useOrbital.getState()
      if (subagentPanel) closeSubagent()
      if (taskOutput) closeTaskOutput()
      void select(id)
    },
    [select],
  )

  // ⌘F on the desk brings the selected card into view; there is no camera to fit.
  const fit = useCallback(() => {
    const id = useOrbital.getState().ui.selectedId
    const card = id ? scrollRef.current?.querySelector(`[data-card="${CSS.escape(id)}"]`) : null
    card?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [])

  useEffect(() => {
    if (selectedId) fit()
  }, [selectedId, fit])

  const dropAt = useCallback((id: string, x: number, y: number): DrawerState => {
    const r = drawerRef.current?.getBoundingClientRect()
    if (!r) return 'resting'
    const inside = x > r.left - 24 && x < r.right + 24 && y > r.top - 24 && y < r.bottom + 24
    if (!inside) return 'eligible'
    const s = useOrbital.getState().sessions[id]
    return s && trashDropFor(s.source, s.status) === 'refuse' ? 'refused' : 'armed'
  }, [])

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const target = e.target as Element
    if (target.closest('button, input, a')) return
    const base = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false }
    const mat = target.closest<HTMLElement>('[data-mat-handle]')
    if (mat) {
      dragRef.current = { kind: 'mat', tagId: Number(mat.dataset.matHandle), dx: 0, ...base }
      return
    }
    const card = target.closest<HTMLElement>('[data-card]')
    if (card) dragRef.current = { kind: 'card', id: card.dataset.card!, dx: 0, dy: 0, ...base }
  }, [])

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = dragRef.current
      if (!d || d.pointerId !== e.pointerId) return
      if (!d.moved) {
        if (
          Math.abs(e.clientX - d.startX) < DRAG_THRESHOLD_PX &&
          Math.abs(e.clientY - d.startY) < DRAG_THRESHOLD_PX
        )
          return
        d.moved = true
        e.currentTarget.setPointerCapture(e.pointerId)
      }
      d.dx = e.clientX - d.startX
      if (d.kind === 'card') {
        d.dy = e.clientY - d.startY
        setDrop(dropAt(d.id, e.clientX, e.clientY))
      }
      setDrag({ ...d })
    },
    [dropAt],
  )

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = dragRef.current
      if (!d || d.pointerId !== e.pointerId) return
      dragRef.current = null
      setDrag(null)
      setDrop('resting')
      if (d.moved) e.currentTarget.releasePointerCapture(e.pointerId)
      if (!d.moved) {
        if (d.kind === 'card') selectSession(d.id)
        return
      }
      if (d.kind === 'card') {
        if (dropAt(d.id, e.clientX, e.clientY) !== 'armed') return
        const s = useOrbital.getState().sessions[d.id]
        if (!s) return
        const how = trashDropFor(s.source, s.status)
        if (how === 'end')
          trashSession(d.id, { undo: true }).catch((err: unknown) =>
            reportError(err, 'Failed to end the session'),
          )
        else if (how === 'confirm') setConfirmEndId(d.id)
        return
      }
      const ordered = mats.map((m) => m.anchor)
      const from = ordered.findIndex((a) => a.tagId === d.tagId)
      const landing = matDropSlot(from, d.dx, ordered.length, MAT_WIDTH_PX + MAT_GAP_PX)
      const next = landing && anchorForMatMove(ordered, from, landing.to)
      if (next) void setTagAnchor(d.tagId, next)
    },
    [dropAt, mats, selectSession, setTagAnchor, trashSession],
  )

  const statePills = mapStatePills(settings)
  const compactBadge = showCompactBadge(settings)
  const thresholds = parseContextThresholds(settings)
  const trash = showTrash(settings)
  const historyCount = model.hole.count

  // A lifted mat leaves the row and follows the pointer; a dashed placeholder
  // stands where it would land (41a, "mat drag").
  const matDrag = drag?.kind === 'mat' && drag.moved ? drag : null
  const liftedFrom = matDrag ? mats.findIndex((m) => m.anchor.tagId === matDrag.tagId) : -1
  const landing = matDrag
    ? matDropSlot(liftedFrom, matDrag.dx, mats.length, MAT_WIDTH_PX + MAT_GAP_PX)
    : null
  const row: Array<(typeof mats)[number] | 'placeholder'> = matDrag
    ? mats.filter((_, i) => i !== liftedFrom)
    : mats
  if (matDrag) row.splice(landing ? landing.slot : liftedFrom, 0, 'placeholder')

  return (
    <div
      data-testid="map-surface"
      data-paused={paused ? '' : undefined}
      className="relative h-full w-full overflow-hidden bg-[#05070d]"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={(e) => {
        if (e.target === e.currentTarget || (e.target as Element).hasAttribute('data-desk-floor'))
          useOrbital.setState((s) => (s.ui.selectedId ? { ui: { ...s.ui, selectedId: null } } : s))
      }}
    >
      {/* 41a floor: a faint nebula and no stars — stars belong to Planets. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 620px 420px at 28% 38%,rgba(110,80,220,.11),transparent),radial-gradient(ellipse 760px 520px at 74% 68%,rgba(40,170,220,.07),transparent)',
        }}
      />
      <div
        ref={scrollRef}
        data-desk-floor
        className="absolute inset-y-0 left-0 overflow-x-auto overflow-y-hidden transition-[right] duration-[420ms] ease-[cubic-bezier(.2,.8,.2,1)]"
        style={{
          right: insets.right,
          paddingLeft: insets.left,
          paddingRight: 24,
          paddingTop: insets.top + 68,
          paddingBottom: 88,
        }}
      >
        <div
          data-desk-floor
          className="relative flex h-full items-stretch"
          style={{ gap: MAT_GAP_PX }}
        >
          {row.map((m) =>
            m === 'placeholder' ? (
              <div
                key="placeholder"
                aria-hidden
                className="shrink-0 rounded-[14px] border border-dashed border-[rgba(150,205,255,.32)] bg-[rgba(150,205,255,.03)]"
                style={{ width: MAT_WIDTH_PX }}
              />
            ) : (
              <Mat
                key={m.anchor.tagId}
                mat={m}
                statePills={statePills}
                compactBadge={compactBadge}
                thresholds={thresholds}
                cardDrag={drag?.kind === 'card' && drag.moved ? drag : null}
                onSelect={selectSession}
              />
            ),
          )}
          {matDrag && liftedFrom >= 0 && (
            <Mat
              key={mats[liftedFrom].anchor.tagId}
              mat={mats[liftedFrom]}
              statePills={statePills}
              compactBadge={compactBadge}
              thresholds={thresholds}
              cardDrag={null}
              onSelect={selectSession}
              liftedLeft={liftedFrom * (MAT_WIDTH_PX + MAT_GAP_PX) + matDrag.dx}
            />
          )}
        </div>
      </div>

      {trash && (
        <HistoryDrawer
          ref={drawerRef}
          state={drag?.kind === 'card' && drag.moved ? drop : 'resting'}
          count={historyCount}
          left={insets.left}
          onClick={() => revealHistory()}
        />
      )}

      <MapShell
        model={model}
        camera={{ x: 0, y: 0, zoom: 60 }}
        showZoomColumn={false}
        showCameraReadout={false}
        onFit={fit}
        onNewSession={() => setDialog('new')}
        onErrorsClick={() => setDialog('errors')}
        confirmEndId={confirmEndId}
        onConfirmEndClose={() => setConfirmEndId(null)}
        onConfirmEnd={(id) => trashSession(id, { undo: false })}
      />
    </div>
  )
}

interface MatData {
  anchor: { tagId: number; hue: number }
  label: string
  cards: ScenePlanet[]
}

function Mat({
  mat,
  statePills,
  compactBadge,
  thresholds,
  cardDrag,
  onSelect,
  liftedLeft,
}: {
  mat: MatData
  statePills: 'dot' | 'label'
  compactBadge: boolean
  thresholds: { warn: number; critical: number }
  cardDrag: { id: string; dx: number; dy: number } | null
  onSelect: (id: string) => void
  /** Set while the mat is being dragged: its x within the row. */
  liftedLeft?: number
}) {
  const lifted = liftedLeft !== undefined
  return (
    <section
      className={[
        'flex shrink-0 flex-col rounded-[14px] border backdrop-blur-[18px]',
        lifted ? 'absolute inset-y-0 z-20 cursor-grabbing' : '',
      ].join(' ')}
      style={{
        width: MAT_WIDTH_PX,
        left: liftedLeft,
        transform: lifted ? 'translateY(-8px)' : undefined,
        background: lifted ? MAT_LIFTED : MAT_GLASS,
        borderColor: lifted ? LIFTED_BORDER : 'rgba(150,205,255,.1)',
        boxShadow: lifted
          ? '0 30px 70px rgba(0,0,0,.65),0 0 0 1px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.07)'
          : INSET_LIGHT,
      }}
    >
      <MatHeader
        tagId={mat.anchor.tagId}
        hue={mat.anchor.hue}
        label={mat.label}
        cards={mat.cards}
      />
      <MatBody>
        {mat.cards.map((p) => (
          <DeskCard
            key={p.session.id}
            planet={p}
            statePills={statePills}
            compactBadge={compactBadge}
            thresholds={thresholds}
            lift={
              cardDrag && cardDrag.id === p.session.id ? { x: cardDrag.dx, y: cardDrag.dy } : null
            }
            onSelect={onSelect}
          />
        ))}
      </MatBody>
    </section>
  )
}

/** The mat's card column: scrolls on its own, and fades its bottom edge while more cards wait below (41a). */
function MatBody({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState(false)
  const measure = useCallback(() => {
    const el = ref.current
    if (el) setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 1)
  }, [])
  useLayoutEffect(() => {
    measure()
    if (typeof ResizeObserver === 'undefined' || !ref.current) return
    const ro = new ResizeObserver(measure)
    ro.observe(ref.current)
    for (const child of Array.from(ref.current.children)) ro.observe(child)
    return () => ro.disconnect()
  })
  const fade = more ? 'linear-gradient(180deg,#000 calc(100% - 56px),transparent)' : undefined
  return (
    <div
      ref={ref}
      data-desk-floor
      onScroll={measure}
      className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3 [scrollbar-width:none]"
      style={{ maskImage: fade, WebkitMaskImage: fade }}
    >
      {children}
    </div>
  )
}

/** A count's glyph in the mat header: the state's dot shape, held steady (41c). */
function countDot(key: SessionStateKey) {
  const d = stateDot(key, 'dot')
  return { shape: d.shape === 'none' ? ('solid' as const) : d.shape, motion: 'steady' as const }
}

function MatHeader({
  tagId,
  hue,
  label,
  cards,
}: {
  tagId: number
  hue: number
  label: string
  cards: ScenePlanet[]
}) {
  const counts = useMemo(() => {
    const c: Partial<Record<SessionStateKey, number>> = {}
    for (const p of cards) {
      const k = sessionStateKey(p.session)
      c[k] = (c[k] ?? 0) + 1
    }
    return (['needs_input', 'working', 'waiting', 'done', 'interrupted'] as const)
      .filter((k) => c[k])
      .map((k) => ({ k, n: c[k]! }))
  }, [cards])
  // The scene label reads `NAME · N`; the canvas sets the count in muted ink.
  const [name, count] = label.split(' · ')
  return (
    <header
      data-mat-handle={tagId}
      title="Drag to reorder"
      className="flex h-[42px] flex-none cursor-grab items-center gap-[9px] rounded-t-[14px] border-b border-[rgba(150,205,255,.08)] pl-2.5 pr-3.5 select-none hover:bg-[rgba(150,205,255,.035)] active:cursor-grabbing"
    >
      <span
        aria-hidden
        className="block h-3 w-2 flex-none opacity-70"
        style={{
          backgroundImage: 'radial-gradient(circle,rgba(160,190,225,.6) 0 1px,transparent 1.3px)',
          backgroundSize: '4px 4px',
        }}
      />
      <span
        className="block h-[7px] w-[7px] flex-none rounded-full"
        style={{ background: tagInk(hue) }}
      />
      <span className="font-mono text-[10.5px] tracking-[0.2em]" style={{ color: tagInk(hue) }}>
        {name}
      </span>
      {count && (
        <span className="font-mono text-[10.5px] tracking-[0.1em] text-[rgba(160,190,225,.55)]">
          · {count}
        </span>
      )}
      <span className="ml-auto flex items-center gap-2.5">
        {counts.map(({ k, n }) => (
          <span
            key={k}
            title={`${n} ${k.replace('_', ' ')}`}
            className="flex items-center gap-[5px] font-mono text-[10.5px] text-[rgba(214,230,248,.8)]"
          >
            <StateDot dot={countDot(k)} color={stateColor(k)} solidPx={6} hollowPx={6} />
            {n}
          </span>
        ))}
      </span>
    </header>
  )
}

function compactSession(id: string) {
  const state = useOrbital.getState()
  const session = state.sessions[id]
  if (!session || isReadOnly(session) || state.pendingDecisions[id] || session.compacting) return
  sendCompactAware(id, COMPACT_COMMAND)
}

/** 41c tool strip: kind told by height and shape, never by hue. */
const TICK: Record<'edit' | 'bash' | 'read' | 'agent', CSSProperties> = {
  edit: { width: 2, height: 12, background: 'rgba(232,238,248,.9)', borderRadius: 1 },
  bash: { width: 2, height: 8, background: 'rgba(214,230,248,.62)', borderRadius: 1 },
  read: { width: 1, height: 5, background: 'rgba(190,212,238,.5)' },
  agent: { width: 6, height: 6, border: '1px solid rgba(232,238,248,.8)', borderRadius: '50%' },
}

const toolKind = (name: string): keyof typeof TICK =>
  /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)
    ? 'edit'
    : name === 'Bash'
      ? 'bash'
      : /^(Agent|Task)$/.test(name)
        ? 'agent'
        : 'read'

const DeskCard = memo(function DeskCard({
  planet,
  statePills,
  compactBadge,
  thresholds,
  lift,
  onSelect,
}: {
  planet: ScenePlanet
  statePills: 'dot' | 'label'
  compactBadge: boolean
  thresholds: { warn: number; critical: number }
  lift: { x: number; y: number } | null
  onSelect: (id: string) => void
}) {
  const s = planet.session
  const key = sessionStateKey(s)
  const pill = statePill(s)
  // 41b: every live card wears a pill, WORKING and IDLE included — unlike a
  // planet, a card has no motion of its own to say it is working.
  const pillLabel = pill?.label ?? (key === 'working' ? 'WORKING' : key === 'idle' ? 'IDLE' : null)
  const colour = stateColor(key)
  const tools = s.recentTools ?? []
  const last = tools.length ? tools[tools.length - 1] : null
  const now = useNow(key === 'working' || key === 'waiting' || Boolean(planet.compactingSince))
  const recent = tools.filter((t) => now - t.at < STRIP_WINDOW_MS)
  const fill = planet.contextFill
  const ended = key === 'ended'
  const detached = useOrbital((st) => st.detachedIds.includes(s.id))
  const openSubagent = useOrbital((st) => st.openSubagent)
  const failed = Boolean(s.lastCompactionFailed && fill)
  const showCompact =
    compactBadge && fill?.level === 'critical' && !pill && !planet.compactingSince && !failed
  const compactSec = planet.compactingSince
    ? Math.max(0, Math.floor((now - planet.compactingSince) / 1000))
    : 0
  const needs = key === 'needs_input'

  let border = '1px solid rgba(150,205,255,.12)'
  let shadow = INSET_LIGHT
  if (needs) border = `1px solid color-mix(in oklch, ${stateColor('needs_input')} 30%, transparent)`
  if (lift) {
    border = `1px solid ${LIFTED_BORDER}`
    shadow =
      '0 26px 60px rgba(0,0,0,.6),0 0 0 1px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.07)'
  }
  if (planet.selected) {
    border = `1.5px solid ${ACCENT}`
    shadow = `inset 0 1px 0 rgba(255,255,255,.05),0 0 0 3px oklch(85% .12 205 / .16),0 0 24px oklch(85% .12 205 / .1)`
  }

  return (
    <article
      data-card={s.id}
      className={[
        'relative shrink-0 cursor-pointer select-none rounded-xl text-text-bright',
        lift
          ? 'z-30'
          : 'transition-[opacity,transform,box-shadow,border-color,max-height] duration-[240ms] ease-out',
      ].join(' ')}
      style={{
        background: lift ? CARD_LIFTED : CARD_GLASS,
        border,
        boxShadow: shadow,
        transform: lift ? `translate(${lift.x}px, ${lift.y - 6}px)` : undefined,
        opacity: planet.leaving ? 0 : planet.muted ? 0.28 : ended ? 0.6 : 1,
        maxHeight: planet.leaving ? 0 : undefined,
        overflow: planet.leaving ? 'hidden' : undefined,
      }}
      onClick={(e) => {
        if ((e.target as Element).closest('button, input')) e.stopPropagation()
      }}
    >
      {/* 41b: a hairline glint in the tag hue along the top edge marks a live
          session — working, waiting or asking. NEEDS INPUT adds its amber
          border on top of it. */}
      {(key === 'working' || key === 'waiting' || needs) && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-3.5 right-3.5 top-[-1px] block h-px"
          style={{
            background: `linear-gradient(90deg,transparent,${tagInk(planet.hue, 0.85)},transparent)`,
          }}
        />
      )}

      {ended ? (
        <div className="flex items-center gap-[9px] px-3.5 py-[9px]">
          <span className="block h-[7px] w-[7px] flex-none rounded-full border-[1.5px] border-[rgba(160,190,225,.55)]" />
          <span
            className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-[rgba(214,226,242,.85)]"
            title={s.title}
          >
            {s.title}
          </span>
          <span className="flex-none font-mono text-[9.5px] tracking-[0.12em] text-[rgba(160,190,225,.6)]">
            {planet.leaving ? 'ENDED' : 'PINNED · ENDED'}
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-[9px] px-[15px] pb-3.5 pt-[13px]">
          <div className="flex items-start gap-[9px]">
            <span
              className="mt-1.5 block h-[7px] w-[7px] flex-none rounded-full"
              style={{ background: tagInk(planet.hue) }}
            />
            <span
              className="line-clamp-2 min-w-0 flex-1 text-[13.5px] font-semibold leading-[1.38] tracking-[-0.005em] [text-wrap:pretty]"
              title={s.title}
            >
              {s.title}
            </span>
            <div className="flex flex-none items-center gap-1.5 pt-px">
              {detached && <DetachedBadge />}
              {pillLabel && (
                <Pill
                  sessionKey={key}
                  label={pillLabel}
                  colour={colour}
                  mode={statePills}
                  gate={gateWaits(s)}
                />
              )}
            </div>
          </div>

          {(s.git?.ref || planet.modelFamily) && (
            <div className="-mt-1 truncate pl-4 font-mono text-[10.5px] text-[rgba(160,190,225,.6)]">
              {[s.git?.ref, planet.modelFamily].filter(Boolean).join(' · ')}
            </div>
          )}

          <div className="relative h-4 font-mono text-[11px]">
            {last ? (
              <span
                key={last.at}
                className="desk-activity absolute inset-0 flex gap-[7px] overflow-hidden whitespace-nowrap"
              >
                <span className="font-medium text-text-bright">{last.name}</span>
                <span className="min-w-0 truncate text-[rgba(160,190,225,.7)]">{last.summary}</span>
              </span>
            ) : (
              <span className="text-[rgba(160,190,225,.45)]">—</span>
            )}
          </div>

          <div className="relative h-3.5 overflow-hidden border-b border-[rgba(150,205,255,.1)]">
            {recent.map((t) => {
              const x = 1 - (now - t.at) / STRIP_WINDOW_MS
              return (
                <i
                  key={t.at + t.name}
                  className="absolute bottom-px box-border block transition-[left,opacity] duration-1000 ease-linear"
                  style={{
                    ...TICK[toolKind(t.name)],
                    left: `${(x * 97 + 1).toFixed(2)}%`,
                    opacity: 0.25 + 0.75 * x,
                  }}
                />
              )
            })}
          </div>

          {planet.subagents.length > 0 && (
            <div className="-mx-1.5 flex flex-col">
              {planet.subagents.map((sub) => (
                <SubagentRow key={sub.id} sub={sub} onOpen={() => void openSubagent(s.id, sub)} />
              ))}
            </div>
          )}

          {needs && s.pendingDecision && (
            <DecisionBlock
              sessionId={s.id}
              decision={s.pendingDecision}
              readOnly={isReadOnly(s)}
              onSelect={onSelect}
            />
          )}

          {(fill || planet.compactingSince || failed) && (
            <div className="flex flex-col gap-[7px] pt-0.5">
              {fill && (
                <div className="relative h-[3px] rounded-sm bg-[rgba(150,205,255,.1)]">
                  <span
                    className="absolute inset-y-0 left-0 block rounded-sm transition-[width] duration-700"
                    style={{
                      width: `${Math.round(fill.fraction * 100)}%`,
                      background: planet.compactingSince
                        ? 'rgba(190,212,238,.25)'
                        : oklchCss(contextLevelOklch(fill.level)),
                    }}
                  />
                  <span
                    title="Warn threshold"
                    className="absolute top-[-2px] block h-[7px] w-px bg-[rgba(214,230,248,.3)]"
                    style={{ left: `${thresholds.warn}%` }}
                  />
                  <span
                    title="Critical threshold"
                    className="absolute top-[-2px] block h-[7px] w-px bg-[rgba(214,230,248,.45)]"
                    style={{ left: `${thresholds.critical}%` }}
                  />
                </div>
              )}
              {((planet.compactingSince && compactSec >= 3) || showCompact || failed) && (
                <div className="flex justify-end">
                  {planet.compactingSince && compactSec >= 3 && (
                    <Badge>
                      COMPACTING {Math.floor(compactSec / 60)}:
                      {String(compactSec % 60).padStart(2, '0')}
                    </Badge>
                  )}
                  {showCompact && (
                    <Badge tone="critical" onClick={() => compactSession(s.id)}>
                      {Math.round((fill?.fraction ?? 0) * 100)}% · /compact
                    </Badge>
                  )}
                  {failed && (
                    <Badge
                      tone="failed"
                      onClick={() => {
                        useCompactionUi.getState().setReveal(s.id)
                        onSelect(s.id)
                      }}
                    >
                      COMPACT FAILED · {Math.round((fill?.fraction ?? 0) * 100)}%
                    </Badge>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  )
})

/** The state pill (41b): a hairline chip in the state's colour; in dot mode only the dot, the word slides out on hover. */
function Pill({
  sessionKey,
  label,
  colour,
  mode,
  gate,
}: {
  sessionKey: SessionStateKey
  label: string
  colour: string
  mode: 'dot' | 'label'
  gate: boolean
}) {
  const borderColour = `color-mix(in oklch, ${colour} 40%, transparent)`
  // WORKING and IDLE have no dot on the map's surfaces; on a card they get a
  // steady one (41b: solid for working, hollow for idle) — nothing pulses.
  const dotFor = (surface: 'label' | 'dot') => {
    const d = stateDot(sessionKey, surface, gate)
    if (d.shape !== 'none' || (sessionKey !== 'working' && sessionKey !== 'idle')) return d
    return {
      shape: sessionKey === 'working' ? ('solid' as const) : ('hollow' as const),
      motion: 'steady' as const,
    }
  }
  const chip =
    'flex h-[18px] box-border items-center gap-1.5 whitespace-nowrap rounded-full border font-mono text-[9.5px] tracking-[0.12em]'
  if (mode === 'label')
    return (
      <span className={`${chip} pl-1.5 pr-2`} style={{ color: colour, borderColor: borderColour }}>
        <StateDot dot={dotFor('label')} color={colour} solidPx={7} hollowPx={7} />
        {label}
      </span>
    )
  return (
    <span className="relative block h-[18px] w-[19px] flex-none">
      <span
        title={label}
        className={`${chip} absolute right-0 top-0 max-w-[19px] overflow-hidden border-transparent px-[5px] transition-[max-width,padding,border-color,background-color] duration-200 hover:max-w-[180px] hover:border-[var(--pill-bd)] hover:bg-[rgb(12,18,32)] hover:pl-[5px] hover:pr-2`}
        style={{ color: colour, '--pill-bd': borderColour } as CSSProperties}
      >
        <StateDot dot={dotFor('dot')} color={colour} solidPx={7} hollowPx={7} />
        {label}
      </span>
    </span>
  )
}

function DetachedBadge() {
  return (
    <span
      title="Open in its own window"
      className="relative block h-[18px] w-[18px] rounded-[5px] border border-[rgba(150,205,255,.2)] text-[rgba(200,220,245,.75)]"
    >
      <span className="absolute left-[3px] top-[5px] box-border block h-1.5 w-[7px] rounded-[1.5px] border border-current opacity-55" />
      <span className="absolute left-1.5 top-[3px] box-border block h-1.5 w-[7px] rounded-[1.5px] border border-current bg-[rgb(12,18,32)]" />
    </span>
  )
}

/** A subagent row (41b WAITING): running is a solid ink dot, finished hollow, inert dashed and not openable. */
function SubagentRow({ sub, onOpen }: { sub: Subagent; onOpen: () => void }) {
  const openable = Boolean(sub.toolUseId)
  const live = sub.state !== 'ended'
  const dot: CSSProperties = !openable
    ? { border: '1px dashed rgba(160,190,225,.4)' }
    : live
      ? { background: 'rgba(232,238,248,.85)' }
      : { border: '1px solid rgba(160,190,225,.55)' }
  return (
    <button
      type="button"
      disabled={!openable}
      onClick={onOpen}
      aria-label={`Open subagent transcript: ${sub.name}`}
      className="flex items-center gap-[9px] rounded-md px-1.5 py-1 text-left font-mono text-[11px] enabled:hover:bg-[rgba(150,205,255,.06)] disabled:cursor-default"
    >
      <span className="box-border block h-1.5 w-1.5 flex-none rounded-full" style={dot} />
      <span
        className="min-w-0 flex-1 truncate"
        style={{
          color: !openable
            ? 'rgba(160,190,225,.45)'
            : live
              ? 'rgba(232,238,248,.9)'
              : 'rgba(160,190,225,.6)',
        }}
      >
        {sub.name}
      </span>
      <span className="text-[9.5px] tracking-[0.1em] text-[rgba(160,190,225,.55)]">
        {!openable ? 'INERT' : live ? 'RUNNING ›' : 'DONE ›'}
      </span>
    </button>
  )
}

/** The argument a permission ask is about, when it has one short enough for a line: a command or a path. */
function decisionDetail(decision: PendingDecision): string | null {
  if (decision.kind !== 'permission') return null
  const { command, file_path: filePath } = decision.input
  return typeof command === 'string' ? command : typeof filePath === 'string' ? filePath : null
}

/** NEEDS INPUT on the card (41b), the Question Card's block: kind tag, the ask, and its answers as system chips. */
function DecisionBlock({
  sessionId,
  decision,
  readOnly,
  onSelect,
}: {
  sessionId: string
  decision: PendingDecision
  readOnly: boolean
  onSelect: (id: string) => void
}) {
  const resolveDecision = useOrbital((st) => st.resolveDecision)
  const answerQuestion = useOrbital((st) => st.answerQuestion)
  const questions = decision.kind === 'question' ? decision.input.questions : []
  const single = questions.length === 1 && !questions[0].multiSelect ? questions[0] : null
  const kind =
    decision.kind === 'question'
      ? questions.length > 1
        ? `QUESTIONS · ${questions.length}`
        : 'QUESTION'
      : decision.kind.toUpperCase()
  const text = decision.kind === 'question' ? questions[0]?.question : decisionHeadline(decision)
  const detail = decisionDetail(decision)
  return (
    <div className="flex flex-col gap-[9px] rounded-[10px] border border-[rgba(150,205,255,.16)] bg-[linear-gradient(180deg,rgba(10,16,28,.72),rgba(5,9,18,.82))] px-3 pb-3 pt-[11px]">
      <div className="flex items-center gap-2">
        <span
          className="rounded px-[7px] py-0.5 font-mono text-[9.5px] tracking-[0.14em] text-[#ffd2a8]"
          style={{
            border: `1px solid color-mix(in oklch, ${stateColor('needs_input')} 35%, transparent)`,
            background: `color-mix(in oklch, ${stateColor('needs_input')} 10%, transparent)`,
          }}
        >
          {kind}
        </span>
        {readOnly && (
          <span className="font-mono text-[9.5px] tracking-[0.12em] text-[rgba(160,190,225,.6)]">
            TERMINAL SESSION
          </span>
        )}
      </div>
      {text && (
        <div className="text-[12.5px] leading-[1.5] text-[rgba(232,238,248,.94)] [text-wrap:pretty]">
          {text}
        </div>
      )}
      {detail && (
        <div className="truncate rounded-md border border-[rgba(150,205,255,.08)] bg-[rgba(4,8,16,.6)] px-[9px] py-1.5 font-mono text-[10.5px] text-[rgba(214,230,248,.85)]">
          {detail}
        </div>
      )}
      {readOnly ? (
        <div className="font-mono text-[10.5px] text-[rgba(160,190,225,.65)]">
          Answer it in the terminal.
        </div>
      ) : decision.kind !== 'question' ? (
        <div className="flex gap-1.5">
          <ChipButton primary onClick={() => resolveDecision(sessionId, { approved: true })}>
            {decision.kind === 'plan' ? 'Approve' : 'Allow'}
          </ChipButton>
          <ChipButton onClick={() => resolveDecision(sessionId, { approved: false })}>
            Deny
          </ChipButton>
        </div>
      ) : single ? (
        <div className="flex flex-col gap-[5px]">
          {single.options.map((o, i) => (
            <button
              key={o.label}
              type="button"
              onClick={() => answerQuestion(sessionId, single.question, o.label)}
              className="flex items-center gap-[9px] rounded-[7px] border border-[rgba(150,205,255,.14)] px-[9px] py-1.5 text-left text-[12px] font-medium text-[rgba(214,230,248,.9)] transition-colors hover:border-[rgba(150,205,255,.3)] hover:bg-[rgba(150,205,255,.14)] hover:text-text-bright"
            >
              <span className="font-mono text-[10px] text-[rgba(160,190,225,.55)]">{i + 1}</span>
              {o.label}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex gap-1.5">
          <ChipButton primary onClick={() => onSelect(sessionId)}>
            Answer
          </ChipButton>
        </div>
      )}
    </div>
  )
}

/** The system chip as a button (41b): resting for Deny and options, active for Allow / Approve / Answer. */
function ChipButton({
  children,
  onClick,
  primary,
}: {
  children: React.ReactNode
  onClick: () => void
  primary?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'rounded-[7px] border px-3.5 py-1.5 text-[12px] font-semibold transition-colors hover:border-[rgba(150,205,255,.3)] hover:bg-[rgba(150,205,255,.14)] hover:text-text-bright',
        primary
          ? 'border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)] text-text-bright'
          : 'border-[rgba(150,205,255,.14)] text-[rgba(214,230,248,.85)]',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

/** The context row's badge (41b): neutral, the critical /compact chip, or COMPACT FAILED. */
function Badge({
  children,
  tone,
  onClick,
}: {
  children: React.ReactNode
  tone?: 'critical' | 'failed'
  onClick?: () => void
}) {
  const style: CSSProperties =
    tone === 'critical'
      ? {
          borderColor: oklchCss(CONTEXT_CRITICAL_OKLCH, 0.45),
          background: oklchCss(CONTEXT_CRITICAL_OKLCH, 0.1),
          color: 'oklch(82% .1 25)',
        }
      : tone === 'failed'
        ? {
            borderColor: 'rgba(232,238,248,.45)',
            background: 'rgba(232,238,248,.06)',
            color: '#e8eef8',
          }
        : { borderColor: 'rgba(150,205,255,.14)', color: 'rgba(160,190,225,.6)' }
  const className = 'rounded-[5px] border px-[7px] py-0.5 font-mono text-[9.5px] tracking-[0.1em]'
  return onClick ? (
    <button type="button" onClick={onClick} className={className} style={style}>
      {children}
    </button>
  ) : (
    <span className={className} style={style}>
      {children}
    </span>
  )
}

type DrawerState = 'resting' | 'eligible' | 'armed' | 'refused'

/** 41e: resting, eligible (a card is being dragged), armed (over the drawer), refused (a terminal session). */
const DRAWER: Record<
  DrawerState,
  { sub: string; subInk: string; border: string; bg: string; shadow: string; glyph: string }
> = {
  resting: {
    sub: 'click to browse',
    subInk: 'rgba(160,190,225,.6)',
    border: '1px solid rgba(150,205,255,.16)',
    bg: 'linear-gradient(180deg,rgba(14,20,34,.72),rgba(8,12,22,.78))',
    shadow: '0 12px 30px rgba(0,0,0,.4)',
    glyph: 'rgba(200,220,245,.7)',
  },
  eligible: {
    sub: 'drop here to end the session',
    subInk: 'rgba(214,230,248,.85)',
    border: '1px dashed rgba(150,205,255,.42)',
    bg: 'linear-gradient(180deg,rgba(14,20,34,.72),rgba(8,12,22,.78))',
    shadow: '0 12px 30px rgba(0,0,0,.4)',
    glyph: 'rgba(214,230,248,.85)',
  },
  armed: {
    sub: 'release to end',
    subInk: '#e8eef8',
    border: '1px solid rgba(232,238,248,.55)',
    bg: 'linear-gradient(180deg,rgb(34,48,72),rgb(20,29,47))',
    shadow: '0 0 0 4px rgba(150,205,255,.07),0 12px 30px rgba(0,0,0,.4)',
    glyph: '#e8eef8',
  },
  refused: {
    sub: "can't end a terminal session",
    subInk: 'rgba(160,190,225,.6)',
    border: '1px solid rgba(150,205,255,.14)',
    bg: 'linear-gradient(180deg,rgb(14,20,33),rgb(9,13,23))',
    shadow: '0 12px 30px rgba(0,0,0,.4)',
    glyph: 'rgba(160,190,225,.6)',
  },
}

function HistoryDrawer({
  ref,
  state,
  count,
  left,
  onClick,
}: {
  ref: React.Ref<HTMLButtonElement>
  state: DrawerState
  count: number
  left: number
  onClick: () => void
}) {
  const d = DRAWER[state]
  return (
    <button
      ref={ref}
      type="button"
      data-overlay="history-drawer"
      onClick={onClick}
      className="absolute bottom-6 z-[7] box-border flex w-[300px] items-center gap-3 rounded-xl px-3.5 py-[11px] text-left backdrop-blur-[16px] transition-[left,border-color,background,box-shadow] duration-200"
      style={{ left, background: d.bg, border: d.border, boxShadow: d.shadow }}
    >
      <span
        className="relative box-border block h-3.5 w-[18px] flex-none rounded-[3px]"
        style={{ border: `1.2px solid ${d.glyph}` }}
      >
        <span
          className="absolute left-[3px] right-[3px] top-1 block h-[1.2px]"
          style={{ background: d.glyph }}
        />
        {state === 'refused' && (
          <span
            className="absolute left-[-4px] top-[5px] block h-[1.2px] w-6 -rotate-[35deg]"
            style={{ background: d.glyph }}
          />
        )}
      </span>
      <span className="flex min-w-0 flex-col gap-[3px] font-mono text-[10.5px]">
        <span className="tracking-[0.14em] text-text-bright">
          HISTORY · {count} session{count === 1 ? '' : 's'}
        </span>
        <span style={{ color: d.subInk }}>{d.sub}</span>
      </span>
    </button>
  )
}
