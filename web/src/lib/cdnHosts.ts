import { VIEW_BUILTIN_CDN_HOSTS, checkCdnHost, readCdnHosts, type CdnHost } from '@orbital/shared/views'

/**
 * Settings → Labs → Views' CDN HOSTS list (canvas `Feature - Views` 69f;
 * spec 2026-11-18-generated-views-design § CDN hosts), on the desktop and
 * the phone alike: the rows, what the field under them says, and the stored
 * value an Add or a Remove writes. The Mac validates the stored value again
 * on PATCH (`readCdnHosts`); this only decides what the screen offers.
 */

/** One row of the list: a built-in host is locked and has no Remove. */
export interface CdnHostRow {
  host: string
  builtIn: boolean
  /** The user's host: when it was added (ms); null for a built-in one. */
  addedAt: number | null
}

/** The built-in hosts first, in their order, then the user's, in the order they were added. */
export function cdnHostRows(stored: string | null | undefined): CdnHostRow[] {
  return [
    ...VIEW_BUILTIN_CDN_HOSTS.map((host) => ({ host, builtIn: true, addedAt: null })),
    ...readCdnHosts(stored).map((h) => ({ host: h.host, builtIn: false, addedAt: h.addedAt })),
  ]
}

/**
 * What the field under the list says for what is typed in it (69f `help`),
 * and whether Add takes it. Empty: the standing line, and Add dim. A host
 * that is no host says what to type instead, with the host read out of it
 * when there is one (a URL with a scheme or a path, say).
 */
export type CdnHostField =
  | { state: 'empty' | 'ok'; help: string; host: string | null }
  | { state: 'bad' | 'dup'; help: string; host: null }

/**
 * The standing line. 69f gives esm.sh as its example; esm.sh has since
 * become a built-in host, so the example is the host 69f's phone types
 * (`cdn.skypack.dev`).
 */
export const CDN_HOST_EXAMPLE = 'cdn.skypack.dev'
export const CDN_HOST_HELP = `A host only, e.g. ${CDN_HOST_EXAMPLE}. Scripts and stylesheets from it load in every view without asking; data still asks per session.`

export function cdnHostField(typed: string, stored: string | null | undefined): CdnHostField {
  const raw = typed.trim()
  if (raw === '') return { state: 'empty', help: CDN_HOST_HELP, host: null }
  const checked = checkCdnHost(raw, readCdnHosts(stored))
  if ('host' in checked) return { state: 'ok', help: CDN_HOST_HELP, host: checked.host }
  if (checked.error === 'dup') return { state: 'dup', help: `${raw.toLowerCase()} is already in the list.`, host: null }
  const tryInstead = checked.suggestion ? ` Try ${checked.suggestion}.` : ''
  return { state: 'bad', help: `A host only, without https:// or a path.${tryInstead}`, host: null }
}

/** The stored value with `host` added at `now`; unchanged when it is no host or already listed. */
export function withCdnHost(stored: string | null | undefined, host: string, now: number): string {
  const hosts = readCdnHosts(stored)
  const checked = checkCdnHost(host, hosts)
  const next: CdnHost[] = 'host' in checked ? [...hosts, { host: checked.host, addedAt: now }] : hosts
  return JSON.stringify(next)
}

/** The stored value without `host`. */
export function withoutCdnHost(stored: string | null | undefined, host: string): string {
  return JSON.stringify(readCdnHosts(stored).filter((h) => h.host !== host))
}

/** The state line under the Views switch (69f `state`): how many hosts load without asking, or that the user's are kept. */
export function viewsStateLine(on: boolean, stored: string | null | undefined): string | null {
  const own = readCdnHosts(stored).length
  if (on) return `on · ${VIEW_BUILTIN_CDN_HOSTS.length + own} CDN hosts`
  // Not in 69f: with none of the user's own there is nothing being kept to say so of.
  return own > 0 ? 'off · your hosts are kept' : null
}

/** 69f's meta on the desktop: `added by you · 18 Nov`, the year only when it is not this one. */
export function addedLabel(addedAt: number, now: number): string {
  const at = new Date(addedAt)
  const sameYear = at.getFullYear() === new Date(now).getFullYear()
  const day = at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
  return `added by you · ${day}`
}
