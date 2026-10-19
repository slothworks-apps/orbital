import { useCallback, useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { updatePollDelay, type ServerUpdateState } from '@orbital/shared/remote/serverUpdate'
import { applyRead, applyStart, type MemberUpdate, type StartAnswer } from './memberUpdate'

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

  const readOne = useCallback(async (id: string) => {
    const readable = targetsRef.current.find((t) => t.id === id)?.readable ?? false
    let latest: ServerUpdateState | null = null
    if (readable) {
      try {
        latest = await ioRef.current.read(id)
        // Not served after all (its hello changed under the read): nothing to know.
        if (!latest) return
      } catch {
        latest = null
      }
    }
    put(id, (prev) => applyRead(prev, latest, Date.now()))
  }, [])

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

  const start = useCallback(async (id: string) => {
    if (starting !== null) return
    setStarting(id)
    try {
      const answer = await ioRef.current.start(id)
      if (!answer) return
      let reread = false
      put(id, (prev) => {
        const applied = applyStart(prev, answer, Date.now())
        reread = applied.reread
        return applied.next
      })
      if (reread) await readOne(id)
    } finally {
      setStarting(null)
    }
  }, [starting, readOne])

  return { byId, starting, start }
}
