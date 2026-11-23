import type { ViewPayload } from '@orbital/shared/views'
import { api } from '../api'
import { viewSource, type ViewDataSource } from './source'

/**
 * A view's reads and writes (spec 2026-11-18-generated-views-design). Reads
 * go through `ViewDataSource`: the desktop's own routes unless the phone
 * configured its relay (`source.ts`). Writes — allowing domains, answering a
 * waiting view, a message sent from one — go through `api`, which the phone
 * already tunnels over the relay, so they need no seam of their own.
 */

/** The desktop: its own server's routes. */
export const desktopViewSource: ViewDataSource = {
  payload: (sessionId, toolUseId) => api.viewPayload(sessionId, toolUseId),
  data: (sessionId, toolUseId) => api.viewData(sessionId, toolUseId),
}

/** Where this client reads views from now. */
export function currentViewSource(): ViewDataSource {
  return viewSource() ?? desktopViewSource
}

/** How many data copies stay read, newest used last. A copy may be large; a few cover the views on screen. */
const DATA_CACHE_SIZE = 4
const dataCache = new Map<string, Promise<unknown>>()

/**
 * The data as the page reads it (`orbital.data`): JSON parsed, a CSV as its
 * text, null for none. Data the payload does not carry is fetched once and
 * kept (a copy never changes), so a view waking from sleep does not fetch it
 * again.
 */
export async function viewDataOf(
  sessionId: string,
  payload: ViewPayload,
  source: ViewDataSource = currentViewSource(),
): Promise<unknown> {
  const data = payload.data
  if (!data) return null
  if (data.inline) return data.format === 'csv' ? (data.text ?? '') : (data.value ?? null)
  const key = `${sessionId}\n${payload.toolUseId}`
  const cached = dataCache.get(key)
  if (cached) {
    dataCache.delete(key)
    dataCache.set(key, cached)
    return cached
  }
  const read = source.data(sessionId, payload.toolUseId).then((text) => (data.format === 'csv' ? text : (JSON.parse(text) as unknown)))
  dataCache.set(key, read)
  while (dataCache.size > DATA_CACHE_SIZE) dataCache.delete(dataCache.keys().next().value!)
  // A read that failed is asked again next time.
  read.catch(() => {
    if (dataCache.get(key) === read) dataCache.delete(key)
  })
  return read
}
