/**
 * The service worker: one WebSocket to Orbital's `/ws/browser`, the events
 * the content script and the popup hand it, and the screenshots the agent
 * asks for.
 */

import { browserNameFromBrands } from './browserName'
import {
  decideOnClose,
  notSentText,
  OUTCOME_TIMEOUT_MS,
  outcomeText,
  PING_INTERVAL_MS,
  reconnectDelay,
  type ConnectionStatus,
  type EventKind,
} from './connection'
import {
  LOCAL_KEYS,
  parsePort,
  SESSION_KEY,
  type BridgeState,
  type WorkerMessage,
} from './messages'
import { BROWSER_WS_PATH, type ExtensionFrame, type ServerFrame } from './protocol'
import { DEFAULT_ORBITAL_PORT } from './selection'

type EventFrame = Extract<ExtensionFrame, { type: 'selection' | 'screenshot' }>

/** Events made while the socket was not ready; sent once it is, if still fresh. */
const OUTBOX_MAX = 5
const OUTBOX_TTL_MS = 10_000
const BADGE_MS = 4_000

let socket: WebSocket | null = null
let ready = false
let attempt = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null
let badgeTimer: ReturnType<typeof setTimeout> | null = null
let opening = false
const outbox: { frame: EventFrame; at: number }[] = []
const pending = new Map<string, { kind: EventKind; timer: ReturnType<typeof setTimeout> }>()

// ── state the popup reads ──────────────────────────────────────────────────

let state: BridgeState = { status: 'connecting' }
const stateLoaded = chrome.storage.session.get(SESSION_KEY).then((stored) => {
  const saved = stored[SESSION_KEY] as BridgeState | undefined
  if (saved?.lastOutcome) state = { ...state, lastOutcome: saved.lastOutcome }
})

async function setState(patch: Partial<BridgeState>): Promise<void> {
  await stateLoaded
  const next = { ...state, ...patch }
  if (JSON.stringify(next) === JSON.stringify(state)) return
  state = next
  await chrome.storage.session.set({ [SESSION_KEY]: state })
}

function setStatus(status: ConnectionStatus, pairError?: string): void {
  void setState({ status, pairError })
}

async function settings(): Promise<{ token?: string; port: number }> {
  const stored = await chrome.storage.local.get([LOCAL_KEYS.token, LOCAL_KEYS.port])
  const token = stored[LOCAL_KEYS.token]
  return {
    token: typeof token === 'string' && token ? token : undefined,
    port: parsePort(stored[LOCAL_KEYS.port], DEFAULT_ORBITAL_PORT),
  }
}

function browserName(): string {
  const data = (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } })
    .userAgentData
  return browserNameFromBrands(data?.brands)
}

// ── the badge ──────────────────────────────────────────────────────────────

function flashBadge(ok: boolean): void {
  if (badgeTimer) clearTimeout(badgeTimer)
  void chrome.action.setBadgeBackgroundColor({ color: ok ? '#2f855a' : '#9b2c2c' })
  void chrome.action.setBadgeText({ text: ok ? '✓' : '×' })
  badgeTimer = setTimeout(() => void chrome.action.setBadgeText({ text: '' }), BADGE_MS)
}

function report(text: string, ok: boolean): void {
  flashBadge(ok)
  void setState({ lastOutcome: { text, at: Date.now() } })
}

// ── the socket ─────────────────────────────────────────────────────────────

function send(frame: ExtensionFrame): void {
  socket?.send(JSON.stringify(frame))
}

function clearRetry(): void {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
}

function drop(old: WebSocket | null): void {
  if (!old) return
  old.onopen = old.onmessage = old.onclose = old.onerror = null
  old.close(1000)
}

/**
 * Opens the socket unless one is open or opening. With a pairing code the
 * current socket is replaced by one that pairs.
 */
async function connect(pairCode?: string): Promise<void> {
  if (!pairCode && (socket || opening)) return
  opening = true
  clearRetry()
  try {
    const { token, port } = await settings()
    if (!pairCode && !token) {
      setStatus('unpaired')
      return
    }
    if (!pairCode && socket) return // another call got here first
    drop(socket)
    stopPing()
    ready = false
    setStatus('connecting')

    const ws = new WebSocket(`ws://127.0.0.1:${port}${BROWSER_WS_PATH}`)
    socket = ws
    ws.onopen = () => {
      const browser = browserName()
      send(
        pairCode
          ? { type: 'pair', code: pairCode, browser }
          : { type: 'hello', token: token!, browser },
      )
    }
    ws.onmessage = (ev) => {
      let frame: ServerFrame
      try {
        frame = JSON.parse(String(ev.data)) as ServerFrame
      } catch {
        return
      }
      void onFrame(ws, frame)
    }
    ws.onclose = (ev) => void onClose(ws, ev.code)
  } finally {
    opening = false
  }
}

