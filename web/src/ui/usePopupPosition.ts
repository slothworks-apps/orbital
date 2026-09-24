import { useCallback, useEffect, useLayoutEffect } from 'react'
import type { RefObject } from 'react'

/**
 * Fixed-position popup mechanics, extracted verbatim from `ui/Select` so the
 * composer's completion list can reuse them (spec:
 * 2026-09-20-composer-design § Completion popup).
 *
 * Why the popup is portalled to `<body>` and positioned from the anchor's rect
 * rather than absolutely positioned next to it — two things that have both
 * already bitten this codebase: a `backdrop-filter` ancestor (every `Panel`,
 * back when the docked ones were frosted glass) becomes the containing block
 * for `position: fixed` descendants, and the
 * rules table, the settings body and the detail panel are overflow containers
 * that would clip an absolutely-positioned popup.
 *
 * The hook only writes inline styles on the popup — `top`, `left`,
 * `max-height`, `min-width`, optionally `width`, plus `data-placement` — so it
 * never re-renders anything and is safe to run on every commit.
 */

/**
 * The shell every anchored dropdown wears — `Select`'s listbox and
 * `MenuButton`'s menu. Canvas 1b draws it literally, and `Feature - Header
 * actions` 23c repeats it for the ⋯ menu: 10px radius, a flat
 * rgba(10,16,28,.96) fill (not the panels' gradient glass), a .16 hairline
 * and a single soft drop shadow. Padding stays with each caller — 1b's
 * listbox and 23c's menu differ there.
 */
export const POPUP_SHELL = [
  'rounded-[10px] border border-[rgba(150,205,255,.16)] bg-[rgba(10,16,28,.96)] backdrop-blur-[12px]',
  'shadow-[0_14px_34px_rgba(0,0,0,.55)]',
].join(' ')

/** Minimum clearance between the popup and the edge of the viewport. */
const VIEWPORT_MARGIN = 8
/** Never squeeze the popup below this; below it, flip instead. */
const MIN_POPUP_HEIGHT = 96

export interface PopupPositionOptions {
  /** Distance between the anchor's edge and the popup (Select 4px, composer 8px). */
  gap: number
  /**
   * Which side to take when both fit. `below` is the platform default a
   * `Select` wants; the composer asks for `above` on the panel floor, where a
   * list below the field would be off-panel (canvas 9b).
   */
  prefer?: 'below' | 'above'
  /** `right` hangs the popup off the anchor's right edge (canvas 3a's origin filter). */
  align?: 'left' | 'right'
  /** Width floor, over and above the anchor's own width. */
  minWidth?: number
  /** Pin the popup to the anchor's width exactly (canvas 9e: popup width = the well's). */
  matchAnchorWidth?: boolean
}

export function usePopupPosition(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  popupRef: RefObject<HTMLElement | null>,
  { gap, prefer = 'below', align = 'left', minWidth = 0, matchAnchorWidth = false }: PopupPositionOptions,
): void {
  const reposition = useCallback(() => {
    const anchor = anchorRef.current
    const popup = popupRef.current
    if (!anchor || !popup) return

    const rect = anchor.getBoundingClientRect()
    // Measure unconstrained first, so the flip decision is made against the
    // height the list actually wants rather than against last frame's cap.
    popup.style.maxHeight = ''
    const natural = popup.offsetHeight

    const below = window.innerHeight - rect.bottom - gap - VIEWPORT_MARGIN
    const above = rect.top - gap - VIEWPORT_MARGIN
    const wantAbove = prefer === 'above'
    const preferred = wantAbove ? above : below
    const other = wantAbove ? below : above
    // Only give up the preferred side when the list does not fit there AND the
    // other side is roomier. With `prefer: 'below'` this is Select's own rule.
    const flip = natural > preferred && other > preferred
    const placeAbove = wantAbove !== flip

    const maxHeight = Math.max(MIN_POPUP_HEIGHT, placeAbove ? above : below)
    popup.style.maxHeight = `${maxHeight}px`

    const height = Math.min(natural, maxHeight)
    popup.style.top = placeAbove ? `${rect.top - gap - height}px` : `${rect.bottom + gap}px`
    popup.dataset.placement = placeAbove ? 'above' : 'below'

    if (matchAnchorWidth) popup.style.width = `${rect.width}px`
    popup.style.minWidth = `${Math.max(rect.width, minWidth)}px`
    const width = popup.offsetWidth
    const maxLeft = window.innerWidth - width - VIEWPORT_MARGIN
    const wanted = align === 'right' ? rect.right - width : rect.left
    popup.style.left = `${Math.max(VIEWPORT_MARGIN, Math.min(wanted, maxLeft))}px`
  }, [anchorRef, popupRef, gap, prefer, align, minWidth, matchAnchorWidth])

  // Every commit while open, so a list whose rows changed is re-measured
  // without the caller having to declare its own content as a dependency.
  // Writing inline styles cannot loop back into a render.
  useLayoutEffect(() => {
    if (open) reposition()
  })

  // Re-measure rather than close: a scroll inside the rules table or the
  // settings body must not yank the popup away mid-interaction.
  useEffect(() => {
    if (!open) return
    const onViewportChange = () => reposition()
    window.addEventListener('scroll', onViewportChange, true)
    window.addEventListener('resize', onViewportChange)
    return () => {
      window.removeEventListener('scroll', onViewportChange, true)
      window.removeEventListener('resize', onViewportChange)
    }
  }, [open, reposition])
}
