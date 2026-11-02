import { create } from 'zustand'

/**
 * Text that something outside the composer puts into it: the path menu's
 * Mention in reply (spec 2026-11-02-bare-file-names-and-path-menu-design §
 * The context menu). The composer had no way in from outside; the request
 * waits here, the panel's composer for that session takes it, inserts it at
 * its caret and takes focus. Kept out of the main store the way the session
 * menu's state is.
 */
export interface ComposerInsert {
  sessionId: string
  /** What goes in: `@path` or `@path:line`. */
  text: string
  /** The mention's path, without its line: inserted, it is confirmed, and tinted at once. */
  path: string
  /** Tells two requests for the same text apart. */
  id: number
}

export const useComposerInsert = create<{ request: ComposerInsert | null }>(() => ({ request: null }))

let nextId = 0

/** Puts a mention of `path` into `sessionId`'s composer, at its caret. */
export function mentionInReply(sessionId: string, mention: { text: string; path: string }): void {
  nextId += 1
  useComposerInsert.setState({ request: { sessionId, ...mention, id: nextId } })
}

/** The composer took request `id`; a newer one stays. */
export function takeComposerInsert(id: number): void {
  if (useComposerInsert.getState().request?.id === id) useComposerInsert.setState({ request: null })
}
