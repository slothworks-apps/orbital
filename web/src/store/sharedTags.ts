import { api } from '../lib/api'
import { useOrbital } from './store'

/**
 * The tag list changed under this window, taken from another member of the
 * group (spec 2026-10-24-group-shared-settings-design § Tags; the `tags`
 * event of the `settings` topic): the tags are read again, the rules (a
 * merge moves them to the tag that won) and the newest sessions (a merge or
 * a delete moves their tags), as a delete in Tags & rules does. A read that
 * fails leaves what the window holds until the next change or reload.
 */
export async function reloadSharedTags(): Promise<void> {
  try {
    const [tags, rules, sessions] = await Promise.all([
      api.listTags(),
      api.listTagRules(),
      api.listSessions({ limit: 200 }),
    ])
    useOrbital.setState({ tags, rules })
    const { applySessionsEvent } = useOrbital.getState()
    for (const session of sessions) applySessionsEvent({ event: 'upsert', session })
  } catch {
    // Best-effort, as the resync after a local delete is.
  }
}