async function onFrame(ws: WebSocket, frame: ServerFrame): Promise<void> {
  if (ws !== socket) return
  switch (frame.type) {
    case 'paired':
      await chrome.storage.local.set({ [LOCAL_KEYS.token]: frame.token })
      onReady()
      return
    case 'welcome':
      onReady()
      return
    case 'pair_failed':
      setStatus('unpaired', frame.reason)
      ws.close(1000)
      return
    case 'pong':
      return
    case 'outcome': {
      const entry = pending.get(frame.eventId)
      if (!entry) return
      clearTimeout(entry.timer)
      pending.delete(frame.eventId)
      report(outcomeText(entry.kind, frame), frame.delivered)
      return
    }
    case 'capture':
      await answerCapture(frame.requestId)
      return
  }
}

function onReady(): void {
  ready = true
  attempt = 0
  setStatus('connected')
  startPing()
  const now = Date.now()
  for (const { frame, at } of outbox.splice(0)) {
    if (now - at <= OUTBOX_TTL_MS) dispatch(frame)
  }
}

async function onClose(ws: WebSocket, code: number): Promise<void> {
  if (ws !== socket) return
  socket = null
  ready = false
  stopPing()
  const { token } = await settings()
  const decision = decideOnClose(code, Boolean(token))
  if (decision.forgetToken) await chrome.storage.local.remove(LOCAL_KEYS.token)
  // A refused pairing code already set `unpaired` with its reason; keep it.
  if (!(state.pairError && !token)) setStatus(decision.status)
  for (const { frame } of outbox.splice(0)) report(notSentText(frame.type, decision.status), false)
  if (decision.retry) {
    retryTimer = setTimeout(() => void connect(), reconnectDelay(attempt++, decision.status))
  }
}

function startPing(): void {
  stopPing()
  pingTimer = setInterval(() => send({ type: 'ping' }), PING_INTERVAL_MS)
}

function stopPing(): void {
  if (pingTimer) clearInterval(pingTimer)
  pingTimer = null
}

// ── events ─────────────────────────────────────────────────────────────────

function dispatch(frame: EventFrame): void {
  send(frame)
  const timer = setTimeout(() => {
    pending.delete(frame.eventId)
    report(outcomeText(frame.type, { delivered: false, reason: 'no-window' }), false)
  }, OUTCOME_TIMEOUT_MS)
  pending.set(frame.eventId, { kind: frame.type, timer })
}

function emit(frame: EventFrame): void {
  if (ready && socket?.readyState === WebSocket.OPEN) {
    dispatch(frame)
    return
  }
  // The worker may have just woken for this very event; give the socket a moment.
  outbox.push({ frame, at: Date.now() })
  if (outbox.length > OUTBOX_MAX) outbox.shift()
  void connect().then(() => {
    if (!socket && outbox.length) {
      for (const { frame: f } of outbox.splice(0)) report(notSentText(f.type, state.status), false)
    }
  })
}

// ── screenshots ────────────────────────────────────────────────────────────

/** The visible part of the active tab in the browser window used last. */
async function captureActiveTab(): Promise<{ dataUrl: string; url: string; title: string }> {
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] })
  if (win.id === undefined) throw new Error('No browser window is open.')
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id })
  const dataUrl = await chrome.tabs.captureVisibleTab(win.id, { format: 'png' })
  return { dataUrl, url: tab?.url ?? '', title: tab?.title ?? '' }
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message || 'The browser refused the capture.'
}

async function answerCapture(requestId: string): Promise<void> {
  try {
    const shot = await captureActiveTab()
    send({ type: 'captured', requestId, ...shot })
  } catch (error) {
    // chrome:// pages, the Web Store and other extensions' pages cannot be captured.
    send({ type: 'capture_failed', requestId, reason: errorText(error) })
  }
}

async function takeScreenshot(): Promise<void> {
  try {
    const shot = await captureActiveTab()
    emit({ type: 'screenshot', eventId: crypto.randomUUID(), ...shot })
  } catch (error) {
    report(`Screenshot failed: ${errorText(error)}`, false)
  }
}

// ── wiring ─────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: WorkerMessage) => {
  switch (message.kind) {
    case 'selection':
      emit({
        type: 'selection',
        eventId: crypto.randomUUID(),
        text: message.text,
        url: message.url,
        title: message.title,
      })
      break
    case 'screenshot':
      void takeScreenshot()
      break
    case 'pair':
      attempt = 0
      void connect(message.code.trim())
      break
    case 'unpair':
      void chrome.storage.local.remove(LOCAL_KEYS.token).then(() => {
        clearRetry()
        drop(socket)
        socket = null
        ready = false
        stopPing()
        setStatus('unpaired')
      })
      break
    case 'wake':
      attempt = 0
      void connect()
      break
  }
  return false
})

chrome.commands.onCommand.addListener((command) => {
  if (command === 'take-screenshot') void takeScreenshot()
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(LOCAL_KEYS.port in changes)) return
  // A new port: drop the socket and try the new one.
  drop(socket)
  socket = null
  ready = false
  stopPing()
  attempt = 0
  void connect()
})

// The worker sleeps when idle and nothing is connected; switching tabs
// wakes it, which is when Orbital may have started meanwhile.
chrome.tabs.onActivated.addListener(() => void connect())
chrome.windows.onFocusChanged.addListener(() => void connect())
chrome.runtime.onStartup.addListener(() => void connect())
chrome.runtime.onInstalled.addListener(() => void connect())

void connect()
