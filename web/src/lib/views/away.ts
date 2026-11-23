import { useSyncExternalStore } from 'react'

/**
 * Whether the user has been away from Orbital for longer than a view's sleep
 * delay (spec 2026-11-18-generated-views-design § In the transcript): the
 * page hidden (another tab, the phone app in the background, a minimised
 * window), or the window without focus. A view that is not waiting sleeps
 * then, as it does scrolled out of sight, and wakes when the user is back.
 *
 * One set of listeners for every view on screen. A click into a view's frame
 * blurs this window too, but `document.hasFocus()` stays true while the focus
 * is in a frame of it, so that never counts as away.
 */

/**
 * 69c ASLEEP: "off screen for a while, the page is unloaded". How long a
 * while is, the canvas does not say: not traced. Scrolled away or away from
 * Orbital, the same while.
 */
export const VIEW_SLEEP_AFTER_MS = 30_000

let away = false
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function set(next: boolean): void {
  if (away === next) return
  away = next
  listeners.forEach((listener) => listener())
}

function gone(): boolean {
  return document.visibilityState === 'hidden' || !document.hasFocus()
}

/** The user may have left: look again once the delay has passed, unless they are back by then. */
function arm(): void {
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    if (gone()) set(true)
    // Still here, the focus in a view's frame: leaving from there blurs the
    // frame, not this window, so look again later.
    else if (document.activeElement instanceof HTMLIFrameElement) arm()
  }, VIEW_SLEEP_AFTER_MS)
}

function back(): void {
  if (gone()) return
  if (timer !== null) clearTimeout(timer)
  timer = null
  set(false)
}

function onVisibility(): void {
  if (document.visibilityState === 'hidden') arm()
  else back()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('blur', arm)
    window.addEventListener('focus', back)
    window.addEventListener('pointerdown', back, true)
    if (gone()) arm()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0) return
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('blur', arm)
    window.removeEventListener('focus', back)
    window.removeEventListener('pointerdown', back, true)
    if (timer !== null) clearTimeout(timer)
    timer = null
    away = false
  }
}

const snapshot = () => away

/** True while the user has been away from Orbital for longer than `VIEW_SLEEP_AFTER_MS`. */
export function useAwayFromOrbital(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false)
}
