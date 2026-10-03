import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { mapStatePills, showCompactBadge, showTrash, trashDropFor, useOrbital } from '../../store/store'
import { sendCompactAware, useCompactionUi } from '../../store/compaction'
import { gateWaits, isReadOnly, sessionStateKey, statePill, type SessionStateKey, type Subagent } from '../../lib/types'
import { stateColor, stateDot } from '../../lib/stateStyle'
import { decisionHeadline } from '../../lib/decisionCard'
import { reportError } from '../../lib/errors'
import { useNow } from '../../lib/useNow'
import { useDocumentHidden, useWindowFocused } from '../../lib/useWindowFocused'
import { StateDot } from '../../ui/StateDot'
import { useSceneModel } from '../useSceneModel'
import type { ScenePlanet } from '../sceneModel'
import { COMPACT_COMMAND } from '../Planet'
import { MapShell, useMapInsets } from '../shell/MapShell'
import { anchorForMatMove, cardOrder, matOrder } from './order'

const DRAG_THRESHOLD_PX = 3
const MAT_WIDTH_PX = 300
const MAT_GAP_PX = 18
const STRIP_WINDOW_MS = 120_000
const CONTEXT_COLOURS = { ok: '#7fe3b0', warn: '#ffbb7b', critical: '#fa8880' } as const

type Drag =
  | { kind: 'card'; id: string; pointerId: number; startX: number; startY: number; moved: boolean; dx: number; dy: number }
  | { kind: 'mat'; tagId: number; pointerId: number; startX: number; startY: number; moved: boolean; dx: number }

