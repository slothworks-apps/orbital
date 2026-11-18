import { viewErrorText, viewMessageText, type ViewPayload } from '@orbital/shared/views'
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

/**
 * The data as the page reads it (`orbital.data`): JSON parsed, a CSV as its
 * text, null for none. Data the payload does not carry is fetched.
 */
export async function viewDataOf(
  sessionId: string,
  payload: ViewPayload,
  source: ViewDataSource = currentViewSource(),
): Promise<unknown> {
  const data = payload.data
  if (!data) return null
  if (data.inline) return data.format === 'csv' ? (data.text ?? '') : (data.value ?? null)
  const text = await source.data(sessionId, payload.toolUseId)
  return data.format === 'csv' ? text : (JSON.parse(text) as unknown)
}

/** Allows the session's views to fetch from `domains`; every domain it allows now. */
export async function approveViewDomains(sessionId: string, domains: readonly string[]): Promise<string[]> {
  const answer = await api.approveViewDomains(sessionId, domains)
  return answer.domains
}

/** The text a non-waiting view's `send` puts in the session, as the user's message. */
export function viewMessage(payload: Pick<ViewPayload, 'viewId' | 'title'>, value: unknown): string {
  return viewMessageText({ viewId: payload.viewId, title: payload.title, value })
}

/** The text Send the error to the session sends. */
export function viewErrorMessage(payload: Pick<ViewPayload, 'viewId' | 'title'>, error: string): string {
  return viewErrorText({ viewId: payload.viewId, title: payload.title, error })
}
