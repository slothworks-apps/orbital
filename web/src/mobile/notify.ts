import { create } from 'zustand'
import {
  DEFAULT_NOTIFICATION_SETTINGS, NEEDS_INPUT_BODY, SessionNotifier, type NotificationSettings, type SessionNotification,
} from '@orbital/shared/notifications'
import { decisionChipLabel, decisionHeadline, inputSummary } from '../lib/decisionCard'
import type { ApiSession, PendingDecision } from '../lib/types'
import { useOrbital } from '../store/store'
import { BANNER_MS } from './constants'
import { writeNotificationsCache } from './platform/cache'
import { postLocalNotification } from './platform/localNotify'
import { useMobile, type Screen } from './state'
import { clientRef } from './transport/clientRef'

/**
 * What the connected phone says about its sessions (spec 2026-10-02-mobile-app-design
 * § 6.5, ADR the-connected-phone-notifies-itself): the shared `SessionNotifier`
 * over the hub frames, a pure decision between 9g's banner and a system
 * notification, and the banner's store.
 */

/** Which of the two a notification gets. */
export type Audience = { banner: boolean; system: boolean }

/**
 * The banner is UI, not a notification (spec § 6): in the foreground it shows
 * for every session but the one on screen, and the background rule governs
 * the system notification alone. A failure that names no session is never
 * the one on screen.
 */
export function decideNotification(
  n: SessionNotification,
  ctx: { active: boolean; viewing: string | null; rules: NotificationSettings },
): Audience {
  if (!ctx.active) return { banner: false, system: true }
  return { banner: n.sessionId === null || n.sessionId !== ctx.viewing, system: !ctx.rules.onlyWhenBackground }
}

/** A channel's sound is fixed once created, so the `sound` rule picks between two (spec § 6.5). */
export function channelFor(rules: NotificationSettings): 'needs_input' | 'needs_input_sound' {
  return rules.sound ? 'needs_input_sound' : 'needs_input'
}

/** The one id every failure without a session shares. */
const SESSIONLESS_NOTIFICATION_ID = 1

/**
 * One notification id per session, so a later transition replaces the
 * earlier one: 32-bit FNV-1a over the id, cut to 31 bits — Android's ids are
 * a Java `int` — and never zero.
 */
export function notificationId(sessionId: string | null): number {
  if (sessionId === null) return SESSIONLESS_NOTIFICATION_ID
  let hash = 0x811c9dc5
  for (let i = 0; i < sessionId.length; i++) {
    hash ^= sessionId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash & 0x7fffffff) || SESSIONLESS_NOTIFICATION_ID + 1
}

/** The banner's second line, in characters: about one row of a phone's width. */
export const BANNER_LINE_MAX = 80

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > BANNER_LINE_MAX ? `${flat.slice(0, BANNER_LINE_MAX - 1)}…` : flat
}

/** The ask under the banner's title: the pending decision when the store has it, else the notifier's body. */
export function bannerLine(n: SessionNotification, pending: PendingDecision | undefined): string {
  if (!pending) return n.body
  if (pending.kind === 'question') {
    const header = pending.input.questions[0]?.header?.trim()
    return header ? oneLine(`Question · ${header}`) : n.body
  }
  return oneLine(`${decisionChipLabel(pending.kind)} · ${inputSummary(pending.input) ?? decisionHeadline(pending)}`)
}

/**
 * `needsInput` draws 9g's needs-input form: the state glyph, the amber edge,
 * and " needs input" after a title that truncates before it.
 */
export type BannerContent = { sessionId: string | null; title: string; needsInput: boolean; line: string }

interface BannerState {
  current: (BannerContent & { at: number }) | null
  /** Replaces whatever shows and restarts the `BANNER_MS` countdown. */
  show(banner: BannerContent): void
  dismiss(): void
}

let hideTimer: ReturnType<typeof setTimeout> | null = null

function clearHideTimer(): void {
  if (hideTimer !== null) clearTimeout(hideTimer)
  hideTimer = null
}

/** 9g's banner: one at a time, a newer one replaces it. */
export const useBanner = create<BannerState>()((set) => ({
  current: null,
  show: (banner) => {
    clearHideTimer()
    hideTimer = setTimeout(() => {
      hideTimer = null
      set({ current: null })
    }, BANNER_MS)
    set({ current: { ...banner, at: Date.now() } })
  },
  dismiss: () => {
    clearHideTimer()
    set({ current: null })
  },
}))

let rules: NotificationSettings = DEFAULT_NOTIFICATION_SETTINGS
let notifier = new SessionNotifier()
let active = true
let wired = false

/** The phone's rules, from the cache at boot and from 9f after each save. */
export function setRules(next: NotificationSettings): void {
  rules = next
  notifier.setSettings(next)
}

