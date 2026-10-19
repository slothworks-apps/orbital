import { useCallback, useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { updatePollDelay, type ServerUpdateState, type UpdateWhen } from '@orbital/shared/remote/serverUpdate'
import {
  applyCancel, applyRead, applyStart, applyStartUnanswered, confirmDecision, startDecision, type CancelAnswer,
  type MemberUpdate, type StartAnswer, type StartDecision,
} from './memberUpdate'

/**
 * How long one read may take before it counts as unanswered: a read that
 * hangs (a phone's request over a relay that went quiet) must not stop the
 * polling it is part of, nor hold a press of Update.
 */
export const UPDATE_READ_TIMEOUT_MS = 15_000

/** A read or a start that got no answer within `UPDATE_READ_TIMEOUT_MS`. */
class Unanswered extends Error {}

function withTimeout<T>(promise: Promise<T>, ms = UPDATE_READ_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Unanswered('update read timed out')), ms)
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

/** What Cancel on a waiting member came to: the wait ended, not reached, or there was none to end. */
export type CancelResult = 'cancelled' | 'unreachable' | 'none'

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
 * `startMemberUpdate` / `cancelMemberUpdate`, the phone through
 * `readDeviceUpdate` / `startDeviceUpdate` / `cancelDeviceUpdate`. Each
 * answers null for a member that does not serve the routes; a read that
 * throws is a member that could not be reached.
 */
export interface UpdateIo {
  read(id: string): Promise<ServerUpdateState | null>
  start(id: string, when: UpdateWhen): Promise<StartAnswer | null>
  cancel(id: string): Promise<CancelAnswer | null>
}

/**
 * Settings → Devices' reads of the members' updates, while it is open: each
 * member once as it opens, and again whenever it comes back online; every
 * `UPDATE_POLL_MS` while one is updating or waits for its sessions
 * (`updatePollDelay`), until it is back or the wait runs out — the count a
 * wait names changes in place. Nothing is read once it closes.
 */
