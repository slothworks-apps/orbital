import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import { dropSlot, movesItem, type DropSlot } from '../lib/dropSlot'
import { useEscapeLayer } from './escapeLayer'

/** Canvas `Feature - Tag chips`: a press becomes a drag after 4 px; less stays a click. */
const DRAG_THRESHOLD_PX = 4

export interface ReorderDrag {
  /** Index of the dragged item. */
  from: number
  /** The gap it would land in and its bar; null while the pointer is over no list. */
  drop: DropSlot | null
  /** Whether that gap moves the item at all — the bar shows only then. */
  moves: boolean
  /** Where the lifted copy sits, relative to the list, and its width. */
  ghost: { x: number; y: number; width: number }
}

interface Press {
  index: number
  startX: number
  startY: number
  offsetX: number
  offsetY: number
  width: number
  started: boolean
}

/** Marks the click a drag's release fires, for the item's onClick to ignore. */
function swallowNextClickInto(flag: { current: boolean }) {
  flag.current = true
  setTimeout(() => {
    flag.current = false
  }, 0)
}

/**
 * Pointer drag to reorder the items of one list (canvas `Feature - Tag
 * chips` 80a, 80d). Items carry `data-reorder-item`; the list is the
 * positioned box `listRef` points at, and every coordinate is relative to it.
 * Escape or a drop in place changes nothing, and the click a drag's release
 * fires is swallowed (`swallowClick`), so a chip that was dragged does not
 * also toggle.
 */
export function useReorderDrag(
  listRef: RefObject<HTMLElement | null>,
  axis: 'row' | 'column',
  inset: number,
  onMove: (from: number, slot: number) => void,
) {
  const [drag, setDragState] = useState<ReorderDrag | null>(null)
  /** The same drag, readable from the window listeners without a stale closure. */
  const dragNow = useRef<ReorderDrag | null>(null)
  const setDrag = useCallback((next: ReorderDrag | null) => {
    dragNow.current = next
    setDragState(next)
  }, [])
  const press = useRef<Press | null>(null)
  const swallow = useRef(false)
  const unbind = useRef<() => void>(() => {})
  const latest = useRef(onMove)
  latest.current = onMove

  /** Ends the press without a move: Escape, a cancelled pointer, the release itself. */
  const cancel = useRef<() => void>(() => {})

  useEffect(() => () => unbind.current(), [])
  // A drag is the innermost thing Escape can mean, so it peels the drag, not the panel.
  useEscapeLayer(drag != null, () => {
    swallowNextClickInto(swallow)
    cancel.current()
  })

  const track = useCallback((clientX: number, clientY: number) => {
    const p = press.current
    const list = listRef.current
    if (!p || !list) return
    // Relative to the list's content, so the bar and the lifted copy (both
    // absolute inside it) land right in a list that has scrolled.
    const box = list.getBoundingClientRect()
    const originX = box.left - list.scrollLeft
    const originY = box.top - list.scrollTop
    const x = clientX - originX
    const y = clientY - originY
    const rects = [...list.querySelectorAll<HTMLElement>('[data-reorder-item]')].map((el) => {
      const r = el.getBoundingClientRect()
      return { left: r.left - originX, top: r.top - originY, right: r.right - originX, bottom: r.bottom - originY }
    })
    const drop = dropSlot(rects, x, y, axis, inset)
    setDrag({
      from: p.index,
      drop,
      moves: drop != null && movesItem(p.index, drop.slot),
      ghost: { x: x - p.offsetX, y: y - p.offsetY, width: p.width },
    })
  }, [listRef, axis, inset, setDrag])

  const onPointerDown = useCallback((index: number, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    const item = e.currentTarget.closest<HTMLElement>('[data-reorder-item]') ?? e.currentTarget
    const r = item.getBoundingClientRect()
    press.current = {
      index, startX: e.clientX, startY: e.clientY,
      offsetX: e.clientX - r.left, offsetY: e.clientY - r.top, width: r.width, started: false,
    }
    unbind.current()

    const end = () => {
      unbind.current()
      press.current = null
      setDrag(null)
    }
    cancel.current = end
    const move = (ev: PointerEvent) => {
      const p = press.current
      if (!p) return
      if (!p.started) {
        if (Math.hypot(ev.clientX - p.startX, ev.clientY - p.startY) <= DRAG_THRESHOLD_PX) return
        p.started = true
      }
      ev.preventDefault()
      track(ev.clientX, ev.clientY)
    }
    const up = () => {
      const p = press.current
      if (p?.started) {
        swallowNextClickInto(swallow)
        const current = dragNow.current
        if (current?.drop && current.moves) latest.current(current.from, current.drop.slot)
      }
      end()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', end)
    unbind.current = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', end)
      unbind.current = () => {}
    }
  }, [track, setDrag])

  /** True for the click a drag's release fires; the item's onClick returns early on it. */
  const swallowClick = useCallback(() => swallow.current, [])

  return { drag, onPointerDown, swallowClick }
}
