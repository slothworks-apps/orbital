import { api } from '../lib/api'
import { coalesced } from '../lib/coalesce'
import { recordError } from '../lib/errors'
import { applySessionsSnapshot, useOrbital } from './store'

// Each read below is `coalesced`: a burst of changes (a tags event while a
// delete's resync is still out, say) reads once more after the read in
// flight, not once per change. A read that fails is recorded, not announced
// (adr errors-are-recorded-not-announced), and leaves what the window holds
// until the next change or reload.

/** Reads the tag list again and replaces the store's copy. */
const resyncTags = coalesced(async () => {
  try {
    useOrbital.setState({ tags: await api.listTags() })
  } catch (err) {
    recordError(err, 'Could not read the tags again')
  }
})

/**
 * Reads the rules again and replaces the store's copy wholesale. Called after
 * a rule mutation fails (beside `reportError`'s toast), so a failed PATCH —
 * or, for the reorder swap, a *partial* failure where one of its two PATCHes
 * succeeded and the other didn't — can never leave the client silently
 * diverged from the server. There's no DB uniqueness constraint on
 * `position`, so a half-applied swap is a real possibility. Also after a
 * tag delete or a merge, which move rules on the server.
 */
export const resyncRules = coalesced(async () => {
  try {
    useOrbital.setState({ rules: await api.listTagRules() })
  } catch (err) {
    recordError(err, 'Could not read the tag rules again')
  }
})

/**
 * Reads the newest sessions again and seats them in one store write
 * (`applySessionsSnapshot`, which skips a session the socket has since
 * brought newer).
 *
 * Rule and tag mutations that trigger server-side `regenerateRuleTags`
 * (create, patch, delete of a rule; the reorder swap; tag delete; a merge
 * from another member) change which tags apply to which sessions, but the
 * server has no push channel for that — only the sessions the runner or
 * registry itself upserts get a WS event. Left alone, a session's `tagIds`
 * would drift from what the server computes until something else refreshed
 * it.
 */
export const resyncSessions = coalesced(async () => {
  try {
    applySessionsSnapshot(await api.listSessions({ limit: 200 }))
  } catch (err) {
    recordError(err, 'Could not read the sessions again')
  }
})

/**
 * The tag list changed under this window, taken from another member of the
 * group (spec 2026-10-24-group-shared-settings-design § Tags; the `tags`
 * event of the `settings` topic): the tags are read again, the rules (a
 * merge moves them to the tag that won) and the newest sessions (a merge or
 * a delete moves their tags), as a delete in Tags & rules does.
 */
export async function reloadSharedTags(): Promise<void> {
  await Promise.all([resyncTags(), resyncRules(), resyncSessions()])
}
