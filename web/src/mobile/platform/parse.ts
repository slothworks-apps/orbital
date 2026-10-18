import {
  SECRET_KEY_BYTES, deviceId, fingerprint, fromBase64Url, identityFromSecret, publicKeyOf, toBase64Url, type Identity,
} from '@orbital/shared/remote/keys'
import { MemoryGroupStorage, type StoredGroup } from '@orbital/shared/remote/groupClient'
import { NotificationSettingsSchema, type NotificationSettings } from '@orbital/shared/remote/messages'
import { EMPTY_ROSTER, memberIds, rosterMembers } from '@orbital/shared/remote/roster'
import type { ApiSession, ChatMessage, Tag } from '../../lib/types'

/**
 * What the phone keeps between launches (spec 2026-10-02-mobile-app-design
 * § 4), read back defensively: anything unreadable is treated as absent,
 * never thrown — a bad cache costs a refetch, a bad pairing a new scan.
 * Nothing here touches Capacitor, so all of it is testable in jsdom.
 */

/** The one Mac this phone is paired with. */
export interface Pairing {
  relay: string
  mac: string
  macName: string
  fingerprint: string
  pairedAt: number
  /** The relay's shared secret, from the code; absent for an open relay or a code from an older Mac. */
  relaySecret?: string
}

export interface Cached<T> {
  asOf: number
  value: T
}

export interface SessionsSnapshot {
  sessions: ApiSession[]
  tags: Tag[]
}

export type IdentityBackend = 'secure' | 'local'

/** The Keystore through secure storage on a device; `localStorage` in a desktop browser, dev only (spec § 1). */
export function identityBackend(native: boolean): IdentityBackend {
  return native ? 'secure' : 'local'
}

export function serializeIdentity(identity: Identity): string {
  return toBase64Url(identity.secretKey)
}

export function parseIdentity(raw: string | null): Identity | null {
  if (!raw) return null
  const text = raw.trim()
  const secret = fromBase64Url(text)
  // The one canonical spelling of exactly one secret key, nothing looser.
  if (secret.length !== SECRET_KEY_BYTES || toBase64Url(secret) !== text) return null
  try {
    return identityFromSecret(secret)
  } catch {
    return null
  }
}

