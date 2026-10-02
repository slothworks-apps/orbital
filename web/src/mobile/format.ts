import { timeAgo } from '../lib/format'

const MINUTE_MS = 60_000
const TIME: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }

/** "as of 14:32" today, "as of 1 Oct 14:32" before that (9a offline, 9b). */
export function asOfLabel(asOf: number, now: number): string {
  const at = new Date(asOf)
  const time = at.toLocaleTimeString([], TIME)
  if (at.toDateString() === new Date(now).toDateString()) return `as of ${time}`
  return `as of ${at.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`
}

/** After a Retry (9a) or a Try again (9i). */
export function checkedLabel(checkedAt: number, now: number): string {
  return now - checkedAt < MINUTE_MS ? 'checked just now' : `checked ${timeAgo(checkedAt, now)} ago`
}

/** "just now", "3h ago": `timeAgo` with the words around it. */
export function agoLabel(ts: number, now: number): string {
  const age = timeAgo(ts, now)
  return age === 'now' ? 'just now' : `${age} ago`
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || path
}

/** The relay as 9e and 9f name it: its host, or the URL as written when it does not parse. */
export function relayHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