/**
 * The Desk theme (spec 2026-10-01-map-themes-design § 4): one mat per tag
 * cluster, ordered by the tag anchors the map stores (ADR
 * `desk-mats-order-by-tag-anchors`); one card per session, in a stable order;
 * a history drawer to drop a card in. No camera — the desk scrolls sideways.
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
  const [drop, setDrop] = useState<'none' | 'eligible' | 'armed' | 'refused'>('none')
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
    [select]
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

  const dropAt = useCallback((id: string, x: number, y: number) => {
    const r = drawerRef.current?.getBoundingClientRect()
    if (!r) return 'none' as const
    const inside = x > r.left - 24 && x < r.right + 24 && y > r.top - 24 && y < r.bottom + 24
    if (!inside) return 'eligible' as const
    const s = useOrbital.getState().sessions[id]
    return s && trashDropFor(s.source, s.status) === 'refuse' ? ('refused' as const) : ('armed' as const)
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
        if (Math.abs(e.clientX - d.startX) < DRAG_THRESHOLD_PX && Math.abs(e.clientY - d.startY) < DRAG_THRESHOLD_PX) return
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
    [dropAt]
  )

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = dragRef.current
      if (!d || d.pointerId !== e.pointerId) return
      dragRef.current = null
      setDrag(null)
      setDrop('none')
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
        if (how === 'end') trashSession(d.id, { undo: true }).catch((err: unknown) => reportError(err, 'Failed to end the session'))
        else if (how === 'confirm') setConfirmEndId(d.id)
        return
      }
      const ordered = mats.map((m) => m.anchor)
      const from = ordered.findIndex((a) => a.tagId === d.tagId)
      const to = Math.max(0, Math.min(ordered.length, from + Math.round(d.dx / (MAT_WIDTH_PX + MAT_GAP_PX)) + (d.dx > 0 ? 1 : 0)))
      const next = anchorForMatMove(ordered, from, to)
      if (next) void setTagAnchor(d.tagId, next)
    },
    [dropAt, mats, selectSession, setTagAnchor, trashSession]
  )

  const statePills = mapStatePills(settings)
  const compactBadge = showCompactBadge(settings)
  const trash = showTrash(settings)
  const historyCount = model.hole.count

  return (
    <div
      data-testid="map-surface"
      data-paused={paused ? '' : undefined}
      className="relative h-full w-full overflow-hidden bg-[linear-gradient(#121823,#0d121b)]"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={(e) => {
        if (e.target === e.currentTarget || (e.target as Element).hasAttribute('data-desk-floor'))
          useOrbital.setState((s) => (s.ui.selectedId ? { ui: { ...s.ui, selectedId: null } } : s))
      }}
    >
      <div
        ref={scrollRef}
        data-desk-floor
        className="absolute inset-y-0 left-0 overflow-x-auto overflow-y-hidden transition-[right] duration-[420ms] ease-[cubic-bezier(.2,.8,.2,1)]"
        style={{ right: insets.right, paddingLeft: insets.left, paddingRight: 24, paddingTop: insets.top + 64, paddingBottom: 88 }}
      >
        <div data-desk-floor className="flex h-full items-stretch" style={{ gap: MAT_GAP_PX }}>
          {mats.map((m) => {
            const lifted = drag?.kind === 'mat' && drag.tagId === m.anchor.tagId && drag.moved
            return (
              <section
                key={m.anchor.tagId}
                className={[
                  'flex shrink-0 flex-col rounded-[18px] border border-dashed border-white/[.07] bg-white/[.018]',
                  lifted ? 'relative z-20 shadow-[0_24px_50px_rgba(0,0,0,.5)]' : 'transition-transform duration-300',
                ].join(' ')}
                style={{ width: MAT_WIDTH_PX, transform: lifted ? `translateX(${drag.dx}px)` : undefined }}
              >
                <MatHeader tagId={m.anchor.tagId} hue={m.anchor.hue} label={m.label} cards={m.cards} />
                <div data-desk-floor className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-4">
                  {m.cards.map((p) => (
                    <DeskCard
                      key={p.session.id}
                      planet={p}
                      statePills={statePills}
                      compactBadge={compactBadge}
                      lift={drag?.kind === 'card' && drag.id === p.session.id && drag.moved ? { x: drag.dx, y: drag.dy } : null}
                      onSelect={selectSession}
                    />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      </div>

      {trash && (
        <button
          ref={drawerRef}
          type="button"
          data-overlay="history-drawer"
          onClick={() => revealHistory()}
          className={[
            'absolute bottom-6 z-[7] rounded-xl border px-4 py-2.5 text-left font-mono text-[10px] tracking-[0.12em] transition-[left,border-color,background-color,box-shadow] duration-500',
            drop === 'armed'
              ? 'border-accent/60 bg-[rgba(16,30,40,.95)] shadow-[0_0_0_4px_rgba(89,228,243,.12)]'
              : drop === 'refused'
                ? 'border-[#ffbb7b]/60 bg-[rgba(30,24,14,.95)]'
                : drop === 'eligible'
                  ? 'border-[rgba(150,205,255,.3)] bg-[rgba(10,14,24,.95)]'
                  : 'border-[rgba(150,205,255,.14)] bg-[rgba(10,14,24,.88)]',
          ].join(' ')}
          style={{ left: insets.left }}
        >
          <div className="font-semibold text-text-bright/80">HISTORY</div>
          <div className="mt-0.5 tracking-[0.04em] text-text-muted" style={{ color: drop === 'refused' ? '#ffbb7b' : undefined }}>
            {drop === 'refused'
              ? "can't end a terminal session"
              : drop === 'armed'
                ? 'release to end'
                : `${historyCount} session${historyCount === 1 ? '' : 's'} · click to browse`}
          </div>
        </button>
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

function MatHeader({ tagId, hue, label, cards }: { tagId: number; hue: number; label: string; cards: ScenePlanet[] }) {
  const counts = useMemo(() => {
    const c: Partial<Record<SessionStateKey, number>> = {}
    for (const p of cards) {
      const k = sessionStateKey(p.session)
      c[k] = (c[k] ?? 0) + 1
    }
    return (['needs_input', 'working', 'waiting', 'done', 'interrupted'] as const).filter((k) => c[k]).map((k) => ({ k, n: c[k]! }))
  }, [cards])
  return (
    <header data-mat-handle={tagId} className="flex cursor-grab items-center gap-2 px-4 pb-2.5 pt-3.5 select-none active:cursor-grabbing">
      <i className="h-2 w-2 rounded-[2px]" style={{ background: `oklch(72% .13 ${hue})` }} />
      <span className="font-mono text-[10.5px] font-semibold tracking-[0.14em] text-[rgba(200,215,235,.75)]">{label}</span>
      <span className="ml-auto flex gap-2">
        {counts.map(({ k, n }) => (
          <span key={k} className="flex items-center gap-1 font-mono text-[10px]" style={{ color: stateColor(k) }}>
            <StateDot dot={stateDot(k, 'label')} color={stateColor(k)} solidPx={5} hollowPx={6} />
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

const DeskCard = memo(function DeskCard({
  planet,
  statePills,
  compactBadge,
  lift,
  onSelect,
}: {
  planet: ScenePlanet
  statePills: 'dot' | 'label'
  compactBadge: boolean
  lift: { x: number; y: number } | null
  onSelect: (id: string) => void
}) {
  const s = planet.session
  const key = sessionStateKey(s)
  const pill = statePill(s)
  const colour = stateColor(key)
  const tools = s.recentTools ?? []
  const last = tools.length ? tools[tools.length - 1] : null
  const now = useNow(key === 'working' || key === 'waiting' || Boolean(planet.compactingSince))
  const recent = tools.filter((t) => now - t.at < STRIP_WINDOW_MS)
  const fill = planet.contextFill
  const ended = key === 'ended'
  const detached = useOrbital((st) => st.detachedIds.includes(s.id))
  const openSubagent = useOrbital((st) => st.openSubagent)
  const resolveDecision = useOrbital((st) => st.resolveDecision)
  const answerQuestion = useOrbital((st) => st.answerQuestion)
  const readOnly = isReadOnly(s)
  const decision = s.pendingDecision ?? null
  const failed = Boolean(s.lastCompactionFailed && fill)
  const showCompact = compactBadge && fill?.level === 'critical' && !pill && !planet.compactingSince && !failed
  const compactSec = planet.compactingSince ? Math.max(0, Math.floor((now - planet.compactingSince) / 1000)) : 0
  const [hovered, setHovered] = useState(false)

  return (
    <article
      data-card={s.id}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      className={[
        'relative shrink-0 cursor-pointer select-none overflow-hidden rounded-xl border bg-[#1a212d] px-3.5 pb-3 pt-3 shadow-[0_1px_0_rgba(255,255,255,.04)_inset,0_8px_22px_rgba(0,0,0,.35)]',
        lift ? 'z-30 shadow-[0_24px_50px_rgba(0,0,0,.55)]' : 'transition-[transform,opacity,border-color,max-height,filter] duration-700 ease-[cubic-bezier(.2,.7,.2,1)]',
        planet.selected ? 'border-accent/60' : key === 'needs_input' ? 'border-[#5b4b2c]' : 'border-[#2b3548] hover:border-[#3a4660]',
      ].join(' ')}
      style={{
        transform: lift ? `translate(${lift.x}px, ${lift.y}px) rotate(1.5deg)` : undefined,
        opacity: planet.leaving ? 0 : planet.muted ? 0.28 : ended ? 0.55 : 1,
        filter: ended ? 'saturate(.3)' : undefined,
        maxHeight: planet.leaving ? 0 : 520,
        boxShadow: key === 'needs_input' ? '0 8px 22px rgba(0,0,0,.35), 0 0 34px rgba(255,187,123,.07)' : undefined,
      }}
      onClick={(e) => {
        if ((e.target as Element).closest('button, input')) e.stopPropagation()
      }}
    >
      {key === 'working' && <div className="desk-sweep pointer-events-none absolute inset-x-0 top-0 h-[2px] opacity-60" />}
      {planet.selected && <Brackets />}

      <div className="flex items-start gap-2">
        <i className="mt-[5px] h-2 w-2 shrink-0 rounded-[2px]" style={{ background: `oklch(72% .13 ${planet.hue})` }} />
        <span className="line-clamp-2 min-w-0 flex-1 text-[13px] font-semibold leading-[1.3] text-text-bright" title={s.title}>
          {s.title}
        </span>
        {detached && (
          <span className="text-[11px] text-text-muted" title="Open in its own window">
            ⧉
          </span>
        )}
        {pill && (
          <span
            className="flex shrink-0 items-center gap-1.5 rounded-full px-2 py-[2px] font-mono text-[9.5px] tracking-[0.08em]"
            style={{ color: colour, background: `color-mix(in oklch, ${colour} 13%, transparent)` }}
          >
            <StateDot dot={stateDot(key, statePills === 'label' ? 'label' : 'dot', gateWaits(s))} color={colour} solidPx={5} hollowPx={6} />
            {(statePills === 'label' || hovered) && pill.label}
          </span>
        )}
      </div>

      <div className="ml-4 mt-0.5 truncate font-mono text-[10.5px] text-[#6f7a8d]">
        {[s.git?.ref, planet.modelFamily].filter(Boolean).join(' · ')}
      </div>

      {!ended && (
        <div className="relative mt-2 h-5 overflow-hidden font-mono text-[11.5px] text-text-muted">
          {last ? (
            <span key={last.at} className="desk-activity absolute inset-0 truncate">
              <b className="mr-1.5 font-medium text-[#c5cddb]">{last.name}</b>
              {last.summary}
            </span>
          ) : (
            <span className="opacity-50">—</span>
          )}
        </div>
      )}

      {!ended && (
        <div className="relative mt-1.5 h-[22px] overflow-hidden rounded-[5px] bg-white/[.025]">
          {recent.map((t) => {
            const x = 1 - (now - t.at) / STRIP_WINDOW_MS
            const kind = /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(t.name) ? 'edit' : t.name === 'Bash' ? 'bash' : /^(Agent|Task)$/.test(t.name) ? 'agent' : 'read'
            return (
              <i
                key={t.at + t.name}
                className="absolute bottom-[3px] w-[3px] rounded-[1.5px] transition-[left] duration-1000 ease-linear"
                style={{
                  left: `calc(${(x * 100).toFixed(2)}% - 6px)`,
                  height: { edit: 14, bash: 10, read: 6, agent: 16 }[kind],
                  background: { edit: `oklch(72% .13 ${planet.hue})`, bash: '#6cc3b5', read: '#5b6578', agent: 'var(--state-done)' }[kind],
                  opacity: 0.35 + 0.65 * x,
                }}
              />
            )
          })}
        </div>
      )}

      {!ended && planet.subagents.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {planet.subagents.map((sub) => (
            <SubagentStrip key={sub.id} sub={sub} onOpen={() => void openSubagent(s.id, sub)} />
          ))}
        </div>
      )}

      {key === 'needs_input' && decision && (
        <div className="mt-2.5">
          <div className="rounded-lg border border-[#463b25] bg-[#2a2418] px-2.5 py-2 text-[12.5px] text-[#f0dcb0]">
            {decision.kind === 'question' ? decision.input.questions[0]?.question : decisionHeadline(decision)}
          </div>
          {readOnly ? (
            <div className="mt-1.5 text-[11px] text-text-muted">Answer it in the terminal.</div>
          ) : (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {decision.kind !== 'question' ? (
                <>
                  <CardButton primary onClick={() => resolveDecision(s.id, { approved: true })}>
                    {decision.kind === 'plan' ? 'Approve' : 'Allow'}
                  </CardButton>
                  <CardButton onClick={() => resolveDecision(s.id, { approved: false })}>Deny</CardButton>
                </>
              ) : decision.input.questions.length === 1 && !decision.input.questions[0].multiSelect ? (
                decision.input.questions[0].options.map((o) => (
                  <CardButton key={o.label} onClick={() => answerQuestion(s.id, decision.input.questions[0].question, o.label)}>
                    {o.label}
                  </CardButton>
                ))
              ) : (
                <CardButton primary onClick={() => onSelect(s.id)}>
                  Answer
                </CardButton>
              )}
            </div>
          )}
        </div>
      )}

      {(fill || planet.compactingSince || failed || showCompact) && (
        <div className="mt-2.5 flex items-center gap-2">
          {fill && (
            <div className="relative h-[3px] flex-1 overflow-hidden rounded-full bg-[rgba(190,225,255,.1)]">
              <div
                className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-700"
                style={{
                  width: `${Math.round(fill.fraction * 100)}%`,
                  background: planet.compactingSince ? 'rgba(190,225,255,.35)' : CONTEXT_COLOURS[fill.level],
                  opacity: fill.level === 'ok' ? 0.6 : 0.95,
                }}
              />
            </div>
          )}
          {planet.compactingSince && compactSec >= 3 && (
            <span className="font-mono text-[9.5px] tracking-[0.08em] text-[#bee1ff]">
              COMPACTING {Math.floor(compactSec / 60)}:{String(compactSec % 60).padStart(2, '0')}
            </span>
          )}
          {showCompact && (
            <CardButton onClick={() => compactSession(s.id)}>{Math.round((fill?.fraction ?? 0) * 100)}% · /compact</CardButton>
          )}
          {failed && (
            <CardButton
              onClick={() => {
                useCompactionUi.getState().setReveal(s.id)
                onSelect(s.id)
              }}
            >
              COMPACT FAILED · {Math.round((fill?.fraction ?? 0) * 100)}%
            </CardButton>
          )}
        </div>
      )}
    </article>
  )
})

function SubagentStrip({ sub, onOpen }: { sub: Subagent; onOpen: () => void }) {
  const openable = Boolean(sub.toolUseId)
  const live = sub.state !== 'ended' && openable
  const colour = sub.state === 'needs_input' ? stateColor('needs_input') : live ? stateColor('done') : 'var(--state-neutral)'
  return (
    <button
      type="button"
      disabled={!openable}
      onClick={onOpen}
      aria-label={`Open subagent transcript: ${sub.name}`}
      className="flex items-center gap-2 rounded px-0.5 text-left text-[11.5px] enabled:hover:bg-white/[.04] disabled:cursor-default"
    >
      <i className="h-1 w-3.5 shrink-0 rounded-sm" style={{ background: colour }} />
      <span className={live ? 'text-[#b8c1d0]' : 'text-text-muted'}>{sub.name}</span>
    </button>
  )
}

function CardButton({ children, onClick, primary }: { children: React.ReactNode; onClick: () => void; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'rounded-md border px-2.5 py-1 text-[11.5px] transition-colors',
        primary
          ? 'border-[#3c6656] bg-[#2b4a3e] text-text-bright hover:bg-[#335a4b]'
          : 'border-[#2d3850] bg-[#1f2735] text-text-bright hover:bg-[#273145]',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

function Brackets() {
  const c = 'pointer-events-none absolute h-2.5 w-2.5 border-accent/70'
  return (
    <>
      <i className={`${c} left-1 top-1 border-l border-t`} />
      <i className={`${c} right-1 top-1 border-r border-t`} />
      <i className={`${c} bottom-1 left-1 border-b border-l`} />
      <i className={`${c} bottom-1 right-1 border-b border-r`} />
    </>
  )
}
