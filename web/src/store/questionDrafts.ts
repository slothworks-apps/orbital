import type { AnswerMap } from '../lib/questionCard'

/**
 * The unsent answers of pending question cards, kept in `localStorage` by
 * decision id so they survive closing and reopening the window (spec
 * 2026-10-21-question-card-go-back-design § State). Shared by every window
 * of the origin — the main window and a detached session window — so no
 * window writes the whole record: each update is merged per decision id
 * into what storage holds at that moment, and `onQuestionDraftsChanged`
 * tells a window what another one wrote.
 *
 * Every read and write is best-effort — storage that is missing, full or
 * holding something unreadable costs only the persistence, never the card.
 * The first failure is recorded in the error log; the rest would only repeat it.
 */

const KEY = 'orbital.questionDrafts'

let recorded = false

/**
 * Through the error log, loaded lazily: `lib/errors` imports the store, and
 * the store reads its drafts here while it is being created.
 */
function recordOnce(err: unknown, message: string): void {
  if (recorded) return
  recorded = true
  void import('../lib/errors').then(({ recordError }) => recordError(err, message))
}

function parse(raw: string | null): Record<string, AnswerMap> {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    recordOnce(err, 'Could not read the saved question drafts')
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

export function readQuestionDrafts(): Record<string, AnswerMap> {
  let raw: string | null
  try {
    raw = globalThis.localStorage?.getItem(KEY) ?? null
  } catch (err) {
    recordOnce(err, 'Could not read the saved question drafts')
    return {}
  }
  return parse(raw)
}

/**
 * Writes `put` and removes `remove`, merged into what storage holds now —
 * so a draft another window wrote since this one last read survives. A
 * window removes only what it knows is settled, or what it changed itself.
 */
export function updateQuestionDrafts(put: Record<string, AnswerMap>, remove: Iterable<string> = []): void {
  try {
    const storage = globalThis.localStorage
    if (!storage) return
    const drafts = { ...parse(storage.getItem(KEY)), ...put }
    for (const id of remove) delete drafts[id]
    if (Object.keys(drafts).length === 0) storage.removeItem(KEY)
    else storage.setItem(KEY, JSON.stringify(drafts))
  } catch (err) {
    // Full or unavailable: the drafts live on in memory for this window.
    recordOnce(err, 'Could not save the question drafts')
  }
}

/**
 * Calls `listener` with the stored drafts whenever another window of the
 * origin changes them (the `storage` event never fires in the window that
 * wrote). Returns the unsubscribe.
 */
export function onQuestionDraftsChanged(listener: (drafts: Record<string, AnswerMap>) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const handle = (e: StorageEvent) => {
    // `key` is null when another window cleared the whole storage.
    if (e.key !== KEY && e.key !== null) return
    listener(parse(e.newValue))
  }
  window.addEventListener('storage', handle)
  return () => window.removeEventListener('storage', handle)
}
