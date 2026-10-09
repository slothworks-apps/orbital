import { create } from 'zustand'
import type { LinkStatus, RemoteClientEvent } from '@orbital/shared/remote/client'
import type { EndedSummary } from '../lib/api'
import type { LockLabel } from './platform/deviceLock'
import type { Pairing } from './platform/parse'
import { lockOnBackground, lockOnReturn, type AppLock } from './lock'
import { MIN_SERVER_VERSION, isSupportedServer } from './version'

/** Navigation is in-memory state, not URLs (spec § 5). */
export type Screen = BaseScreen | PushedScreen

/** The screens that stand on their own. */
export type BaseScreen = 'pairing' | 'list' | 'session' | 'settings' | 'new' | 'unpaired' | 'mismatch'

/**
 * What can be pushed over a session (spec 2026-10-05-mobile-next § 3, § 2):
 * a subagent's transcript, a background task's output, a file, the session's
 * media (spec 2026-10-09-session-media-design § Phone). Each names its
 * session, which stays the open one underneath it.
 */
export type Pushed =
  | { kind: 'subagent'; sessionId: string; toolUseId: string }
  | { kind: 'task'; sessionId: string; taskId: string }
  | { kind: 'media'; sessionId: string }
  | {
      kind: 'file'
      sessionId: string
      /** As the transcript wrote it; null for an image known only by its content-addressed `ref`. */
      path: string | null
      /** The line a `path:42` mention points at; null for the top. */
      line: number | null
      ref?: string
      /** The message the press came from, whose images the viewer pages through. */
      messageId?: string
      /** The `cwd` that message was written in, which the path is read against (`FileCwdContext`). */
      cwd?: string
      /** The session's media item it is, when opened from the gallery: the viewer pages through the media. */
      mediaId?: string
    }

/**
 * What the session screen's composer is asked to do from outside it (spec
 * 2026-10-05-mobile-next § 1): `reopen` is a gate's Reopen — the field takes
 * the focus and says which step the message goes to. `step` is the step's
 * number as the user reads it (1-based), not its index.
 */
export type ComposerIntent = { kind: 'reopen'; step: number }

export type PushedScreen = Pushed['kind']
export type PushedOf<K extends PushedScreen> = Extract<Pushed, { kind: K }>

const PUSHED_SCREENS: ReadonlySet<Screen> = new Set<PushedScreen>(['subagent', 'task', 'media', 'file'])
export function isPushedScreen(screen: Screen): screen is PushedScreen {
  return PUSHED_SCREENS.has(screen)
}

/**
 * Why 9i shows (spec 2026-10-07-version-compatibility-design § 5): the part
 * that is too old, the version it runs and the oldest the other side works
 * with. `theirs` is the Mac's or the relay's version, null when the Mac never
 * said (a `bye protocol` before any hello). For `app` it is always null: the
 * part too old is this app, and the screen reads its own version.
 */
export type Mismatch = { cause: 'mac' | 'relay' | 'app'; theirs: string | null; needed: string | null }

/**
 * Relay `error` codes that mean this phone's pair no longer exists (spec
 * § 4); anything else is not about the pair. `bad_secret` is the client's
 * word for a relay secret the relay refused: the relay was re-keyed, and only
 * a new code carries the new secret (ADR the-relay-takes-a-shared-secret).
 */
export const UNPAIRED_RELAY_ERRORS: ReadonlySet<string> = new Set(['not_paired', 'unknown_device', 'bad_secret'])

