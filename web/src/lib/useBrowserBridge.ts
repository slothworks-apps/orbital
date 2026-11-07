import { useEffect } from 'react'
import { api } from './api'
import {
  BROWSER_TOPIC,
  LAST_FOCUSED_KEY,
  browserBridgeOffered,
  deliverTarget,
  needsRecordAlive,
  newWindowId,
  outcomeFor,
  parseLastFocused,
  screenshotName,
  windowActs,
  windowLockName,
  type BrowserDelivery,
  type BrowserHubEvent,
  type BrowserStatus,
  type DeliverTarget,
} from './browserBridge'
import { getSocket } from './socket'
import { hasDesktopBridge, isWindowShown, onWindowShownChanged } from './desktop'
import { useOrbital } from '../store/store'

/**
 * The browser bridge in one Orbital window (spec
 * 2026-11-05-browser-bridge-design § Which session gets an event): it keeps
 * the last-focused record, hears every `browser` event, and — when it is the
 * window focused last — puts the event into its open session's composer and
 * tells the server what became of it.
 *
 * Mounted by the main window and by a detached session window. Never by the
 * phone, which is left out on purpose.
 */

/** This window's id in `LAST_FOCUSED_KEY`, fixed for the page's lifetime. */
const windowId = newWindowId()

/**
 * The lock that says this window still exists, held until the page goes
 * (`windowLockName`). Taken on the first mount of the bridge, never given back.
 */
let lockTaken = false
function holdWindowLock(): void {
  if (lockTaken || typeof navigator === 'undefined' || !navigator.locks) return
  lockTaken = true
  void navigator.locks.request(windowLockName(windowId), () => new Promise<never>(() => {})).catch(() => {})
}

/**
 * Whether the window `id` names still exists: it holds its lock. Where the
 * browser has no Web Locks, every window counts as existing, which is how it
 * was before the check.
 */
async function windowAlive(id: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.locks) return true
  try {
    const { held = [] } = await navigator.locks.query()
    return held.some((lock) => lock.name === windowLockName(id))
  } catch {
    return true
  }
}

/**
 * What an event needs from the open composer: whether it shows one at all,
 * how full it is, and a way to put a stored image in it as a chip. The detail
 * panel registers one while it shows a session; a window holds one panel, so
 * one intake.
 */
export interface BrowserIntake {
  sessionId: string
  /** The session is shown without a composer: live in a terminal, or behind the device lock. */
  readOnly: boolean
  attachmentCount(): number
  /** False when the composer refused the chip (it filled meanwhile). */
  adoptImage(image: {
    ref: string
    name: string
    w: number | null
    h: number | null
    bytes: number
    browser: { title: string; url: string; at: number }
  }): boolean
}

let intake: BrowserIntake | null = null

/** Registers the shown session's composer; the returned function takes it back. */
export function registerBrowserIntake(next: BrowserIntake): () => void {
  intake = next
  return () => {
    if (intake === next) intake = null
  }
}

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function readRecord() {
  return parseLastFocused(storage()?.getItem(LAST_FOCUSED_KEY) ?? null)
}

function markFocused(): void {
  // A window that is not shown cannot be the one you were in.
  if (!isWindowShown()) return
  storage()?.setItem(LAST_FOCUSED_KEY, JSON.stringify({ windowId, at: Date.now() }))
}

/** Takes the record back while it still names `owner`: this window, or one found gone. */
function releaseRecord(owner: string = windowId): void {
  const store = storage()
  if (readRecord()?.windowId === owner) store?.removeItem(LAST_FOCUSED_KEY)
}

/**
 * Which session this window has open, as the bridge sees it: the panel's
 * session, unless a page stands in front of it — Settings or the New Session
 * dialog — which is not a session open (spec: "the map with nothing selected,
 * Settings").
 */
function openSessionId(): string | null {
  const dialog = useOrbital.getState().ui.dialog
  if (dialog === 'settings' || dialog === 'new') return null
  return intake?.sessionId ?? null
}

