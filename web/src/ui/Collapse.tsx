import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { EASE_CURVE, FADE_MS, HEIGHT_MS } from './motion'
import { prefersReducedMotion, usePresence } from './usePresence'

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
 * The inner box clips while closed — anything hanging off the content (a
 * dropdown) must be portalled.
 */
export function Collapse({
  open,
  appear = false,
  stagger = false,
  as: Tag = 'div',
  id,
  className,
  children,
}: {
  open: boolean
  appear?: boolean
  stagger?: boolean
  as?: 'div' | 'li'
  id?: string
  /** Layout-only (margins). */
  className?: string
  children: ReactNode
}) {
  // An appearing block mounts closed and opens on the next effect, so the
  // browser has a closed frame to transition from.
  const [armed, setArmed] = useState(!appear)
  useEffect(() => {
    if (!armed) setArmed(true)
  }, [armed])
  const total = stagger ? FADE_MS + HEIGHT_MS : HEIGHT_MS
  const { mounted, state } = usePresence(open && armed, total, total)
  if (!mounted) return null

  const shown = state === 'entered'
  const reduced = prefersReducedMotion()
  const transition = reduced
    ? 'none'
    : !stagger
      ? `grid-template-rows ${HEIGHT_MS}ms ${EASE_CURVE}, opacity ${HEIGHT_MS}ms ${EASE_CURVE}`
      : shown
        ? `grid-template-rows ${HEIGHT_MS}ms ${EASE_CURVE}, opacity ${FADE_MS}ms ease ${HEIGHT_MS}ms`
        : `opacity ${FADE_MS}ms ease, grid-template-rows ${HEIGHT_MS}ms ${EASE_CURVE} ${FADE_MS}ms`

  return (
    <Tag
      id={id}
      data-state={state}
      inert={state === 'exiting' || undefined}
      className={['grid', className ?? ''].filter(Boolean).join(' ')}
      style={{ gridTemplateRows: shown ? '1fr' : '0fr', opacity: shown ? 1 : 0, transition }}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </Tag>
  )
}