export interface MobileState {
  screen: Screen
  /** Where 9e's Cancel and the back button return to from pairing. */
  previous: Screen | null
  sessionId: string | null
  /**
   * What is pushed over `sessionId`, the top last; empty on every base
   * screen. While a pushed screen shows, `screen` is its top's `kind`.
   */
  pushed: Pushed[]
  /** The relay link (9a header: `connecting` is the dim dot). */
  link: LinkStatus
  macOnline: boolean
  /** A live tunnel: cipher and the Mac's hello. */
  ready: boolean
  /** When live data last arrived; what the offline card's "as of" reads. */
  asOf: number | null
  /** When the last Retry or foreground check finished ("checked just now"). */
  checkedAt: number | null
  /**
   * Set while a Retry or a foreground check is in flight, holding what
   * `isMacAsleep` answered when it began: the check rebuilds the relay link,
   * and the drop it makes on the way must not flash the offline card.
   */
  rechecking: { asleep: boolean } | null
  /** When the Mac's session list was last read over the tunnel (9e's "N live sessions are waiting."). */
  listedAt: number | null
  /**
   * What the Mac said about the ENDED fold its list left out (`ended:
   * 'exclude'`), or null: before the first live list, or from a Mac that
   * sends every session anyway.
   */
  endedSummary: EndedSummary | null
  /** The fold has been read (`ended: 'only'`) and merged into the store; every resync reads it again. */
  endedLoaded: boolean
  /** What 9i explains; null while every part is new enough. */
  mismatch: Mismatch | null
  unpaired: boolean
  pairing: Pairing | null
  macName: string | null
  /**
   * The open composer's standing intent and the session it belongs to;
   * `seq` grows with every request, so asking twice focuses twice. Cleared
   * by a send, by going back to the list and by opening another session.
   */
  composerIntent: { sessionId: string; intent: ComposerIntent; seq: number } | null
  /**
   * The first of the two gates above every screen (spec
   * 2026-10-06-pairing-code-and-app-lock-design § 2, § 3): the device has no
   * screen lock, and 9s stands in front of the whole app. Both gates are
   * flags rather than screens, so whatever `screen` holds is still there
   * when they lift (9t: "success returns to wherever the app was").
   */
  screenLock: boolean
  /** The second gate, 9t (`AppLock`). */
  lock: AppLock
  /** 9f's "Require … to open"; it applies only while a Mac is paired (`lockEnabled`). */
  appLock: boolean
  /** What the device authenticates with, which 9f's toggle is named after. */
  lockLabel: LockLabel
  /** When the app last left the foreground; null while it is in front. */
  backgroundedAt: number | null
  /**
   * While the system prompt is up. It takes the app out of the foreground
   * (Android runs it in an activity of its own, iOS resigns active), and
   * those trips are not the user leaving.
   */
  authenticating: boolean
}

export const initialMobileState: MobileState = {
  screen: 'pairing', previous: null, sessionId: null, pushed: [], link: 'off', macOnline: false, ready: false,
  asOf: null, checkedAt: null, rechecking: null, listedAt: null, endedSummary: null, endedLoaded: false,
  mismatch: null, unpaired: false, pairing: null, macName: null, composerIntent: null,
  screenLock: false, lock: 'open', appLock: true, lockLabel: 'screen lock', backgroundedAt: null, authenticating: false,
}

/**
 * The Mac is away while the relay is not (spec § 5, "Transport states"): the
 * 9a offline card and 9b's offline transcript. A relay still connecting is
 * the header's dim dot and nothing else; while a check runs (`rechecking`)
 * the answer from before it holds.
 */
export function isMacAsleep(state: Pick<MobileState, 'link' | 'macOnline' | 'rechecking'>): boolean {
  if (state.rechecking) return state.rechecking.asleep
  return state.link === 'online' && !state.macOnline
}

/** The pair is over, by the Mac's hand or the relay's word (spec § 4). */
export function isPairGone(event: RemoteClientEvent): boolean {
  return (
    (event.type === 'bye' && event.reason === 'revoked') ||
    event.type === 'unpaired' ||
    (event.type === 'relay_error' && UNPAIRED_RELAY_ERRORS.has(event.code))
  )
}

/**
 * Whether a notice — 9g's View, a local notification's tap, a relay push's
 * tap — may take the reader anywhere: only with a pair that works. Unpaired,
 * mismatched or not yet paired, the screen showing is the only one there is.
 */
export function mayOpenFromNotice(state: Pick<MobileState, 'pairing' | 'unpaired' | 'mismatch'>): boolean {
  return state.pairing !== null && !state.unpaired && state.mismatch === null
}

/**
 * Whether the app lock applies: the setting is on and a Mac is paired. An
 * unpaired phone has nothing from a Mac to guard, and a fresh install does
 * not open on a lock screen.
 */
export function lockEnabled(state: Pick<MobileState, 'appLock' | 'pairing'>): boolean {
  return state.appLock && state.pairing !== null
}

/** 9s or 9t stands in front of the app: nothing underneath may show or be opened. */
export function isGated(state: Pick<MobileState, 'screenLock' | 'lock'>): boolean {
  return state.screenLock || state.lock !== 'open'
}

/** The app leaves the foreground (`appStateChange`): 9t covers it at once when the lock is on. */
export function leaveForeground(state: MobileState, now: number): Partial<MobileState> {
  if (state.authenticating) return {}
  return { backgroundedAt: now, lock: lockOnBackground(state.lock, lockEnabled(state)) }
}

