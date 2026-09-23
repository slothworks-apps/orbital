import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import { detachSession, hasDesktopBridge, openInMainWindow } from '../lib/desktop'
import { formatDuration, shortenPath } from '../lib/format'
import type { ApiSession, WalkthroughSummary } from '../lib/types'
import { MENU_SEPARATOR, MenuButton } from '../ui/Menu'
import type { MenuEntry } from '../ui/Menu'
import { PinButton } from '../ui/PinButton'
import { Tooltip } from '../ui/Tooltip'
import {
  ClearGlyph,
  CollapseGlyph,
  DetachGlyph,
  EndGlyph,
  MoreGlyph,
  StatsGlyph,
  UtilityButton,
  WalkthroughGlyph,
} from '../ui/UtilityButton'
import { prefersReducedMotion } from '../ui/usePresence'
import { walkthroughPath } from '../walkthrough/route'
import { SessionStatsButton, useStatsReadout } from './SessionStatsRow'
import type { StatsRowVariant } from './SessionStatsRow'
import {
  STRIP_BUTTON_PX,
  isFoldable,
  stripForm,
  stripLayout,
  stripMenu,
} from './stripFold'
import type { StripButton, StripForm, StripPresence } from './stripFold'
import { WhereLine } from './WhereLine'

/**
 * How long the pointer rests on a strip button before its tooltip appears
 * (canvas 4d). Long enough that crossing the header's action group on the way
 * to collapse never raises it.
 */
export const PIN_TOOLTIP_DELAY_MS = 400

/** 23d: the fold's one clock — widths, margins and scale all run on it. */
const FOLD_MS = 260
/** 23d: each fade takes half the clock — leaving in the first half, arriving in the second. */
const FOLD_FADE_MS = 130
/** 23d's curve. */
const FOLD_EASE = 'cubic-bezier(.2,.7,.2,1)'
/** 23d: a leaving glyph shrinks into its own centre rather than being clipped by the edge. */
const FOLD_SCALE = 0.6
/** 23d, RESTRAINT: what reduced motion gets instead — a cross-fade and nothing else. */
const REDUCED_FADE_MS = 120

/** 23c form 4: the ⋯ menu's width. */
const MORE_MENU_PX = 252

type Motion = 'none' | 'full' | 'reduced'

/**
 * The transition a slot runs as it arrives (`shown`) or leaves — 23d's
 * `renderVals`, verbatim: every size on one clock so the strip's total width
 * moves one way only, and only the fades offset, leaving in the first half and
 * arriving in the second.
 *
 * Reduced motion keeps the fades and drops the travel: an arriving slot takes
 * its width at once and fades in, a leaving one fades out and gives its width
 * up only then — a cross-fade, where nothing slides.
 */
function slotTransition(shown: boolean, motion: Motion): string {
  if (motion === 'none') return 'none'
  if (motion === 'reduced') {
    const fade = `opacity ${REDUCED_FADE_MS}ms ease`
    return shown ? fade : `${fade}, width 0s linear ${REDUCED_FADE_MS}ms, margin-left 0s linear ${REDUCED_FADE_MS}ms`
  }
  const size = (property: string) => `${property} ${FOLD_MS}ms ${FOLD_EASE}`
  const fadeDelay = shown ? FOLD_FADE_MS : 0
  return [size('width'), size('margin-left'), size('transform'), `opacity ${FOLD_FADE_MS}ms ease ${fadeDelay}ms`].join(', ')
}

/**
 * One button's seat in the strip. The seat is what animates — its width and
 * the margin in front of it — so the button inside keeps its own 24px box and
 * never reflows mid-fold.
 *
 * A seat that is not shown is `inert` (out of the tab order and the
 * accessibility tree) and `aria-hidden` for the tools that do not know
 * `inert` yet. It stays mounted, so expanding has something to grow back.
 *
 * The clip and the transform are there only while the seat is not shown: a
 * tooltip hangs outside its button (web/CLAUDE.md), and a transform would make
 * the seat the containing block the detach tooltip's `anchor="group"` looks
 * past.
 */
function Seat({
  shown,
  marginPx,
  motion,
  children,
}: {
  shown: boolean
  marginPx: number
  motion: Motion
  children: ReactNode
}) {
  const style: CSSProperties = {
    width: shown ? STRIP_BUTTON_PX : 0,
    marginLeft: shown ? marginPx : 0,
    opacity: shown ? 1 : 0,
    transform: shown || motion === 'reduced' ? 'none' : `scale(${FOLD_SCALE})`,
    overflow: shown ? undefined : 'hidden',
    pointerEvents: shown ? undefined : 'none',
    transition: slotTransition(shown, motion),
  }
  return (
    <span
      className="flex h-6 flex-none items-center justify-center"
      style={style}
      inert={!shown || undefined}
      aria-hidden={!shown || undefined}
    >
      {children}
    </span>
  )
}

