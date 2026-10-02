import {
  SECRET_KEY_BYTES, fromBase64Url, identityFromSecret, publicKeyOf, toBase64Url, type Identity,
} from '@orbital/shared/remote/keys'
import { NotificationSettingsSchema, type NotificationSettings } from '@orbital/shared/remote/messages'
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
  return { relay: p.relay, mac: p.mac, macName: p.macName, fingerprint: p.fingerprint, pairedAt: p.pairedAt }
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

/** What the Mac's confirm and its device list call a phone whose model is unknown (spec § 5, 9e). */
export const FALLBACK_DEVICE_NAME = 'Android phone'

export function deviceName(info: { model?: string | null } | null): string {
  const model = info?.model?.trim()
  return model ? model : FALLBACK_DEVICE_NAME
}