/** The app is back in front: uncovered after a quick trip, asked after a long one. */
export function returnToForeground(state: MobileState, now: number): Partial<MobileState> {
  if (state.authenticating) return {}
  return {
    backgroundedAt: null,
    lock: lockOnReturn(state.lock, { enabled: lockEnabled(state), backgroundedAt: state.backgroundedAt, now }),
  }
}

/**
 * `isPairGone` for this phone as it stands. A refused relay secret ends a
 * pair only when one is stored: mid-pairing there is none to lose, and the
 * pairing run reports the refusal on its own screen instead of 9h.
 */
export function pairGoneFor(event: RemoteClientEvent, pairing: Pairing | null): boolean {
  if (event.type === 'relay_error' && event.code === 'bad_secret' && pairing === null) return false
  return isPairGone(event)
}

/** What one client event changes (spec § 5: offline, 9h, 9i). Pure; `useMobile.apply` writes it. */
export function reduce(state: MobileState, event: RemoteClientEvent, now: number): Partial<MobileState> {
  if (pairGoneFor(event, state.pairing)) {
    return { screen: 'unpaired', unpaired: true, sessionId: null, pushed: [], pairing: null, ready: false }
  }
  switch (event.type) {
    case 'status':
      // Only a relay new enough answers `ok`: one 9i called too old has been updated.
      if (event.status === 'online' && state.mismatch?.cause === 'relay') {
        return { link: event.status, ...leaveMismatch(state) }
      }
      return { link: event.status }
    case 'presence':
      return { macOnline: event.macOnline }
    case 'ready':
      return event.ready ? { ready: true, asOf: now } : { ready: false }
    case 'hub':
      return { asOf: now }
    case 'hello':
      if (!isSupportedServer(event.server)) {
        return {
          screen: 'mismatch', macName: event.macName,
          mismatch: { cause: 'mac', theirs: event.server, needed: MIN_SERVER_VERSION },
        }
      }
      return { macName: event.macName, ...leaveMismatch(state) }
    case 'bye':
      if (event.reason === 'app_too_old') {
        // The Mac sends its minimum with this reason; a bye without one (`needed` null) still names the cause.
        return { screen: 'mismatch', mismatch: { cause: 'app', theirs: null, needed: event.needed ?? null } }
      }
      // The Mac refused our protocol version; it says no more than that.
      return {
        screen: 'mismatch',
        mismatch: {
          cause: 'mac',
          theirs: state.mismatch?.cause === 'mac' ? state.mismatch.theirs : null,
          needed: MIN_SERVER_VERSION,
        },
      }
    case 'relay_too_old':
      // Mid-pairing there is no app behind 9i to block: the pairing run reports it on 9e.
      if (state.pairing === null) return {}
      return { screen: 'mismatch', mismatch: { cause: 'relay', theirs: event.relayVersion, needed: event.needed } }
    default:
      return {}
  }
}

/** Off 9i to the list, once what it explained no longer holds. */
function leaveMismatch(state: MobileState): Partial<MobileState> {
  return { mismatch: null, ...(state.screen === 'mismatch' ? { screen: 'list' as const } : {}) }
}

/**
 * The hardware back button and every ‹ (spec § 5): one level up; from the
 * list, out of the app. A pushed screen returns to what it was pushed over —
 * in the end its session, never the list (spec 2026-10-05-mobile-next § 3).
 */
export function back(state: MobileState): Partial<MobileState> | 'exit' {
  if (isPushedScreen(state.screen)) {
    const pushed = state.pushed.slice(0, -1)
    const top = pushed.at(-1)
    return { screen: top ? top.kind : 'session', pushed }
  }
  switch (state.screen) {
    case 'session':
      return { screen: 'list', sessionId: null, pushed: [], composerIntent: null }
    case 'settings':
    case 'new':
      return { screen: 'list' }
    case 'pairing':
      // Paired already (back on "Paired with", or while it waits for hello): the list, not where pairing began.
      if (state.pairing) return { screen: 'list', previous: null }
      return state.previous ? { screen: state.previous, previous: null } : 'exit'
    default:
      return 'exit'
  }
}

/**
 * Opening `item` (pure; the `open*` actions write it). From its own session
 * or a screen pushed over it, it goes on top, so back returns there — a
 * file opened from a task's output goes back to the output. From anywhere
 * else (the list, a notice, another session) its session opens underneath
 * it and nothing else is kept.
 */
export function push(state: MobileState, item: Pushed): Partial<MobileState> {
  const over =
    state.sessionId === item.sessionId && (state.screen === 'session' || isPushedScreen(state.screen))
  return {
    screen: item.kind,
    sessionId: item.sessionId,
    pushed: over ? [...state.pushed, item] : [item],
  }
}

