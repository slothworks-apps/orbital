import type { AnswerMap } from '../lib/questionCard'

/**
 * The unsent answers of pending question cards, kept in `localStorage` by
 * decision id so they survive closing and reopening the window (spec
 * 2026-10-21-question-card-go-back-design § State). Local to this window's
 * origin: never synced to another window or device.
 *
 * Every read and write is best-effort — storage that is missing, full or
 * holding something unreadable costs only the persistence, never the card.
 */

const KEY = 'orbital.questionDrafts'

export function readQuestionDrafts(): Record<string, AnswerMap> {
  let raw: string | null
  try {
    raw = globalThis.localStorage?.getItem(KEY) ?? null
  } catch {
    return {}
  }
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, AnswerMap> = {}
  for (const [id, answers] of Object.entries(parsed as Record<string, unknown>)) {
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) continue
    const map: AnswerMap = {}
    for (const [question, answer] of Object.entries(answers as Record<string, unknown>)) {
      if (typeof answer === 'string') map[question] = answer
    }
    if (Object.keys(map).length > 0) out[id] = map
  }
  return out
}

export function writeQuestionDrafts(drafts: Record<string, AnswerMap>): void {
  try {
    const storage = globalThis.localStorage
    if (!storage) return
    if (Object.keys(drafts).length === 0) storage.removeItem(KEY)
    else storage.setItem(KEY, JSON.stringify(drafts))
  } catch {
    // Full or unavailable: the drafts live on in memory for this window.
  }
}