async function deliver(event: BrowserDelivery, isMainWindow: boolean): Promise<void> {
  const self = { windowId, isMainWindow, shown: isWindowShown() }
  const record = readRecord()
  // Only the main window asks, and only about another window's record: a
  // window that crashed left it behind, and the main window answers for it.
  const recordAlive = needsRecordAlive(record, self) ? await windowAlive(record!.windowId) : true
  if (!recordAlive) releaseRecord(record!.windowId)
  const sessionId = openSessionId()
  let target: DeliverTarget | null = deliverTarget({
    windowActs: windowActs({ record, self, recordAlive }),
    openSessionId: sessionId,
    sessionIsForeign: sessionId ? useOrbital.getState().sessions[sessionId]?.machine !== undefined : false,
    readOnly: intake?.readOnly ?? false,
    kind: event.type,
    attachmentCount: intake?.attachmentCount() ?? 0,
  })
  if (!target) return
  if ('sessionId' in target) {
    if (event.type === 'browser_selection') {
      useOrbital.getState().setBrowserSelection(target.sessionId, {
        eventId: event.eventId,
        text: event.text,
        url: event.url,
        title: event.title,
        at: event.at,
      })
    } else {
      const adopted = intake?.adoptImage({
        ref: event.ref,
        name: screenshotName(event.title, event.url),
        w: event.w ?? null,
        h: event.h ?? null,
        bytes: event.bytes ?? 0,
        browser: { title: event.title, url: event.url, at: event.at },
      })
      // The count said there was room, the composer said otherwise.
      if (!adopted) target = { drop: 'composer-full' }
    }
  }
  // Nothing waits for this: an answer that never comes reads as no window.
  void api.browserOutcome(outcomeFor(event.eventId, target)).catch(() => {})
}

/** Settings' live copy of `GET /api/browser`, fed by `browser_status`. */
type StatusListener = (status: BrowserStatus) => void
const statusListeners = new Set<StatusListener>()

/** Follows the bridge's status while Settings shows it; returns the unsubscribe. */
export function onBrowserStatus(listener: StatusListener): () => void {
  statusListeners.add(listener)
  return () => {
    statusListeners.delete(listener)
  }
}

function handle(event: BrowserHubEvent, isMainWindow: boolean): void {
  if (event?.type === 'browser_status') {
    for (const listener of statusListeners) listener(event.status)
    return
  }
  if (event?.type === 'browser_selection' || event?.type === 'browser_screenshot') void deliver(event, isMainWindow)
}

/** Whether this page offers the bridge: the desktop app, or `npm run dev`. */
export function browserBridgeOfferedHere(): boolean {
  return browserBridgeOffered({ desktop: hasDesktopBridge(), dev: import.meta.env.DEV })
}

export function useBrowserBridge({ isMainWindow }: { isMainWindow: boolean }): void {
  useEffect(() => {
    if (!browserBridgeOfferedHere()) return
    holdWindowLock()
    if (document.hasFocus()) markFocused()
    const onFocus = () => markFocused()
    // A closing window that holds the record lets it go, so the main window
    // answers instead of nobody.
    const onPageHide = () => releaseRecord()
    // So does one hidden by its close button (on macOS the main window only
    // hides) or minimised: it is not where you were. Shown again, it takes the
    // record back once it has focus.
    const stopShown = onWindowShownChanged((shown) => {
      if (!shown) releaseRecord()
      else if (document.hasFocus()) markFocused()
    })
    window.addEventListener('focus', onFocus)
    window.addEventListener('pagehide', onPageHide)
    const unsubscribe = getSocket().subscribe(BROWSER_TOPIC, (msg: BrowserHubEvent) => handle(msg, isMainWindow))
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('pagehide', onPageHide)
      stopShown()
      unsubscribe()
    }
  }, [isMainWindow])
}
