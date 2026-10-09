import { useOrbital } from '../../store/store'

/**
 * What a Restart into a new bundle carries across the reload (canvas `Feature
 * - Phone update`: "any draft is kept"): the composers' drafts, which live in
 * memory only, and the version the restart frame names. Written just before
 * the reload and taken once by the bundle that starts after it.
 *
 * localStorage, not Preferences: it is synchronous, so the frame can show
 * before anything awaits, and both bundles are served from the same origin.
 */

const RESTART_STASH = 'orbital.update.restart'

export interface RestartStash {
  version: string
  drafts: Record<string, string>
}

export function stashForRestart(version: string): void {
  const stash: RestartStash = { version, drafts: useOrbital.getState().composerDrafts }
  try {
    localStorage.setItem(RESTART_STASH, JSON.stringify(stash))
  } catch (err) {
    console.warn('[mobile] update: could not keep the drafts', err)
  }
}

/** The stash a Restart left, read once; null on any other start. */
export function takeRestartStash(): RestartStash | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(RESTART_STASH)
    localStorage.removeItem(RESTART_STASH)
  } catch {
    return null
  }
  return parseRestartStash(raw)
}

export function parseRestartStash(raw: string | null): RestartStash | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<RestartStash> | null
    if (
      typeof value?.version !== 'string' ||
      typeof value.drafts !== 'object' ||
      value.drafts === null
    )
      return null
    const drafts: Record<string, string> = {}
    for (const [id, text] of Object.entries(value.drafts))
      if (typeof text === 'string' && text) drafts[id] = text
    return { version: value.version, drafts }
  } catch {
    return null
  }
}

/** Puts the drafts back into their composers. */
export function restoreDrafts(stash: RestartStash): void {
  const { setComposerDraft } = useOrbital.getState()
  for (const [id, text] of Object.entries(stash.drafts)) setComposerDraft(id, text)
}
