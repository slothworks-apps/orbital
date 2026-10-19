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
}

export function parseSeenVersion(raw: string | null | undefined): SeenVersion | null {
  if (!raw) return null
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
      return { version: value.version, at: value.at, ended: value.ended }
    }
  } catch {
    // Not ours: as if nothing were remembered.
  }
  return null
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
}

/**
 * At launch, from what the device remembers and the version it runs:
 * - nothing remembered (a first install) — remember it silently;
 * - another version — the message is due, unless the changelog has nothing
 *   for this one, which is remembered as ended;
 * - the same version — due again only while its message has not ended.
 */
export function whatsNewOnLaunch({
  stored,
  version,
  hasNotes,
  now,
}: {
  stored: SeenVersion | null
  version: string
  hasNotes: boolean
  now: number
}): WhatsNewLaunch {
  if (stored === null) return { show: false, installedAt: now, write: { version, at: now, ended: true } }
  if (stored.version !== version) {
    return { show: hasNotes, installedAt: now, write: { version, at: now, ended: !hasNotes } }
  }
  return { show: hasNotes && !stored.ended, installedAt: stored.at, write: null }
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
