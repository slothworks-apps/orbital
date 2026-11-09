import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { PROGRESS_TOOL } from '@orbital/shared/progress'
import { useOrbital } from '../store/store'
import { api } from './api'
import { foldProgress, type ProgressFold } from './progressList'
import type { ChatMessage } from './types'

/** The largest page the messages route answers. */
const OLDER_PAGE = 500
/** How far back a list is looked for: past this, the list is what the transcript held shows. */
const OLDER_PAGES_MAX = 20

/**
 * The tool's calls from before the transcript the store holds, per session:
 * the list is folded from every call since the first, and the store holds
 * only the newest page until the user scrolls up (spec
 * 2026-11-09-progress-list-design § Where the state comes from).
 */
const useOlderCalls = create<{ older: Record<string, readonly ChatMessage[]> }>(() => ({ older: {} }))
const reading = new Set<string>()

const isCall = (m: ChatMessage) => m.role === 'tool_use' && m.toolName === PROGRESS_TOOL

/** Reads the session's transcript back from `before`, once, keeping only the tool's calls and their answers. */
async function readOlderCalls(sessionId: string, before: string): Promise<void> {
  if (reading.has(sessionId)) return
  reading.add(sessionId)
  const pages: ChatMessage[][] = []
  let cursor = before
  try {
    for (let i = 0; i < OLDER_PAGES_MAX; i++) {
      const { messages } = await api.getMessagesPage(sessionId, { before: cursor, limit: OLDER_PAGE })
      if (messages.length > 0) pages.unshift(messages)
      if (messages.length < OLDER_PAGE) break
      cursor = messages[0].id
    }
  } catch {
    // The list goes with what the transcript held; the next session pick asks again.
    reading.delete(sessionId)
    return
  }
  const all = pages.flat()
  const ids = new Set(all.filter(isCall).map((m) => m.toolUseId))
  const kept = all.filter((m) => isCall(m) || (m.role === 'tool_result' && ids.has(m.toolUseId)))
  useOlderCalls.setState((s) => ({ older: { ...s.older, [sessionId]: kept } }))
}

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
    if (sessionId && hasList && first && older === undefined) void readOlderCalls(sessionId, first)
  }, [sessionId, hasList, first, older])

  return useMemo(() => {
    if (!older || older.length === 0) return foldProgress(messages)
    // The user may have scrolled some of them into the store since.
    const held = new Set(messages.map((m) => m.id))
    return foldProgress([...older.filter((m) => !held.has(m.id)), ...messages])
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
