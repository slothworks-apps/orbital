import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { useOrbital } from '../store/store'
import { api } from './api'
import { foldProgress, type ProgressFold } from './progressList'
import type { ChatMessage } from './types'

/**
 * The tool's calls from before the transcript the store holds, per session:
 * the list is folded from every call since the first, and the store holds
 * only the newest page until the user scrolls up (spec
 * 2026-11-09-progress-list-design § Where the state comes from).
 */
const useOlderCalls = create<{ older: Record<string, readonly ChatMessage[]> }>(() => ({ older: {} }))
const reading = new Set<string>()

/** Reads the session's calls and their answers, once, from the route that keeps only those. */
async function readOlderCalls(sessionId: string): Promise<void> {
  if (reading.has(sessionId)) return
  reading.add(sessionId)
  let calls: ChatMessage[]
  try {
    calls = await api.getProgressCalls(sessionId)
  } catch {
    // The list goes with what the transcript held; the next session pick asks again.
    reading.delete(sessionId)
    return
  }
  useOlderCalls.setState((s) => ({ older: { ...s.older, [sessionId]: calls } }))
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
 * before what the store holds read once when the session has a list.
 */
export function useProgressFold(sessionId: string | undefined): ProgressFold {
  const messages = useOrbital((s) => (sessionId ? s.transcripts[sessionId] : undefined)) ?? NO_MESSAGES
  const hasList = useOrbital((s) => (sessionId ? s.sessions[sessionId]?.progress != null : false))
  const older = useOlderCalls((s) => (sessionId ? s.older[sessionId] : undefined))
  const first = messages[0]?.id

  useEffect(() => {
    if (sessionId && hasList && first && older === undefined) void readOlderCalls(sessionId)
  }, [sessionId, hasList, first, older])

  return useMemo(() => {
    if (!older || older.length === 0) return foldProgress(messages)
    // The store holds the newest of them already, and the user may have
    // scrolled more of them in since.
    const held = new Set(messages.map(keyOf))
    return foldProgress([...older.filter((m) => !held.has(keyOf(m))), ...messages])
  }, [messages, older])
}

/**
 * Whether the session's list is frozen — a harness attached and leading in
 * its place (spec § Turning it on) — and since when, once the harness is read.
 */
export function useProgressFrozen(sessionId: string | undefined): { frozen: boolean; frozenAt: number | null } {
  const frozen = useOrbital((s) => (sessionId ? s.sessions[sessionId]?.progress?.frozen === true : false))
  const attachedAt = useOrbital((s) => (sessionId ? (s.harnesses[sessionId]?.createdAt ?? null) : null))
  return { frozen, frozenAt: frozen ? attachedAt : null }
}
