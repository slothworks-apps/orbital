import { create } from 'zustand'
import { NOTIFICATIONS_TURN_ON, notificationsAllOff, type NotificationSettings } from '@orbital/shared/notifications'
import { readPhoneTip, writePhoneTip } from './platform/notificationsTip'

/**
 * The phone's notifications tip (spec 2026-10-08-notifications-off-by-default-design
 * § 5, canvas `Feature - Notifications off` 2a–2d): the desktop's tip, once,
 * as the first item of the session list after pairing. Its own: ending one
 * does not end the other.
 */

/**
 * Offered while pending, and only if the rules the Mac copied at pairing are
 * all still off — a Mac whose user had turned notifications on hands the
 * phone rules that already notify. Unknown rules offer nothing.
 */
export function shouldOfferPhoneTip(stored: string | null, rules: NotificationSettings | null): boolean {
  return stored === 'pending' && rules !== null && notificationsAllOff(rules)
}

/** Turn on (2c): Needs input and Errors — the desktop's Session failed — and nothing else. */
export function phoneTurnOn(rules: NotificationSettings): NotificationSettings {
  return { ...rules, ...NOTIFICATIONS_TURN_ON }
}

interface PhoneTipState {
  /** What `orbital.notificationsTip` holds; `undefined` until read. */
  stored: string | null | undefined
  /** This phone's rules as last read, while the tip may be due; Turn on starts from them. */
  rules: NotificationSettings | null
  /** 9f opens scrolled to its NOTIFICATIONS group once, after the tip's Settings. */
  settingsTarget: 'notifications' | null
  load(): Promise<void>
  /** A new pairing makes the tip due, unless this phone already had it. */
  markPending(): Promise<void>
  /** Gone for good. */
  end(): void
}

export const usePhoneTip = create<PhoneTipState>()((set, get) => ({
  stored: undefined,
  rules: null,
  settingsTarget: null,
  load: async () => {
    try {
      set({ stored: await readPhoneTip() })
    } catch {
      set({ stored: null })
    }
  },
  markPending: async () => {
    try {
      if ((await readPhoneTip()) !== null) return
      await writePhoneTip('pending')
      set({ stored: 'pending' })
    } catch (err) {
      console.warn('[mobile] could not store the notifications tip', err)
    }
  },
  end: () => {
    if (get().stored === 'ended') return
    set({ stored: 'ended' })
    writePhoneTip('ended').catch((err: unknown) => console.warn('[mobile] could not store the notifications tip', err))
  },
}))
