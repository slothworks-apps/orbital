import type { ViewPayload } from '@orbital/shared/views'
import type { ViewDataSource } from '../../lib/views/source'
import type { TunnelClient } from '../transport/clientRef'
import { readPath, type ResolverDeps } from './fileResolver'

/**
 * Where the phone reads a generated view from (spec
 * 2026-11-18-generated-views-design § Phone): the payload over the Mac's
 * REST route through the relay, and a data copy the payload does not carry
 * (`ViewPayload.data.inline` false) over `file_get` as `view-data`, its
 * path being the call's tool_use id. `file_get` arrives in chunks, so a
 * data copy of any size the Mac keeps gets through; a REST answer must fit
 * one relay frame, which is why the Mac leaves a large copy out of it.
 *
 * `serves`: whether the session's Mac serves views (`MAC_FEATURES.views`).
 * An older Mac has no tool and so no views; a read for one is refused here
 * rather than sent to a Mac that would drop it.
 */
export function makePhoneViewSource(deps: {
  client: Pick<TunnelClient, 'request'>
  files: ResolverDeps
  serves: (sessionId: string) => boolean
}): ViewDataSource {
  return {
    async payload(sessionId, toolUseId) {
      if (!deps.serves(sessionId)) throw new Error('view: this Mac does not serve views')
      const res = await deps.client.request('GET', viewPayloadPath(sessionId, toolUseId))
      if (res.status !== 200 || !res.body || typeof res.body !== 'object') {
        throw new Error(`view: the Mac answered ${res.status}`)
      }
      return res.body as ViewPayload
    },
    async data(sessionId, toolUseId) {
      if (!deps.serves(sessionId)) throw new Error('view: this Mac does not serve views')
      const read = await readPath(deps.files, { sessionId, path: toolUseId, as: 'view-data' })
      // The phone's copy stands in while the Mac is away: a data copy never changes.
      const bytes = read.kind === 'ready' ? read.bytes : read.kind === 'gone' ? read.copy?.bytes : undefined
      if (!bytes) throw new Error(`view: its data could not be read (${read.kind})`)
      return new TextDecoder().decode(bytes)
    },
  }
}

/** The Mac's route for what one call of a view needs to be drawn. */
export function viewPayloadPath(sessionId: string, toolUseId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/views/${encodeURIComponent(toolUseId)}`
}