/**
 * The form the strip is in, and whether a change of it animates.
 *
 * A `ResizeObserver` on the path cell re-decides on every change of its width
 * (23d, TRIGGER). The decision is held — not dropped — while `held` (a tooltip
 * or the ⋯ menu is up, 23d RESTRAINT) and while a fold is still running, and
 * taken with the latest width once they end.
 *
 * `resetKey` marks a new strip: another session, or a different set of
 * buttons. The form is then decided before the browser paints, from a direct
 * measurement, with the transitions off — the first paint is already in the
 * right form, never a fold played at mount.
 */
function useStripForm(
  cellRef: RefObject<HTMLElement | null>,
  present: StripPresence,
  held: boolean,
  resetKey: string,
): { form: StripForm; motion: Motion; cellPx: number } {
  const [form, setForm] = useState<StripForm>('expanded')
  const [animated, setAnimated] = useState(false)
  /** The cell's width for the path line's split — state, where `width` is the decision's ref. */
  const [cellPx, setCellPx] = useState(0)
  const width = useRef(0)
  const lockedUntil = useRef(0)
  const latest = useRef({ present, held, animated })
  latest.current = { present, held, animated }

  const decide = useCallback(() => {
    const { present, held } = latest.current
    if (held || performance.now() < lockedUntil.current) return
    setForm((current) => stripForm(width.current, current, present))
  }, [])

  useLayoutEffect(() => {
    lockedUntil.current = 0
    setAnimated(false)
    const cell = cellRef.current
    if (cell) width.current = cell.getBoundingClientRect().width
    setCellPx(width.current)
    setForm((current) => stripForm(width.current, current, latest.current.present))
    // Two frames: the first paints the settled form, the second arms the
    // transitions for whatever comes after it.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setAnimated(true))
    })
    return () => cancelAnimationFrame(frame)
  }, [cellRef, resetKey])

  // A switch made with the transitions off lands in one frame, so the path's
  // split should land with it rather than a frame later with the observer.
  useLayoutEffect(() => {
    const cell = cellRef.current
    if (latest.current.animated || !cell) return
    width.current = cell.getBoundingClientRect().width
    setCellPx(width.current)
  }, [cellRef, form])

  useEffect(() => {
    const cell = cellRef.current
    if (!cell || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (!entry) return
      width.current = entry.contentRect.width
      setCellPx(width.current)
      decide()
    })
    observer.observe(cell)
    return () => observer.disconnect()
  }, [cellRef, decide])

  // A switch that animates locks the decision until it has finished: mid-fold
  // the path cell is between its two widths, and judging it there could only
  // echo the switch back.
  const previous = useRef(form)
  useEffect(() => {
    if (previous.current === form) return
    previous.current = form
    if (!latest.current.animated) return
    const ms = prefersReducedMotion() ? REDUCED_FADE_MS : FOLD_MS
    lockedUntil.current = performance.now() + ms
    const timer = setTimeout(() => {
      lockedUntil.current = 0
      decide()
    }, ms)
    return () => clearTimeout(timer)
  }, [form, decide])

  // Released: take the decision that was held.
  useEffect(() => {
    if (!held) decide()
  }, [held, decide])

  const motion: Motion = !animated ? 'none' : prefersReducedMotion() ? 'reduced' : 'full'
  return { form, motion, cellPx }
}

export interface UtilityStripProps {
  session: ApiSession | undefined
  /**
   * The panel alone in a detached window: no detach, no collapse (22c), and
   * the walkthrough opens in the main window.
   */
  standalone: boolean
  /** Whether stats is a strip button or the bar at the foot of the header (11c). */
  statsVariant: StatsRowVariant
  pinned: boolean
  releaseAfterMs: number | null
  onTogglePin: () => void
  onClear: () => void
  onEnd: () => void
  onCollapse: () => void
  lineage: string[] | undefined
  walkthroughEntry: WalkthroughSummary | null
  /** What the path line budgets against before its cell has been measured. */
  pathBudgetPx: number
}

/**
 * The detail header's row 1 (canvas `Feature - Detail header` 9d, actions per
 * `Feature - Header actions` 23a): the path, then the strip — which folds
 * stats, clear and detach behind a ⋯ when the path runs out of room (23c
 * form 5, motion 23d). The row's container, and its title-bar duty in a
 * detached window, stay with the panel.
 */
