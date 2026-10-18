import { useSyncExternalStore } from 'react'
import { AS_OF_TICK_MS } from './devices'

/**
 * One clock for every offline device's age (`as of 2 h`, canvas 50e/50h): a
 * map label and each sidebar row of an offline device read the same minute,
 * so a hundred of them cost one interval, not a hundred. It runs while any
 * of them shows and the window is visible; back in view, it reads the time
 * at once.
 */
const listeners = new Set<() => void>()
let now = Date.now()
let timer: ReturnType<typeof setInterval> | null = null

function tick(): void {
  now = Date.now()
  for (const listener of listeners) listener()
}

function sync(): void {
  const run = listeners.size > 0 && !document.hidden
  if (run && timer === null) {
    tick()
    timer = setInterval(tick, AS_OF_TICK_MS)
  } else if (!run && timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) document.addEventListener('visibilitychange', sync)
  sync()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) document.removeEventListener('visibilitychange', sync)
    sync()
  }
}

const idle = () => () => {}
const snapshot = () => now

/** The shared minute clock while `active`; inactive, a value nothing should read, and no timer. */
export function useAsOfNow(active: boolean): number {
  return useSyncExternalStore(active ? subscribe : idle, snapshot)
}