export function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function parseJson(raw: string | null): unknown {
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

export function parsePairing(raw: string | null): Pairing | null {
  const data = parseJson(raw)
  if (!data || typeof data !== 'object') return null
  const p = data as Record<string, unknown>
  if (typeof p.relay !== 'string' || !isHttpUrl(p.relay)) return null
  if (typeof p.mac !== 'string' || publicKeyOf(p.mac) === null) return null
  if (typeof p.macName !== 'string' || typeof p.fingerprint !== 'string') return null
  if (typeof p.pairedAt !== 'number' || !Number.isFinite(p.pairedAt)) return null
  const pairing: Pairing = {
    relay: p.relay, mac: p.mac, macName: p.macName, fingerprint: p.fingerprint, pairedAt: p.pairedAt,
  }
  // Anything but a string reads as no secret: the relay then refuses it, and 9h asks for a new code.
  if (typeof p.relaySecret === 'string') pairing.relaySecret = p.relaySecret
  return pairing
}

/**
 * The phone's device group as stored (`orbital.group`): the one relay every
 * member is on, its secret, and what `GroupClient` keeps (spec
 * 2026-10-16-device-group-design § 12).
 */
export interface GroupRecord {
  relay: string
  relaySecret?: string
  group: StoredGroup
  /** The notification rules the user chose on this phone: every member is sent them (`GroupFederation`). */
  notifications?: NotificationSettings
}

/**
 * A stored group, or null when it does not read. The group's own parts are
 * read as `MemoryGroupStorage.fromJSON` reads them: a row that does not read
 * is left out, never the whole group.
 */
export function parseGroupRecord(raw: string | null): GroupRecord | null {
  const data = parseJson(raw)
  if (!data || typeof data !== 'object') return null
  const g = data as Record<string, unknown>
  if (typeof g.relay !== 'string' || !isHttpUrl(g.relay)) return null
  if (!g.group || typeof g.group !== 'object') return null
  const record: GroupRecord = { relay: g.relay, group: MemoryGroupStorage.fromJSON(g.group).toJSON() }
  if (typeof g.relaySecret === 'string') record.relaySecret = g.relaySecret
  const notifications = acceptNotifications(g.notifications)
  if (notifications) record.notifications = notifications
  return record
}

/**
 * A phone paired with one Mac before groups: a group whose one paired
 * device is that Mac, on the same relay with the same secret. The roster
 * starts empty; the phone adds itself, and a Mac that keeps one sends its own.
 */
export function migratePairing(pairing: Pairing): GroupRecord {
  const record: GroupRecord = {
    relay: pairing.relay,
    group: {
      roster: EMPTY_ROSTER,
      paired: [{ id: pairing.mac, name: pairing.macName, kind: null, platform: '', pairedAt: pairing.pairedAt, lastSeenAt: null }],
      pendingRevokes: [],
    },
  }
  if (pairing.relaySecret !== undefined) record.relaySecret = pairing.relaySecret
  return record
}

/**
 * Which stored group to boot into. Every bundle since groups writes
 * `orbital.pairing` beside `orbital.group`, and a bundle from before them
 * knows only the pairing: after an over-the-air rollback that forgot its
 * Mac or paired another, the group left behind is stale. So the pairing is
 * the truth where the two disagree: no pairing, no group (`stale`: drop
 * it); a pairing for a device the group does not hold, a group migrated
 * afresh from it.
 */
export function reconcileGroup(record: GroupRecord | null, pairing: Pairing | null): { record: GroupRecord | null; stale: boolean } {
  if (!pairing) return { record: null, stale: record !== null }
  if (!record) return { record: migratePairing(pairing), stale: false }
  const holds = record.relay === pairing.relay && (
    record.group.paired.some((d) => d.id === pairing.mac) ||
    memberIds(record.group.roster).includes(pairing.mac)
  )
  return holds ? { record, stale: false } : { record: migratePairing(pairing), stale: true }
}

/**
 * What the rest of the app reads as "this phone is in a group" (`Pairing`):
 * the relay and the first paired device. With no pair left (the relay lost
 * them and the members pair again) the first other live member stands in,
 * so the phone stays in its group. Null when there is neither.
 */
export function pairingFromGroup(record: GroupRecord, phoneKey: Uint8Array): Pairing | null {
  const self = deviceId(phoneKey)
  const first = record.group.paired.at(0)
  const entry = rosterMembers(record.group.roster).find((m) => m.id !== self)
  const member = first
    ? { id: first.id, name: first.name, at: first.pairedAt }
    : entry ? { id: entry.id, name: entry.name, at: entry.addedAt } : null
  const key = member ? publicKeyOf(member.id) : null
  if (!member || !key) return null
  const pairing: Pairing = {
    relay: record.relay, mac: member.id, macName: member.name, fingerprint: fingerprint(key, phoneKey), pairedAt: member.at,
  }
  if (record.relaySecret !== undefined) pairing.relaySecret = record.relaySecret
  return pairing
}

export function parseCached<T>(raw: string | null, accept: (value: unknown) => T | null): Cached<T> | null {
  const data = parseJson(raw)
  if (!data || typeof data !== 'object') return null
  const { asOf, value } = data as { asOf?: unknown; value?: unknown }
  if (typeof asOf !== 'number' || !Number.isFinite(asOf)) return null
  const accepted = accept(value)
  return accepted === null ? null : { asOf, value: accepted }
}

export function acceptSessions(value: unknown): SessionsSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const { sessions, tags } = value as { sessions?: unknown; tags?: unknown }
  return Array.isArray(sessions) && Array.isArray(tags)
    ? { sessions: sessions as ApiSession[], tags: tags as Tag[] }
    : null
}

export function acceptMessages(value: unknown): ChatMessage[] | null {
  return Array.isArray(value) ? (value as ChatMessage[]) : null
}

export function acceptNotifications(value: unknown): NotificationSettings | null {
  const parsed = NotificationSettingsSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

// Twin of `ImageRef` in shared/src/remote/messages.ts: a content hash plus
// its extension, nothing else — in particular no `/` or `..`, so a ref used
// as a filesystem path segment can never escape the image cache directory.
const IMAGE_REF_RE = /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/

export function isImageRef(ref: string): boolean {
  return IMAGE_REF_RE.test(ref)
}

/** What the Mac's confirm and its device list call a phone whose model is unknown (spec § 5, 9e). */
export const FALLBACK_DEVICE_NAME = 'Android phone'

export function deviceName(info: { model?: string | null } | null): string {
  const model = info?.model?.trim()
  return model ? model : FALLBACK_DEVICE_NAME
}
