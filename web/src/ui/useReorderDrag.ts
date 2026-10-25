import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import { dropSlot, movesItem, type DropSlot } from '../lib/dropSlot'
import { slotToIndex } from '../lib/tagFilter'
import { useEscapeLayer } from './escapeLayer'

/** Canvas `Feature - Tag chips`: a press becomes a drag after 4 px; less stays a click. */
const DRAG_THRESHOLD_PX = 4

/**
 * How far past the list's edge the pointer may stray and still drop into it.
 * Further out, the drop is off: letting go over the map or the session rows
 * changes nothing, the way Escape does not.
 */
const DROP_REACH_PX = 12

export interface ReorderDrag {
  /** Index of the dragged item. */
  from: number
  /** The gap it would land in and its bar, relative to the list; null when letting go would move nothing. */
  drop: DropSlot | null
  /** Where the lifted copy sits, in viewport coordinates (it is drawn `fixed`, outside any clipping box), and its width. */
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

/**
 * Pointer drag to reorder the items of one list (canvas `Feature - Tag
 * chips` 80a, 80d). Items carry `data-reorder-item`; the list is the
 * positioned box `listRef` points at, and the drop bar's coordinates are
 * relative to it. `onMove` gets the index the dragged item moves to. Escape,
 * a drop in place or a release away from the list changes nothing, and the
 * click a drag's release fires is swallowed (`swallowClick`), so an item that
 * was dragged does not also toggle or select.
 */
export function useReorderDrag(
  listRef: RefObject<HTMLElement | null>,
  axis: 'row' | 'column',
  inset: number,
  onMove: (from: number, to: number) => void,
) {
  const [drag, setDragState] = useState<ReorderDrag | null>(null)
  /** The same drag, readable from the window listeners without a stale closure. */
  const dragNow = useRef<ReorderDrag | null>(null)
  const setDrag = useCallback((next: ReorderDrag | null) => {
    dragNow.current = next
    setDragState(next)
  }, [])
  const press = useRef<Press | null>(null)
  /** True from a drag's end until the click its release fires has passed. */
  const swallow = useRef(false)
  const unbind = useRef<() => void>(() => {})
  const latest = useRef(onMove)
  latest.current = onMove
  /** Ends the drag without a move, swallowing the click the button's release will still fire. */
  const cancel = useRef<() => void>(() => {})

  useEffect(() => () => unbind.current(), [])
  // A drag is the innermost thing Escape can mean, so it peels the drag, not the panel.
  useEscapeLayer(drag != null, () => cancel.current())

  const track = useCallback((clientX: number, clientY: number) => {
    const p = press.current
    const list = listRef.current
    if (!p || !list) return
    // Relative to the list's content, so the bar (absolute inside it) lands
    // right in a list that has scrolled.
    const box = list.getBoundingClientRect()
    const near =
      clientX >= box.left - DROP_REACH_PX && clientX <= box.right + DROP_REACH_PX &&
      clientY >= box.top - DROP_REACH_PX && clientY <= box.bottom + DROP_REACH_PX
    const originX = box.left - list.scrollLeft
    const originY = box.top - list.scrollTop
    const rects = [...list.querySelectorAll<HTMLElement>('[data-reorder-item]')].map((el) => {
      const r = el.getBoundingClientRect()
      return { left: r.left - originX, top: r.top - originY, right: r.right - originX, bottom: r.bottom - originY }
    })
    const slot = near ? dropSlot(rects, clientX - originX, clientY - originY, axis, inset) : null
    setDrag({
      from: p.index,
      drop: slot && movesItem(p.index, slot.slot) ? slot : null,
      ghost: { x: clientX - p.offsetX, y: clientY - p.offsetY, width: p.width },
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

    const stop = () => {
      unbind.current()
      press.current = null
      setDrag(null)
    }
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
        // The click this release fires comes next, in the same task.
        swallow.current = true
        setTimeout(() => {
          swallow.current = false
        }, 0)
        const drop = dragNow.current?.drop
        if (drop) latest.current(p.index, slotToIndex(p.index, drop.slot))
      }
      stop()
    }
    cancel.current = () => {
      stop()
      // The button is still down: swallow the click its release fires, wherever that is.
      swallow.current = true
      const release = () => {
        window.removeEventListener('pointerup', release, true)
        setTimeout(() => {
          swallow.current = false
        }, 0)
      }
      window.addEventListener('pointerup', release, true)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', stop)
    unbind.current = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', stop)
      unbind.current = () => {}
    }
  }, [track, setDrag])

  /** True for the click a drag's release fires; the item's onClick returns early on it. */
  const swallowClick = useCallback(() => swallow.current, [])

  return { drag, onPointerDown, swallowClick }
}