/** Whether the app is in the foreground; boot reports every `appStateChange`. */
export function setActive(isActive: boolean): void {
  active = isActive
}

/**
 * The sessions this notifier has heard about on the hub since its tunnel
 * opened. A seed never overwrites them: what the hub said is newer than any
 * list read alongside it.
 */
const heard = new Set<string>()

/**
 * The decision each session's latest upsert carried. The Mac publishes the
 * upsert that parks a decision just before the `status` frame that moves the
 * session to `needs_input`, and the store applies sessions frames on the next
 * animation frame — so when the transition is reported, the store often has
 * neither yet.
 */
const asks = new Map<string, PendingDecision>()

/** Listens to the client once; safe to call again. */
export function wireNotifications(): void {
  if (wired) return
  wired = true
  clientRef.on((event) => {
    if (event.type === 'ready' && event.ready) renew()
    else if (event.type === 'hub') {
      remember(event.frame)
      const n = notifier.onEvent(event.frame)
      // After the listeners still to hear this frame (the tunnel socket hands it to the store).
      if (n) queueMicrotask(() => report(n))
    }
  })
}

type SessionsFrame = {
  topic?: unknown
  event?: unknown
  sessionId?: unknown
  session?: { id?: unknown; pendingDecision?: unknown }
}

/** Which session a `sessions` frame is about, and the decision an upsert carries. */
function remember(frame: unknown): void {
  const f = frame as SessionsFrame | null
  if (f?.topic !== 'sessions') return
  if (f.event === 'upsert' && typeof f.session?.id === 'string') {
    const id = f.session.id
    heard.add(id)
    const pending = f.session.pendingDecision
    if (pending && typeof pending === 'object') asks.set(id, pending as PendingDecision)
    else asks.delete(id)
  } else if (f.event === 'status' && typeof f.sessionId === 'string') {
    heard.add(f.sessionId)
  } else if (f.event === 'remove' && typeof f.sessionId === 'string') {
    heard.delete(f.sessionId)
    asks.delete(f.sessionId)
  }
}

/**
 * Seeds the notifier with sessions read some other way than the hub — the
 * cached list when a tunnel opens, the Mac's list once `resync` has read it.
 * The Mac's `PhoneSession` replays nothing on subscribe, so without this a
 * fresh notifier would spend each session's first transition learning that
 * the session exists. What the notifier makes of a seed is discarded:
 * anything that changed while the tunnel was down was the push's to report.
 */
export function seedNotifications(sessions: readonly ApiSession[]): void {
  for (const session of sessions) {
    if (heard.has(session.id)) continue
    notifier.onEvent({ topic: 'sessions', event: 'upsert', session })
  }
}

/**
 * Every new tunnel gets a fresh notifier, seeded from the list the store
 * holds; `resync` seeds it again from the Mac's list. The rules are read
 * again with it.
 */
function renew(): void {
  notifier = new SessionNotifier()
  notifier.setSettings(rules)
  heard.clear()
  asks.clear()
  seedNotifications(Object.values(useOrbital.getState().sessions))
  void refreshRules()
}

async function refreshRules(): Promise<void> {
  try {
    const fresh = await clientRef.getNotifications()
    setRules(fresh)
    await writeNotificationsCache(fresh, Date.now())
  } catch {
    // The rules held so far stand until the next tunnel.
  }
}

/** Screens with no pair to act on: no banner covers them (a tap could only lead somewhere else). */
const BANNERLESS: ReadonlySet<Screen> = new Set(['pairing', 'unpaired', 'mismatch'])

/** The ask a transition is about: what the hub carried, else what the store holds. */
function pendingFor(sessionId: string): PendingDecision | undefined {
  const store = useOrbital.getState()
  return asks.get(sessionId) ?? store.sessions[sessionId]?.pendingDecision ?? store.pendingDecisions[sessionId]
}

function report(n: SessionNotification): void {
  const { screen, sessionId } = useMobile.getState()
  const audience = decideNotification(n, { active, viewing: screen === 'session' ? sessionId : null, rules })
  if (audience.banner && !BANNERLESS.has(screen)) {
    const pending = n.sessionId ? pendingFor(n.sessionId) : undefined
    useBanner.getState().show({
      sessionId: n.sessionId,
      title: n.title,
      needsInput: n.body === NEEDS_INPUT_BODY,
      line: bannerLine(n, pending),
    })
  }
  if (audience.system) {
    void postLocalNotification({
      id: notificationId(n.sessionId), title: n.title, body: n.body, channelId: channelFor(rules), sound: rules.sound, sessionId: n.sessionId,
    })
  }
}
