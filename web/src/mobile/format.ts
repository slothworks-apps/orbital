import { timeAgo } from '../lib/format'

const MINUTE_MS = 60_000
const TIME: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }

/** A moment as the phone's lines date it: "13:22". */
export function clockLabel(at: number): string {
  return new Date(at).toLocaleTimeString([], TIME)
}

/** "as of 14:32" today, "as of 1 Oct 14:32" before that (9a offline, 9b). */
export function asOfLabel(asOf: number, now: number): string {
  const at = new Date(asOf)
  const time = clockLabel(asOf)
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

/**
 * A directory as 9d prints it: the home folder as `~`. The phone never
 * learns the Mac's home, so it is read off the path's shape — macOS's
 * `/Users/<name>` or Linux's `/home/<name>`. Display only; the full path is
 * what gets sent.
 */
export function homePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
}

/** The relay as 9e and 9f name it: its host, or the URL as written when it does not parse. */
export function relayHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
