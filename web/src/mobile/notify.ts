import { create } from 'zustand'
import {
  DEFAULT_NOTIFICATION_SETTINGS, SessionNotifier, type NotificationSettings, type SessionNotification,
} from '@orbital/shared/notifications'
import { PRESENCE_TOPIC, presenceFromFrame } from '@orbital/shared/presence'
import { fnv1a } from '../lib/hash'
import { decisionChipLabel, decisionHeadline, inputSummary } from '../lib/decisionCard'
import type { ApiSession, PendingDecision } from '../lib/types'
import { useOrbital } from '../store/store'
import { BANNER_MS } from './constants'
import { writeNotificationsCache } from './platform/cache'
import { postLocalNotification, removeDeliveredNotification } from './platform/localNotify'
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
 * the one on screen. While the user is at the Mac, nothing reaches the
 * system (spec 2026-10-15-the-phone-is-quiet-while-you-are-at-the-mac-design § 2).
 */
export function decideNotification(
  n: SessionNotification,
  ctx: { active: boolean; viewing: string | null; rules: NotificationSettings; atMac: boolean },
): Audience {
  if (!ctx.active) return { banner: false, system: !ctx.atMac }
  return {
    banner: n.sessionId === null || n.sessionId !== ctx.viewing,
    system: !ctx.rules.onlyWhenBackground && !ctx.atMac,
  }
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
  return (fnv1a(sessionId) & 0x7fffffff) || SESSIONLESS_NOTIFICATION_ID + 1
}

/** The banner's second line, in characters: about one row of a phone's width. */
export const BANNER_LINE_MAX = 80

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > BANNER_LINE_MAX ? `${flat.slice(0, BANNER_LINE_MAX - 1)}…` : flat
}

/**
 * The line under the banner's title: for a session that needs input, the
 * pending decision when the store has it; else the notifier's body — a Done
 * has no ask to name, whatever the store still holds.
 */
export function bannerLine(n: SessionNotification, pending: PendingDecision | undefined): string {
  if (n.kind !== 'needs_input' || !pending) return n.body
  if (pending.kind === 'question') {
    const header = pending.input.questions[0]?.header?.trim()
    return header ? oneLine(`Question · ${header}`) : n.body
  }
  return oneLine(`${decisionChipLabel(pending.kind)} · ${inputSummary(pending.input) ?? decisionHeadline(pending)}`)
}

/**
 * `needsInput` draws 9g's needs-input form: the state glyph, the amber edge,
 * and " needs input" after a title that truncates before it. Only a
 * `needs_input` report wears it; a Done is a plain banner (ADR
 * a-finished-turn-is-done-not-needs-input).
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
/** True while the notifier folds a hub frame: what it reports then is reported in step with that frame. */
let folding = false

let notifier = newNotifier()
let active = true
let wired = false
/** What the Mac last said about the user being at it; false until it says, and again once the tunnel is gone. */
let atMac = false
/**
 * The sessions whose "needs your input" or "Done" is on the shade: one
 * leaving `needs_input` takes it off, so the shade shows each session's
 * latest state.
 */
const askingOnShade = new Set<string>()

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
    if (event.type === 'ready') {
      atMac = false
      if (event.ready) {
        // An older Mac drops a topic it does not allow, and atMac stays false.
        clientRef.subscribe(PRESENCE_TOPIC)
        renew()
      } else {
        // The tunnel is gone: a stop held for its settle would be judged on
        // state no longer heard. The next tunnel renews the notifier.
        notifier.dispose()
      }
    } else if (event.type === 'hub') {
      const presence = presenceFromFrame(event.frame)
      if (presence !== null) {
        atMac = presence
        return
      }
      remember(event.frame)
      retireAnswered(event.frame)
      // A replay (a member that came back relists, one that went keeps its last) is folded
      // in as a seed: what changed while that member was away was its push's to report.
      if (isReplay(event.frame)) {
        notifier.seed((event.frame as { session?: unknown }).session)
        return
      }
      folding = true
      try {
        notifier.onEvent(event.frame)
      } finally {
        folding = false
      }
    }
  })
}

/** A frame the federation marks as something already known, not news (`GroupFederation`). */
function isReplay(frame: unknown): boolean {
  return typeof frame === 'object' && frame !== null && (frame as { replay?: unknown }).replay === true
}

function newNotifier(): SessionNotifier {
  return new SessionNotifier({
    notify: (n) => {
      // Reported by the frame itself (an end, a failure): after the listeners
      // still to hear it (the tunnel socket hands it to the store). A settled
      // stop comes from a timer, after every frame it waited for.
      if (folding) queueMicrotask(() => report(n))
      else report(n)
    },
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

/** Takes a session's "needs your input" or "Done" off the shade once the session has moved on. */
function retireAnswered(frame: unknown): void {
  const f = frame as (SessionsFrame & { status?: unknown; session?: { status?: unknown } }) | null
  if (f?.topic !== 'sessions') return
  const id = typeof f.sessionId === 'string' ? f.sessionId : typeof f.session?.id === 'string' ? f.session.id : null
  if (!id || !askingOnShade.has(id)) return
  const status = f.event === 'status' ? f.status : f.event === 'upsert' ? f.session?.status : undefined
  if (f.event !== 'remove' && (typeof status !== 'string' || status === 'needs_input')) return
  askingOnShade.delete(id)
  void removeDeliveredNotification(notificationId(id))
}

/**
 * Seeds the notifier with sessions read some other way than the hub — the
 * cached list when a tunnel opens, the Mac's list once `resync` has read it.
 * The Mac's `ServingHalf` replays nothing on subscribe, so without this a
 * fresh notifier would spend each session's first transition learning that
 * the session exists. A seed never reports: anything that changed while the
 * tunnel was down was the push's to report.
 */
export function seedNotifications(sessions: readonly ApiSession[]): void {
  for (const session of sessions) {
    if (heard.has(session.id)) continue
    notifier.seed(session)
  }
}

/**
 * Every new tunnel gets a fresh notifier, seeded from the list the store
 * holds; `resync` seeds it again from the Mac's list. The rules are read
 * again with it.
 */
function renew(): void {
  // What the old tunnel's notifier still holds is that tunnel's to report.
  notifier.dispose()
  notifier = newNotifier()
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
  const audience = decideNotification(n, { active, viewing: screen === 'session' ? sessionId : null, rules, atMac })
  if (audience.banner && !BANNERLESS.has(screen)) {
    const pending = n.sessionId ? pendingFor(n.sessionId) : undefined
    useBanner.getState().show({
      sessionId: n.sessionId,
      title: n.title,
      needsInput: n.kind === 'needs_input',
      line: bannerLine(n, pending),
    })
  }
  if (audience.system) {
    if (n.sessionId !== null) {
      if (n.kind === 'needs_input' || n.kind === 'done') askingOnShade.add(n.sessionId)
      else askingOnShade.delete(n.sessionId)
    }
    void postLocalNotification({
      id: notificationId(n.sessionId), title: n.title, body: n.body, channelId: channelFor(rules), sound: rules.sound, sessionId: n.sessionId,
    })
  }
}
