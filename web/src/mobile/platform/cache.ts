import { Preferences } from '@capacitor/preferences'
import type { NotificationSettings } from '@orbital/shared/remote/messages'
import type { ChatMessage } from '../../lib/types'
import {
  acceptMessages, acceptNotifications, acceptSessions, parseCached, type Cached, type SessionsSnapshot,
} from './parse'

/**
 * What the phone shows while its Mac is away, each with when it was fresh
 * (spec § 4): the last session list, the last page of each opened
 * transcript, the notification rules as last read. Cleared with the pairing.
 */
export const CACHE_PREFIX = 'orbital.cache.'
const SESSIONS_KEY = `${CACHE_PREFIX}sessions`
const NOTIFICATIONS_KEY = `${CACHE_PREFIX}notifications`
const transcriptKey = (id: string): string => `${CACHE_PREFIX}transcript:${id}`

async function read<T>(key: string, accept: (value: unknown) => T | null): Promise<Cached<T> | null> {
  const { value } = await Preferences.get({ key })
  return parseCached(value, accept)
}

function write(key: string, value: unknown, asOf: number): Promise<void> {
  return Preferences.set({ key, value: JSON.stringify({ asOf, value }) })
}

export function readSessionsCache(): Promise<Cached<SessionsSnapshot> | null> {
  return read(SESSIONS_KEY, acceptSessions)
}

export function writeSessionsCache(value: SessionsSnapshot, asOf: number): Promise<void> {
  return write(SESSIONS_KEY, value, asOf)
}

export function readTranscriptCache(id: string): Promise<Cached<ChatMessage[]> | null> {
  return read(transcriptKey(id), acceptMessages)
}

export function writeTranscriptCache(id: string, messages: ChatMessage[], asOf: number): Promise<void> {
  return write(transcriptKey(id), messages, asOf)
}

export function readNotificationsCache(): Promise<Cached<NotificationSettings> | null> {
  return read(NOTIFICATIONS_KEY, acceptNotifications)
}

export function writeNotificationsCache(settings: NotificationSettings, asOf: number): Promise<void> {
  return write(NOTIFICATIONS_KEY, settings, asOf)
}

export async function clearCaches(): Promise<void> {
  const { keys } = await Preferences.keys()
  await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX)).map((key) => Preferences.remove({ key })))
}
