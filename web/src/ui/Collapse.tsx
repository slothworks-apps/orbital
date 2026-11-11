import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { EASE_CURVE, FADE_MS, HEIGHT_MS } from './motion'
import { prefersReducedMotion, usePresence } from './usePresence'

/** A block's own clock, where it is not the shared one (`HEIGHT_MS`, `FADE_MS`, `EASE_CURVE`). */
export interface CollapseTiming {
  /** How long the height (and a `pull`) takes. */
  heightMs: number
  /** How long the fade takes, alongside the height. */
  fadeMs: number
  /** The height's curve. */
  ease: string
}

/** `unclip` lets go of the clip this long after the height has finished, so the last frame is not cut. */
const UNCLIP_AFTER_MS = 20

/**
 * A block that opens and closes by its height — a row's detail, a row arriving
 * in or leaving a list — so what is below it glides instead of jumping.
 *
 * Built on `grid-template-rows: 0fr → 1fr`, which transitions to the
 * content's own height without measuring it. Held mounted through the close
 * (`usePresence`) and unmounted once it has finished.
 *
 * `stagger` runs the two halves one after the other: closing fades first and
 * then gives the height back, so a leaving row is seen to go before the rows
 * below move up; opening makes room first and then fades in. Without it the
 * height and the fade run together, which suits a detail block under a row.
 *
 * `appear` animates the first mount too (a row that arrives while the list is
 * on screen); without it a block that starts open is simply there.
 *
 * `keepMounted` never unmounts it: closed, it is hidden, `inert` and out of
 * the accessibility tree once its height is gone — for fields whose values
 * must survive a close (New session's BRANCH and BASE, canvas 63a). `pull`
 * pulls it up by that many pixels while closed, so a gap its parent puts
 * before it closes too and a closed block takes no room at all. `unclip`
 * stops clipping once it has settled open, so an outline or a focus ring at
 * its edge is not cut.
 *
 * The inner box clips while it moves and while closed — anything hanging off
 * the content (a dropdown) must be portalled.
 */
export function Collapse({
  open,
  appear = false,
  stagger = false,
  keepMounted = false,
  pull = 0,
  unclip = false,
  timing,
  as: Tag = 'div',
  id,
  className,
  children,
}: {
  open: boolean
  appear?: boolean
  stagger?: boolean
  keepMounted?: boolean
  pull?: number
  unclip?: boolean
  timing?: CollapseTiming
  as?: 'div' | 'li'
  id?: string
  /** Layout-only (margins). */
  className?: string
  children: ReactNode
}) {
  const heightMs = timing?.heightMs ?? HEIGHT_MS
  const fadeMs = timing?.fadeMs ?? (stagger ? FADE_MS : heightMs)
  const ease = timing?.ease ?? EASE_CURVE
  // An appearing block mounts closed and opens on the next effect, so the
  // browser has a closed frame to transition from.
  const [armed, setArmed] = useState(!appear)
  useEffect(() => {
    if (!armed) setArmed(true)
  }, [armed])
  const total = stagger ? fadeMs + heightMs : heightMs
  const presence = usePresence(keepMounted || (open && armed), total, total)
  const shown = keepMounted ? open && armed : presence.state === 'entered'

  // Settled open: the height has finished, and the clip can go.
  const [settled, setSettled] = useState(shown)
  useEffect(() => {
    if (!unclip) return
    if (!shown) {
      setSettled(false)
      return
    }
    const timer = setTimeout(() => setSettled(true), heightMs + UNCLIP_AFTER_MS)
    return () => clearTimeout(timer)
  }, [unclip, shown, heightMs])

  if (!presence.mounted) return null

  const reduced = prefersReducedMotion()
  const extras = [
    pull !== 0 ? `margin-top ${heightMs}ms ${ease}` : null,
    // Hidden only once the height is gone; shown at once on the way in.
    keepMounted ? `visibility 0s linear ${shown ? 0 : total}ms` : null,
  ].filter(Boolean)
  const base = !stagger
    ? `grid-template-rows ${heightMs}ms ${ease}, opacity ${fadeMs}ms ${timing ? 'ease' : ease}`
    : shown
      ? `grid-template-rows ${heightMs}ms ${ease}, opacity ${fadeMs}ms ease ${heightMs}ms`
      : `opacity ${fadeMs}ms ease, grid-template-rows ${heightMs}ms ${ease} ${fadeMs}ms`
  const transition = reduced ? 'none' : [base, ...extras].join(', ')
  const closedAndKept = keepMounted && !shown

  return (
    <Tag
      id={id}
      data-state={keepMounted ? (shown ? 'entered' : 'closed') : presence.state}
      inert={presence.state === 'exiting' || closedAndKept || undefined}
      aria-hidden={closedAndKept || undefined}
      className={['grid', className ?? ''].filter(Boolean).join(' ')}
      style={{
        gridTemplateRows: shown ? '1fr' : '0fr',
        opacity: shown ? 1 : 0,
        ...(pull !== 0 ? { marginTop: shown ? 0 : pull } : {}),
        // Open, it takes its parent's visibility rather than forcing `visible`,
        // which would show it through an ancestor hidden with `invisible`
        // (New session's step 1 under the harness step, say).
        ...(keepMounted ? { visibility: shown ? 'inherit' : 'hidden' } : {}),
        transition,
      }}
    >
      <div className="min-h-0" style={{ overflow: unclip && settled && shown ? 'visible' : 'hidden' }}>
        {children}
      </div>
    </Tag>
  )
}
