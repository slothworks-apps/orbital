import { WHATS_NEW_BEFORE } from '@orbital/shared/changelog'
import { compareVersions } from '@orbital/shared/remote/version'

/**
 * WHAT'S NEW, as decisions (spec 2026-10-19-whats-new-design; canvas
 * `Feature - Notice toast` 1a, 1b, 2a, 2b): the notice-toast message of kind
 * `changelog` that tells, once, what changed in the version this device now
 * runs. The Mac and the phone each remember their own (`panels/WhatsNew`,
 * `mobile/WhatsNew`).
 */

/**
 * What a device remembers: the last version it ran, when it first ran it,
 * and whether that version's message has ended. A message that has not ended
 * shows again at the next launch — nothing makes a notice go by itself.
 */
export interface SeenVersion {
  version: string
  at: number
  ended: boolean
  /**
   * While the message has not ended: the version whose message the person
   * last saw end, so the notes since it still show at the next launch,
   * after `version` already names the running one. Absent when not known
   * (an install from before WHAT'S NEW): then only `version`'s show.
   */
  from?: string
}

/**
 * What a device remembers, as read: its `SeenVersion`; `before`, an install
 * that was in use before WHAT'S NEW existed (the Mac's migration wrote
 * `WHATS_NEW_BEFORE`, or the phone found its own state with nothing
 * remembered); or null, a first install. A value that does not read counts as
 * nothing remembered.
 */
export type StoredSeen = SeenVersion | 'before' | null

export function parseSeenVersion(raw: string | null | undefined, usedBefore = false): StoredSeen {
  if (raw === WHATS_NEW_BEFORE) return 'before'
  if (raw) {
    try {
      const value = JSON.parse(raw) as Partial<SeenVersion> | null
      if (
        value &&
        typeof value.version === 'string' &&
        value.version !== '' &&
        typeof value.at === 'number' &&
        Number.isFinite(value.at) &&
        typeof value.ended === 'boolean'
      ) {
        const seen: SeenVersion = { version: value.version, at: value.at, ended: value.ended }
        if (typeof value.from === 'string' && value.from !== '') seen.from = value.from
        return seen
      }
    } catch {
      // Not ours: as if nothing were remembered.
    }
  }
  return usedBefore ? 'before' : null
}

export function serializeSeenVersion(seen: SeenVersion): string {
  return JSON.stringify(seen)
}

export interface WhatsNewLaunch {
  /** Whether the message is due now. */
  show: boolean
  /** When this device first ran the version: the dialog's "installed today". */
  installedAt: number
  /** What to remember, or null when nothing changes. */
  write: SeenVersion | null
  /**
   * The version the person ran before and saw the message of: the notes
   * after it are due (shared `releaseNotesSince`). Absent when not known —
   * only the running version's are.
   */
  since?: string
}

/**
 * At launch, from what the device remembers and the version it runs:
 * - nothing remembered (a first install) — remember it silently;
 * - an older version than remembered (a bundle rolled back, a Mac
 *   downgraded) — nothing: its notes are not news, and the newer version
 *   stays remembered, so going forward again does not tell it twice;
 * - a newer version, or an install from before WHAT'S NEW — the message is
 *   due, unless the changelog has nothing for this one, which is remembered
 *   as ended. It tells what changed since the version remembered; when that
 *   one's message never ended, since the one before it (`from`, or that
 *   version itself when not known), so a version left untold is told with
 *   the next;
 * - the same version — due again only while its message has not ended.
 */
export function whatsNewOnLaunch({
  stored,
  version,
  hasNotes,
  now,
}: {
  stored: StoredSeen
  version: string
  hasNotes: boolean
  now: number
}): WhatsNewLaunch {
  if (stored === null) return { show: false, installedAt: now, write: { version, at: now, ended: true } }
  if (stored !== 'before' && compareVersions(version, stored.version) < 0) {
    return { show: false, installedAt: now, write: null }
  }
  if (stored === 'before') {
    return { show: hasNotes, installedAt: now, write: { version, at: now, ended: !hasNotes } }
  }
  if (stored.version !== version) {
    if (!hasNotes) return { show: false, installedAt: now, write: { version, at: now, ended: true } }
    const since = stored.ended ? stored.version : (stored.from ?? stored.version)
    return { show: true, installedAt: now, write: { version, at: now, ended: false, from: since }, since }
  }
  const shown = hasNotes && !stored.ended
  return { show: shown, installedAt: stored.at, write: null, ...(shown && stored.from ? { since: stored.from } : {}) }
}

/** What the device remembers once the message ends: × on it, or the dialog or sheet closed. */
export function endedSeenVersion(version: string, installedAt: number): SeenVersion {
  return { version, at: installedAt, ended: true }
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/**
 * The dialog's line under the version (1b): `installed today`, or the day
 * this device first ran it when that was before today.
 */
export function installedLine(
  installedAt: number,
  now: number,
  day: (at: number) => string = (at) => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
): string {
  return sameDay(new Date(installedAt), new Date(now)) ? 'installed today' : `installed ${day(installedAt)}`
}

/** The toast's head (1a): `WHAT’S NEW · ORBITAL 0.36.0`. */
export function whatsNewHead(version: string): string {
  return `WHAT’S NEW · ORBITAL ${version}`
}