export function useMemberUpdates(targets: UpdateTarget[], io: UpdateIo) {
  const byId = useUpdates((s) => s.byId)
  const [starting, setStarting] = useState<string | null>(null)
  /** The press or start under way, set before any await: a second press while it runs does nothing. */
  const busy = useRef<string | null>(null)
  const ioRef = useRef(io)
  ioRef.current = io
  const targetsRef = useRef(targets)
  targetsRef.current = targets
  /** The members read since they last became readable: one read each per return. */
  const readHere = useRef(new Set<string>())
  /**
   * Per member, the number of the last answer asked for and of the last one
   * applied. An answer older than one already applied is dropped: a poll
   * that lands after a newer read, or after a start, would undo it.
   */
  const asked = useRef(new Map<string, number>())
  const applied = useRef(new Map<string, number>())

  const ticket = useCallback((id: string): number => {
    const n = (asked.current.get(id) ?? 0) + 1
    asked.current.set(id, n)
    return n
  }, [])

  /** Applies `next` when answer `n` is not older than one already applied; false when it was dropped. */
  const land = useCallback((id: string, n: number, next: (prev: MemberUpdate | undefined) => MemberUpdate): boolean => {
    if (n < (applied.current.get(id) ?? 0)) return false
    applied.current.set(id, n)
    put(id, next)
    return true
  }, [])

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
    const n = ticket(id)
    const readable = targetsRef.current.find((t) => t.id === id)?.readable ?? false
    const latest = readable ? await fetchOne(id) : null
    land(id, n, (prev) => applyRead(prev, latest, Date.now()))
  }, [fetchOne, ticket, land])

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
  const delay = updatePollDelay({ watching: watched.length > 0 })
  useEffect(() => {
    if (delay === null) return
    const timer = setTimeout(() => {
      for (const id of watchedKey.split('\n')) void readOne(id)
    }, delay)
    return () => clearTimeout(timer)
    // `byId` re-arms the timer after every read, so a watch is read every `delay`.
  }, [delay, watchedKey, byId, readOne])

  /**
   * Starts the update, bounded as a read is; false when the member could not
   * be reached or did not answer. Its answer is newer than any read asked
   * before it. One that did not answer may still have started it: the member
   * is watched, unconfirmed (`applyStartUnanswered`), so the poll shows it
   * updating once a read says so.
   */
  const startNow = useCallback(async (id: string, when: UpdateWhen = 'now'): Promise<boolean> => {
    let answer: StartAnswer | null
    try {
      answer = await withTimeout(ioRef.current.start(id, when))
    } catch (err) {
      if (err instanceof Unanswered) land(id, ticket(id), (prev) => applyStartUnanswered(prev, Date.now()))
      return false
    }
    if (!answer) return false
    let reread = false
    land(id, ticket(id), (prev) => {
      const next = applyStart(prev, answer, Date.now())
      reread = next.reread
      return next.next
    })
    if (reread) await readOne(id)
    return true
  }, [readOne, ticket, land])

  /** Runs `job` for `id` unless a press or start is under way; `starting` names it meanwhile. */
  const exclusive = useCallback(async <R>(id: string, job: () => Promise<R>): Promise<R | 'none'> => {
    if (busy.current !== null) return 'none'
    busy.current = id
    setStarting(id)
    try {
      return await job()
    } finally {
      busy.current = null
      setStarting(null)
    }
  }, [])

  /**
   * Reads the member again and decides with `decide`; starts when it says so.
   * When a newer answer landed while this read ran (a poll), the newest
   * state in the store decides instead of this read — never nothing.
   */
  const decideFresh = useCallback(async (
    id: string, decide: (fresh: MemberUpdate, online: boolean) => StartDecision, when: UpdateWhen = 'now',
  ): Promise<PressResult> => {
    const n = ticket(id)
    const latest = await fetchOne(id)
    if (latest === null) return 'unreachable'
    const read = applyRead(useUpdates.getState().byId[id], latest, Date.now())
    // A newer answer landed meanwhile (a start elsewhere on this screen cannot: this one holds it): it decides.
    const fresh = land(id, n, () => read) ? read : useUpdates.getState().byId[id]
    if (!fresh) return 'none'
    const online = targetsRef.current.find((t) => t.id === id)?.readable ?? false
    const decision = decide(fresh, online)
    if (decision !== 'start') return decision
    return (await startNow(id, when)) ? 'started' : 'unreachable'
  }, [ticket, fetchOne, land, startNow])

  /**
   * Update or Try again pressed: the member is read again first, and that
   * answer decides (`startDecision`) — the confirm when it runs sessions now,
   * else the start at once. Nothing starts when it cannot be read.
   */
  const press = useCallback((id: string): Promise<PressResult> => exclusive(id, () => decideFresh(id, startDecision)), [
    exclusive, decideFresh,
  ])

  /**
   * The confirm's Update now or Update when sessions finish: the member is
   * read again too. Update now, when it runs more sessions than the confirm
   * named, answers `confirm` again — the screen keeps the confirm open, and
   * it names the new count. Update when sessions finish waits for however
   * many run, so more of them ask nothing.
   */
  const start = useCallback((id: string, when: UpdateWhen = 'now'): Promise<PressResult> => exclusive(id, () => {
    const shown = useUpdates.getState().byId[id]?.state?.sessions ?? 0
    const decide = when === 'idle'
      ? (fresh: MemberUpdate, online: boolean) => {
        const decision = startDecision(fresh, online)
        return decision === 'confirm' ? 'start' : decision
      }
      : (fresh: MemberUpdate, online: boolean) => confirmDecision(shown, fresh, online)
    return decideFresh(id, decide, when)
  }), [exclusive, decideFresh])

  /**
   * Cancel on a member that waits for its sessions: no confirm (canvas 50t
   * WAITING). Its answer is newer than any read asked before it; one that
   * says nothing waits (it installs already, or another member cancelled
   * first) is shown by reading it again.
   */
  const cancel = useCallback((id: string): Promise<CancelResult> => exclusive(id, async () => {
    let answer: CancelAnswer | null
    try {
      answer = await withTimeout(ioRef.current.cancel(id))
    } catch {
      return 'unreachable'
    }
    if (!answer) return 'none'
    let reread = false
    land(id, ticket(id), (prev) => {
      const next = applyCancel(prev, answer)
      reread = next.reread
      return next.next
    })
    if (reread) {
      await readOne(id)
      return 'none'
    }
    return 'cancelled'
  }), [exclusive, land, ticket, readOne])

  return { byId, starting, press, start, cancel }
}
