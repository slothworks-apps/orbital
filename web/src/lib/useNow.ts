import { useEffect, useState } from 'react'

/**
 * The wall clock, re-read every `intervalMs` while `active` — for the
 * elapsed-time labels that count up in place. Idle when inactive, so a
 * session that is not compacting costs no timer at all.
 */
export function useNow(active: boolean, intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [active, intervalMs])
  return now
}
