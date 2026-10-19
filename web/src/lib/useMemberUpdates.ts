import { useCallback, useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { updatePollDelay, type ServerUpdateState } from '@orbital/shared/remote/serverUpdate'
import { applyRead, applyStart, startDecision, type MemberUpdate, type StartAnswer } from './memberUpdate'

/**
 * How long one read may take before it counts as unanswered: a read that
 * hangs (a phone's request over a relay that went quiet) must not stop the
 * polling it is part of, nor hold a press of Update.
 */
export const UPDATE_READ_TIMEOUT_MS = 15_000

function withTimeout<T>(promise: Promise<T>, ms = UPDATE_READ_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('update read timed out')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

/** What a press of Update or Try again came to: the confirm to show, started, not reached, or nothing to do. */
export type PressResult = 'confirm' | 'started' | 'unreachable' | 'none'

/**
 * What this device knows of each member's update, by member id. Kept while
 * Settings → Devices is closed, so a member read once still says `update
 * available` while it is offline; nothing reads it then.
 */
const useUpdates = create<{ byId: Record<string, MemberUpdate> }>()(() => ({ byId: {} }))

function put(id: string, next: (prev: MemberUpdate | undefined) => MemberUpdate): void {
  useUpdates.setState((s) => ({ byId: { ...s.byId, [id]: next(s.byId[id]) } }))
}

/** A member Settings → Devices may ask: `readable` while its presence and its version let it be asked now. */
export interface UpdateTarget {
  id: string
  readable: boolean
}

/**
 * How a surface asks: the desktop through `readMemberUpdate` /
 * `startMemberUpdate`, the phone through `readDeviceUpdate` /
 * `startDeviceUpdate`. Each answers null for a member that does not serve
 * the routes; a read that throws is a member that could not be reached.
 */
export interface UpdateIo {
  read(id: string): Promise<ServerUpdateState | null>
  start(id: string): Promise<StartAnswer | null>
}

/**
 * Settings → Devices' reads of the members' updates, while it is open: each
 * member once as it opens, and again whenever it comes back online; every
 * `UPDATE_POLL_MS` while one is updating (`updatePollDelay`), until it is
 * back or the wait runs out. Nothing is read once it closes.
 */
export function useMemberUpdates(targets: UpdateTarget[], io: UpdateIo) {
  const byId = useUpdates((s) => s.byId)
  const [starting, setStarting] = useState<string | null>(null)
  const ioRef = useRef(io)
  ioRef.current = io
  const targetsRef = useRef(targets)
  targetsRef.current = targets
  /** The members read since they last became readable: one read each per return. */
  const readHere = useRef(new Set<string>())

  /** One read, bounded by `UPDATE_READ_TIMEOUT_MS`; null when it failed or was not answered. */
  const fetchOne = useCallback(async (id: string): Promise<ServerUpdateState | null> => {
    try {
      return (await withTimeout(ioRef.current.read(id))) ?? null
    } catch {
      return null
    }
  }, [])

  /**
   * A read applied. Every answer advances the entry — null too (unreadable,
   * failed, not answered, or not served) — so a watch's next poll is armed
   * and its timeout can fire.
   */
  const readOne = useCallback(async (id: string) => {
    const readable = targetsRef.current.find((t) => t.id === id)?.readable ?? false
    const latest = readable ? await fetchOne(id) : null
    put(id, (prev) => applyRead(prev, latest, Date.now()))
  }, [fetchOne])

  const readableKey = targets.filter((t) => t.readable).map((t) => t.id).sort().join('\n')
  useEffect(() => {
    const readable = new Set(readableKey === '' ? [] : readableKey.split('\n'))
    for (const id of [...readHere.current]) if (!readable.has(id)) readHere.current.delete(id)
    for (const id of readable) {
      if (readHere.current.has(id)) continue
      readHere.current.add(id)
      void readOne(id)
    }
  }, [readableKey, readOne])

  const watched = targets.filter((t) => byId[t.id]?.watch).map((t) => t.id)
  const watchedKey = watched.join('\n')
  const delay = updatePollDelay({ pageOpen: true, watching: watched.length > 0 })
  useEffect(() => {
    if (delay === null) return
    const timer = setTimeout(() => {
      for (const id of watchedKey.split('\n')) void readOne(id)
    }, delay)
    return () => clearTimeout(timer)
    // `byId` re-arms the timer after every read, so a watch is read every `delay`.
  }, [delay, watchedKey, byId, readOne])

  /** Starts the update; false when the member could not be reached. */
  const startNow = useCallback(async (id: string): Promise<boolean> => {
    let answer: StartAnswer | null
    try {
      answer = await ioRef.current.start(id)
    } catch {
      return false
    }
    if (!answer) return false
    let reread = false
    put(id, (prev) => {
      const applied = applyStart(prev, answer, Date.now())
      reread = applied.reread
      return applied.next
    })
    if (reread) await readOne(id)
    return true
  }, [readOne])

  /**
   * Update or Try again pressed: the member is read again first, and that
   * answer decides (`startDecision`) — the confirm when it runs sessions now,
   * else the start at once. Nothing starts when it cannot be read.
   */
  const press = useCallback(async (id: string): Promise<PressResult> => {
    if (starting !== null) return 'none'
    setStarting(id)
    try {
      const latest = await fetchOne(id)
      if (latest === null) return 'unreachable'
      const fresh = applyRead(useUpdates.getState().byId[id], latest, Date.now())
      put(id, () => fresh)
      const online = targetsRef.current.find((t) => t.id === id)?.readable ?? false
      const decision = startDecision(fresh, online)
      if (decision !== 'start') return decision
      return (await startNow(id)) ? 'started' : 'unreachable'
    } finally {
      setStarting(null)
    }
  }, [starting, fetchOne, startNow])

  /** The confirm's Update: starts at once. */
  const start = useCallback(async (id: string): Promise<'started' | 'unreachable' | 'none'> => {
    if (starting !== null) return 'none'
    setStarting(id)
    try {
      return (await startNow(id)) ? 'started' : 'unreachable'
    } finally {
      setStarting(null)
    }
  }, [starting, startNow])

  return { byId, starting, press, start }
}
