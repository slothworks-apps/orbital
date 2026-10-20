import { useCallback, useEffect, useRef, useState } from 'react'
import { LIMITS_TOPIC } from '@orbital/shared/limits'
import { api } from './api'
import { recordError } from './errors'
import { getSocket } from './socket'
import type { LimitsSnapshot } from './types'

export interface LimitsReading {
  /** The last reading; null before the first one landed. */
  snapshot: LimitsSnapshot | null
  /** Why the last read failed, until a read or a frame lands; null otherwise. */
  failed: string | null
  /** Read again is running. */
  reading: boolean
  /** Read again: the server reads now (every member, on the phone) instead of on its interval. */
  refresh: () => void
}

/**
 * The limits snapshot, kept current while the page is visible: read once the
 * socket is open (and again on every reopen, which may have missed a frame),
 * then whatever the server pushes on the `limits` topic. The server probes
 * only while someone watches that topic, so a hidden page lets go of it and
 * a page shown again reads and watches again. A failed read keeps what was
 * there and is recorded in the error log; the view says it in its own place.
 *
 * The phone's transport answers the same calls for its whole group
 * (`GroupFederation`), so the desktop's page, the map's suns and the phone's
 * screen all read through here.
 */
export function useLimitsSnapshot(): LimitsReading {
  const [snapshot, setSnapshot] = useState<LimitsSnapshot | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  // Only the newest answer may land: a read started before a pushed frame
  // must not overwrite it with an older one.
  const seq = useRef(0)
  // Nothing lands once unmounted.
  const live = useRef(true)
  const readingRef = useRef(false)

  const read = useCallback((refresh: boolean): Promise<void> => {
    const mine = ++seq.current
    return (refresh ? api.refreshLimits() : api.getLimits()).then(
      (data) => {
        if (!live.current || seq.current !== mine) return
        setSnapshot(data)
        setFailed(null)
      },
      (err: unknown) => {
        recordError(err, 'Could not read the plan limits')
        if (live.current && seq.current === mine) setFailed(err instanceof Error ? err.message || 'request failed' : String(err))
      },
    )
  }, [])

  useEffect(() => {
    live.current = true
    const socket = getSocket()
    let unwatch: (() => void) | null = null
    const watch = () => {
      if (unwatch) return
      const off = socket.subscribe(LIMITS_TOPIC, (msg: { event?: string; limits?: LimitsSnapshot }) => {
        if (msg.event !== 'limits' || !msg.limits) return
        seq.current++
        setSnapshot(msg.limits)
        setFailed(null)
      })
      // Called at once with the current status: an open socket reads now.
      const offStatus = socket.onStatusChange((status) => {
        if (status === 'open') void read(false)
      })
      unwatch = () => {
        off()
        offStatus()
        unwatch = null
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') unwatch?.()
      else watch()
    }
    onVisibility()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      live.current = false
      document.removeEventListener('visibilitychange', onVisibility)
      unwatch?.()
    }
  }, [read])

  const refresh = useCallback(() => {
    if (readingRef.current) return
    readingRef.current = true
    setReading(true)
    void read(true).finally(() => {
      readingRef.current = false
      if (live.current) setReading(false)
    })
  }, [read])

  return { snapshot, failed, reading, refresh }
}
