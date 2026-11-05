import { useEffect } from 'react'
import { api } from './api'
import {
  BROWSER_TOPIC,
  LAST_FOCUSED_KEY,
  browserBridgeOffered,
  deliverTarget,
  isLastFocusedWindow,
  newWindowId,
  outcomeFor,
  parseLastFocused,
  screenshotName,
  type BrowserDelivery,
  type BrowserHubEvent,
  type BrowserStatus,
} from './browserBridge'
import { getSocket } from './socket'
import { hasDesktopBridge } from './desktop'
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
 * What a screenshot event needs from the open composer: how full it is, and
 * a way to put a stored image in it as a chip. The detail panel registers one
 * while it shows a session; a window holds one panel, so one intake.
 */
export interface BrowserIntake {
  sessionId: string
  attachmentCount(): number
  adoptImage(image: {
    ref: string
    name: string
    w: number | null
    h: number | null
    bytes: number
    browser: { title: string; url: string; at: number }
  }): void
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

function markFocused(): void {
  storage()?.setItem(LAST_FOCUSED_KEY, JSON.stringify({ windowId, at: Date.now() }))
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

function deliver(event: BrowserDelivery, isMainWindow: boolean): void {
  const record = parseLastFocused(storage()?.getItem(LAST_FOCUSED_KEY) ?? null)
  const sessionId = openSessionId()
  const target = deliverTarget({
    isLastFocusedWindow: isLastFocusedWindow(record, { windowId, isMainWindow }),
    openSessionId: sessionId,
    sessionIsForeign: sessionId ? useOrbital.getState().sessions[sessionId]?.machine !== undefined : false,
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
      intake?.adoptImage({
        ref: event.ref,
        name: screenshotName(event.title, event.url),
        w: event.w ?? null,
        h: event.h ?? null,
        bytes: event.bytes ?? 0,
        browser: { title: event.title, url: event.url, at: event.at },
      })
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
  if (event?.type === 'browser_selection' || event?.type === 'browser_screenshot') deliver(event, isMainWindow)
}

/** Whether this page offers the bridge: the desktop app, or `npm run dev`. */
export function browserBridgeOfferedHere(): boolean {
  return browserBridgeOffered({ desktop: hasDesktopBridge(), dev: import.meta.env.DEV })
}

export function useBrowserBridge({ isMainWindow }: { isMainWindow: boolean }): void {
  useEffect(() => {
    if (!browserBridgeOfferedHere()) return
    if (document.hasFocus()) markFocused()
    const onFocus = () => markFocused()
    // A closing window that holds the record lets it go, so the main window
    // answers instead of nobody.
    const onPageHide = () => {
      const store = storage()
      if (parseLastFocused(store?.getItem(LAST_FOCUSED_KEY) ?? null)?.windowId === windowId) {
        store?.removeItem(LAST_FOCUSED_KEY)
      }
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('pagehide', onPageHide)
    const unsubscribe = getSocket().subscribe(BROWSER_TOPIC, (msg: BrowserHubEvent) => handle(msg, isMainWindow))
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('pagehide', onPageHide)
      unsubscribe()
    }
  }, [isMainWindow])
}