export function UtilityStrip({
  session,
  standalone,
  statsVariant,
  pinned,
  releaseAfterMs,
  onTogglePin,
  onClear,
  onEnd,
  onCollapse,
  lineage,
  walkthroughEntry,
  pathBudgetPx,
}: UtilityStripProps) {
  const cellRef = useRef<HTMLSpanElement | null>(null)
  const readout = useStatsReadout(session && statsVariant === 'button' ? session : null)

  const present: StripPresence = {
    stats: Boolean(session) && statsVariant === 'button',
    pin: Boolean(session),
    // Clear and End are Orbital's own: it does not own a terminal's process.
    clear: session?.source === 'web',
    end: session?.source === 'web' && session.status !== 'ended',
    // Desktop only — a browser cannot focus or close the window it would open.
    detach: Boolean(session) && !standalone && hasDesktopBridge(),
    // A detached window has neither (22c): the red light and ⌘W close it.
    collapse: !standalone,
  }
  const presenceKey = (Object.keys(present) as (keyof StripPresence)[])
    .filter((button) => present[button])
    .join(' ')

  // 23d: no motion while a tooltip or the menu is up. A tooltip rises only
  // under the pointer or on focus, so the strip holds its form for as long as
  // either is in it — which also keeps a button from sliding out from under
  // a pointer about to press it.
  const [pointerIn, setPointerIn] = useState(false)
  const [focusIn, setFocusIn] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const held = pointerIn || focusIn || menuOpen

  const { form, motion, cellPx } = useStripForm(cellRef, present, held, `${session?.id ?? ''}|${presenceKey}`)

  const layout = stripLayout(form, present)
  const shown = new Map(layout.map((slot) => [slot.button, slot.marginPx]))
  const seat = (button: StripButton, children: ReactNode) => (
    <Seat shown={shown.has(button)} marginPx={shown.get(button) ?? 0} motion={motion}>
      {children}
    </Seat>
  )

  const menu: MenuEntry[] = session
    ? stripMenu(present).map((entry): MenuEntry => {
        switch (entry) {
          case 'separator':
            return MENU_SEPARATOR
          case 'stats':
            return {
              key: 'stats',
              label: 'Session stats',
              icon: <StatsGlyph />,
              // 23c: the readout inline, so the glance is free.
              detail: readout.summary ?? '—',
              disabled: readout.stats === null,
              onSelect: readout.show,
            }
          case 'clear':
            return { key: 'clear', label: 'Clear and start over', icon: <ClearGlyph />, onSelect: onClear }
          case 'detach':
            return {
              key: 'detach',
              label: 'Open in new window',
              icon: <DetachGlyph />,
              onSelect: () => detachSession(session.id),
            }
        }
      })
    : []

  return (
    <>
      {/* The path, plus where that directory sits in git — one reading,
          one element (canvas `Feature - Git worktree` 1f). The git half
          is simply absent outside a repository. Its cell is what the fold
          watches (23d, TRIGGER). */}
      <WhereLine
        ref={cellRef}
        path={session ? shortenPath(session.cwd) : ''}
        fullPath={session?.cwd ?? ''}
        git={session?.git ?? null}
        sessionId={session?.id ?? null}
        panelWidthPx={pathBudgetPx}
        cellWidthPx={cellPx}
      />
      {lineage && lineage.length > 0 && (
        <span aria-label="Lineage" className="ml-2.5 flex shrink-0 items-center gap-1">
          {lineage.map((ancestorId) => (
            <span key={ancestorId} aria-hidden className="h-1.5 w-1.5 rounded-full bg-text-muted" />
          ))}
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-text-bright" />
        </span>
      )}
      {/* The walkthrough's entry (canvas 21f): the first icon of the
          strip, present only once there is something to walk through. Not
          one of the six, so it never folds. A detached window holds only
          this panel, so there it asks main to open the page in the main
          window instead of replacing itself (spec:
          2026-09-24-page-headers-design) — and without the bridge to ask
          through, it is not offered. */}
      {session &&
        (!standalone || hasDesktopBridge()) &&
        session.source === 'web' &&
        walkthroughEntry &&
        walkthroughEntry.steps > 0 && (
        <span className="ml-2.5 flex flex-none">
          <Tooltip
            title="Walkthrough"
            description={`${walkthroughEntry.steps} steps · ${walkthroughEntry.files} files`}
            align="right"
            delayMs={PIN_TOOLTIP_DELAY_MS}
          >
            <UtilityButton
              aria-label="Walkthrough"
              onClick={() =>
                standalone
                  ? openInMainWindow(walkthroughPath(session.id))
                  : window.location.assign(walkthroughPath(session.id))
              }
            >
              <WalkthroughGlyph />
            </UtilityButton>
          </Tooltip>
        </span>
      )}
      <span
        className="flex h-full flex-none items-center"
        onPointerEnter={() => setPointerIn(true)}
        onPointerLeave={() => setPointerIn(false)}
        onFocus={() => setFocusIn(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setFocusIn(false)
        }}
      >
        {/* Button-only mode (canvas `Feature - Header gauges` 11c): stats
            joins the strip as an icon — stats · pin · clear · end ‖ detach ·
            collapse (23a). Folded, it lives in the ⋯ menu. */}
        {present.stats &&
          seat('stats', <SessionStatsButton readout={readout} />)}
        {/* 4b: the pin sits left of Clear, and IS the pinned indicator —
            there is no status chip for it; the footer below carries the
            wording. It never folds. */}
        {session &&
          seat(
            'pin',
            <Tooltip
              title={pinned ? 'Unpin' : 'Pin'}
              description={
                pinned
                  ? releaseAfterMs == null
                    ? 'The release timer is off.'
                    : `Releases into history ${formatDuration(releaseAfterMs)} after it ended.`
                  : 'Keeps the session on the map — it is never released into history.'
              }
              align="right"
              delayMs={PIN_TOOLTIP_DELAY_MS}
            >
              <PinButton size={24} pinned={pinned} onToggle={onTogglePin} />
            </Tooltip>,
          )}
        {/* Clear lost its word when it joined the strip (9d draws three
            icons), so it carries a tooltip — an icon that wipes a
            conversation cannot be a guess. One line is enough for it
            (canvas `Feature - Header actions` 23b). */}
        {present.clear &&
          seat(
            'clear',
            <Tooltip variant="name" title="Clear and start over" align="right" delayMs={PIN_TOOLTIP_DELAY_MS}>
              <UtilityButton aria-label="Clear" onClick={onClear}>
                <ClearGlyph />
              </UtilityButton>
            </Tooltip>,
          )}
        {/* End session sits with the session actions, after Clear (23a),
            and never folds: it is the act that must always be found in the
            same spot (23c). Orbital sessions only, gone once the session has
            ended. It stays in a detached window: it is about the session,
            not the panel. Never one click: it opens a confirm. */}
        {present.end &&
          seat(
            'end',
            <Tooltip
              title="End session"
              description="Stops the agent and moves the session to history."
              align="right"
              delayMs={PIN_TOOLTIP_DELAY_MS}
            >
              <UtilityButton aria-label="End session" onClick={onEnd}>
                <EndGlyph />
              </UtilityButton>
            </Tooltip>,
          )}
        {/* The ⋯ (23c form 4), mounted whenever the strip can fold so that
            folding has a seat to grow. No tooltip: the menu under it names
            everything, and a bubble would hang in the menu's place. */}
        {isFoldable(present) &&
          seat(
            'more',
            <MenuButton
              aria-label="More"
              entries={menu}
              widthPx={MORE_MENU_PX}
              align="right"
              onOpenChange={setMenuOpen}
              renderTrigger={(props, open) => (
                <UtilityButton aria-label="More" open={open} {...props}>
                  <MoreGlyph />
                </UtilityButton>
              )}
            />,
          )}
        {/* Detach and collapse are a pair of their own, set tighter than
            the session actions before them: both are about where the panel
            is, not about the session (canvas `Feature - Detached window`
            22a). Detach is desktop only. Collapse deselects, as the × it
            replaced did (23a). The pair is the tooltips' `group` anchor. */}
        {(present.detach || present.collapse) && (
          <span className="relative flex h-full flex-none items-center">
            {present.detach &&
              session &&
              seat(
                'detach',
                <Tooltip
                  variant="name"
                  title="Open in new window"
                  align="right"
                  anchor="group"
                  delayMs={PIN_TOOLTIP_DELAY_MS}
                >
                  <UtilityButton aria-label="Open in new window" onClick={() => detachSession(session.id)}>
                    <DetachGlyph />
                  </UtilityButton>
                </Tooltip>,
              )}
            {present.collapse &&
              seat(
                'collapse',
                <Tooltip
                  variant="name"
                  title="Collapse panel"
                  align="right"
                  anchor="group"
                  delayMs={PIN_TOOLTIP_DELAY_MS}
                >
                  <UtilityButton aria-label="Collapse panel" onClick={onCollapse}>
                    <CollapseGlyph />
                  </UtilityButton>
                </Tooltip>,
              )}
          </span>
        )}
      </span>
      {readout.dialog}
    </>
  )
}
