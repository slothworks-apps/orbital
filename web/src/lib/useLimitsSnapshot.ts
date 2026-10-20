import { useEffect, useRef, useState } from 'react'
import { LIMITS_TOPIC } from '@orbital/shared/limits'
import { api } from './api'
import { getSocket } from './socket'
import type { LimitsSnapshot } from './types'

/**
 * The limits snapshot, kept current while `active`: read once the socket is
 * open (and again on every reopen, which may have missed a frame), then
 * whatever the server pushes on the `limits` topic. The server probes only
 * while someone watches that topic, so being inactive is what stops the
 * probe; the snapshot is dropped with it. A failed read keeps what was there.
 */
export function useLimitsSnapshot(active: boolean): LimitsSnapshot | null {
  const [snapshot, setSnapshot] = useState<LimitsSnapshot | null>(null)
  // Only the newest answer may land: a GET started before a pushed frame
  // must not overwrite it with an older read.
  const seq = useRef(0)

  useEffect(() => {
    if (!active) {
      setSnapshot(null)
      return
    }
    const socket = getSocket()
    // Nothing lands once inactive or unmounted.
    let live = true
    const load = () => {
      const mine = ++seq.current
      api.getLimits().then(
        (data) => {
          if (live && seq.current === mine) setSnapshot(data)
        },
        () => {},
      )
    }
    const off = socket.subscribe(LIMITS_TOPIC, (msg: { event?: string; limits?: LimitsSnapshot }) => {
      if (msg.event !== 'limits' || !msg.limits) return
      seq.current++
      setSnapshot(msg.limits)
    })
    const offStatus = socket.onStatusChange((status) => {
      if (status === 'open') load()
    })
    return () => {
      live = false
      off()
      offStatus()
    }
  }, [active])

  return snapshot
}
