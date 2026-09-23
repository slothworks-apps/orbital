import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { getSocket } from '../lib/socket'
import type { ApiSession, Walkthrough } from '../lib/types'
import type { SessionEvent, SessionsEvent } from '../store/store'

/** A burst of WS messages (a turn streaming in) becomes one refetch. */
export const WALKTHROUGH_REFETCH_DEBOUNCE_MS = 400

export interface WalkthroughData {
  session: ApiSession | null
  walkthrough: Walkthrough | null
  error: 'not_found' | 'failed' | null
  loading: boolean
  refetch(): void
}

/**
 * The page's data (spec § The page, "A live session grows under the page").
 * The spine is rebuilt server-side on every request, so the page simply asks
 * again whenever the session's topic delivers something; the row itself
 * (status, editor, title) is taken from the `sessions` topic without a
 * refetch. Only the newest request may write.
 */
export function useWalkthrough(id: string): WalkthroughData {
  const [session, setSession] = useState<ApiSession | null>(null)
  const [walkthrough, setWalkthrough] = useState<Walkthrough | null>(null)
  const [error, setError] = useState<WalkthroughData['error']>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)

  const refetch = useCallback(() => {
    const mine = ++seq.current
    api.getWalkthrough(id).then(
      (data) => {
        if (seq.current !== mine) return
        setSession(data.session)
        setWalkthrough(data.walkthrough)
        setError(null)
        setLoading(false)
      },
      (err: unknown) => {
        if (seq.current !== mine) return
        setError(err instanceof ApiError && err.status === 404 ? 'not_found' : 'failed')
        setLoading(false)
      },
    )
  }, [id])

  useEffect(() => { refetch() }, [refetch])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; refetch() }, WALKTHROUGH_REFETCH_DEBOUNCE_MS)
    }
    const release = getSocket().subscribe(`session:${id}`, (msg: SessionEvent) => {
      if (msg.event === 'message' || msg.event === 'status') schedule()
    })
    return () => { release(); if (timer) clearTimeout(timer) }
  }, [id, refetch])

  useEffect(() => {
    return getSocket().subscribe('sessions', (msg: SessionsEvent) => {
      if (msg.event === 'upsert' && msg.session.id === id) setSession(msg.session)
    })
  }, [id])

  return { session, walkthrough, error, loading, refetch }
}