/**
 * Whether the session screen of `id`, as it goes away, leaves the store's
 * selection alone: only when a screen is pushed over that same session (spec
 * 2026-10-05-mobile-next § 3). The store closes its subagent and task views
 * the moment the selection changes, and the pushed screen is one of them.
 */
export function keepsSelection(state: Pick<MobileState, 'screen' | 'sessionId'>, id: string): boolean {
  return isPushedScreen(state.screen) && state.sessionId === id
}

/** The top of the stack when it is a `kind`; what a pushed screen renders. */
export function pushedTop<K extends PushedScreen>(state: Pick<MobileState, 'pushed'>, kind: K): PushedOf<K> | null {
  const top = state.pushed.at(-1)
  return top && top.kind === kind ? (top as PushedOf<K>) : null
}

interface MobileActions {
  apply(event: RemoteClientEvent): void
  go(screen: BaseScreen): void
  openSession(id: string): void
  openSubagent(ref: { sessionId: string; toolUseId: string }): void
  openTask(ref: { sessionId: string; taskId: string }): void
  openFile(ref: Omit<PushedOf<'file'>, 'kind'>): void
  /** The ⋯ sheet's Media: the session's gallery, pushed over it. */
  openMedia(sessionId: string): void
  goBack(): 'exit' | 'stayed'
  /** Asks the open session's composer for `intent`; a gate's Reopen calls it. */
  focusComposer(intent: ComposerIntent): void
  clearComposerIntent(): void
  leaveForeground(): void
  returnToForeground(): void
}

export const useMobile = create<MobileState & MobileActions>()((set, get) => ({
  ...initialMobileState,
  apply: (event) => set(reduce(get(), event, Date.now())),
  go: (screen) => set((s) => ({ screen, previous: s.screen, pushed: [] })),
  openSession: (id) =>
    set((s) => ({
      screen: 'session', sessionId: id, pushed: [],
      composerIntent: s.composerIntent?.sessionId === id ? s.composerIntent : null,
    })),
  openSubagent: (ref) => set(push(get(), { kind: 'subagent', ...ref })),
  openTask: (ref) => set(push(get(), { kind: 'task', ...ref })),
  openFile: (ref) => set(push(get(), { kind: 'file', ...ref })),
  openMedia: (sessionId) => set(push(get(), { kind: 'media', sessionId })),
  goBack: () => {
    const next = back(get())
    if (next === 'exit') return 'exit'
    set(next)
    return 'stayed'
  },
  focusComposer: (intent) =>
    set((s) =>
      s.sessionId === null
        ? {}
        : { composerIntent: { sessionId: s.sessionId, intent, seq: (s.composerIntent?.seq ?? 0) + 1 } },
    ),
  clearComposerIntent: () => set((s) => (s.composerIntent ? { composerIntent: null } : {})),
  leaveForeground: () => set(leaveForeground(get(), Date.now())),
  returnToForeground: () => set(returnToForeground(get(), Date.now())),
}))

/** A notice tapped while 9s or 9t stood in front; the newest tap wins. */
let heldNotice: (() => void) | null = null

/**
 * The one guard 9g's View, a local notification's tap and a relay push's tap
 * share: `open` runs only while `mayOpenFromNotice`; otherwise the tap is
 * ignored. Behind a gate it waits, and runs once the gate lifts if the pair
 * still allows it then (spec 2026-10-06-pairing-code-and-app-lock-design § 3).
 */
export function openFromNotice(open: () => void): void {
  const state = useMobile.getState()
  if (isGated(state)) heldNotice = open
  else if (mayOpenFromNotice(state)) open()
}

useMobile.subscribe((state, previous) => {
  if (!heldNotice || isGated(state) || !isGated(previous)) return
  const open = heldNotice
  heldNotice = null
  if (mayOpenFromNotice(state)) open()
})

/** The open bottom sheets' dismissers, the newest last (`BottomSheet` keeps it). */
const openSheets: Array<{ dismiss: () => void }> = []

/** A sheet opening; the returned function is its closing. */
export function registerSheet(sheet: { dismiss: () => void }): () => void {
  openSheets.push(sheet)
  return () => {
    const at = openSheets.indexOf(sheet)
    if (at >= 0) openSheets.splice(at, 1)
  }
}

/**
 * The hardware back button's first stop: the topmost open sheet is
 * dismissed, as a backdrop tap would. Whether there was one; when not, back
 * navigates as usual.
 */
export function dismissTopSheet(): boolean {
  const top = openSheets.at(-1)
  if (!top) return false
  top.dismiss()
  return true
}
