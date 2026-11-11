import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { useOrbital } from '../store/store'
import { api } from './api'
import { foldProgress, type ProgressFold } from './progressList'
import type { ChatMessage } from './types'

/**
 * The tool's calls across the session's whole live branch, as the route
 * answered them, and the transcript load they were read for: `anchor` is the
 * first message the store held then. The list is folded from every call
 * since the first, and the store holds only the newest page until the user
 * scrolls up (spec 2026-11-09-progress-list-design § Where the state comes
 * from).
 */
export interface OlderCalls {
  anchor: ChatMessage
  calls: readonly ChatMessage[]
}

/**
 * The calls read for the transcript the store holds now, or null when they
 * have to be read again. They belong to the load whose first message is
 * still held — the same object, not an equal one: messages streamed in or
 * paged in above keep it, while a load that replaces the transcript — the
 * session picked again after the store let it go, a reconnect, a rewind's
 * reset — brings new objects, and calls read before it may be missing the
 * ones since or carry ones a rewind took back.
 */
export function olderCallsFor(held: readonly ChatMessage[], cached: OlderCalls | undefined): readonly ChatMessage[] | null {
  if (!cached || held.length === 0) return null
  return held.includes(cached.anchor) ? cached.calls : null
}

/** How long a failed read waits before it is tried again. */
export const OLDER_CALLS_RETRY_MS = 5_000

const useOlderCalls = create<{
  older: Record<string, OlderCalls>
  /** Bumped after a failed read's wait, so the session's readers try again. */
  retries: Record<string, number>
}>(() => ({ older: {}, retries: {} }))
/** The anchor each session's read in flight is for: one request per load. */
const reading = new Map<string, ChatMessage>()

/** Reads the session's calls and their answers for the load `anchor` starts, from the route that keeps only those. */
async function readOlderCalls(sessionId: string, anchor: ChatMessage): Promise<void> {
  if (reading.get(sessionId) === anchor) return
  reading.set(sessionId, anchor)
  let calls: ChatMessage[]
  try {
    calls = await api.getProgressCalls(sessionId)
  } catch {
    // The list goes with what the transcript holds meanwhile.
    if (reading.get(sessionId) === anchor) reading.delete(sessionId)
    setTimeout(() => {
      useOlderCalls.setState((s) => ({ retries: { ...s.retries, [sessionId]: (s.retries[sessionId] ?? 0) + 1 } }))
    }, OLDER_CALLS_RETRY_MS)
    return
  }
  if (reading.get(sessionId) === anchor) reading.delete(sessionId)
  useOlderCalls.setState((s) => ({ older: { ...s.older, [sessionId]: { anchor, calls } } }))
}

/**
 * A call or an answer by its tool id, which the file and the live stream
 * share: a launched session's store holds its calls under live ids the
 * route's file ids never match.
 */
const keyOf = (m: ChatMessage) => (m.toolUseId ? `${m.role}:${m.toolUseId}` : m.id)

const NO_MESSAGES: ChatMessage[] = []

/**
 * The session's progress list folded from its transcript, the calls from
 * before what the store holds read once per load of it, when the session
 * has a list. `loading` while that read is still out: the fold has only the
 * held page then.
 */
export function useProgressFold(sessionId: string | undefined): ProgressFold & { loading: boolean } {
  const messages = useOrbital((s) => (sessionId ? s.transcripts[sessionId] : undefined)) ?? NO_MESSAGES
  const hasList = useOrbital((s) => (sessionId ? s.sessions[sessionId]?.progress != null : false))
  const cached = useOlderCalls((s) => (sessionId ? s.older[sessionId] : undefined))
  const retry = useOlderCalls((s) => (sessionId ? (s.retries[sessionId] ?? 0) : 0))
  const older = useMemo(() => olderCallsFor(messages, cached), [messages, cached])
  const anchor = messages[0]
  const stale = older === null

  useEffect(() => {
    if (sessionId && hasList && anchor && stale) void readOlderCalls(sessionId, anchor)
  }, [sessionId, hasList, anchor, stale, retry])

  const loading = hasList && stale && anchor !== undefined
  return useMemo(() => {
    if (!older || older.length === 0) return { ...foldProgress(messages), loading }
    // The store holds the newest of them already, and the user may have
    // scrolled more of them in since.
    const held = new Set(messages.map(keyOf))
    return { ...foldProgress([...older.filter((m) => !held.has(keyOf(m))), ...messages]), loading }
  }, [messages, older, loading])
}

/**
 * Whether the session's list is frozen — a harness attached and leading in
 * its place, for good (spec § Turning it on) — and since when.
 */
export function useProgressFrozen(sessionId: string | undefined): { frozen: boolean; frozenAt: number | null } {
  const frozen = useOrbital((s) => (sessionId ? s.sessions[sessionId]?.progress?.frozen === true : false))
  const frozenAt = useOrbital((s) => (sessionId ? (s.sessions[sessionId]?.progress?.frozenAt ?? null) : null))
  return { frozen, frozenAt: frozen ? frozenAt : null }
}
