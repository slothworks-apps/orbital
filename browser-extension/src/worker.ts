/**
 * The service worker: one WebSocket to Orbital's `/ws/browser`, the events
 * the content script and the popup hand it, and the screenshots the agent
 * asks for.
 */

import { badgeFrames } from './badge'
import { browserNameFromBrands } from './browserName'
import {
  CAPTURE_FAILED_TEXT,
  CONNECT_TIMEOUT_MS,
  decideOnClose,
  notSentText,
  OUTCOME_TIMEOUT_MS,
  outcomeText,
  PING_INTERVAL_MS,
  reconnectDelay,
  type ConnectionStatus,
} from './connection'
import { drawIcon, type IconBadge, type IconSize } from './icon'
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

let socket: WebSocket | null = null
let ready = false
let attempt = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null
let connectTimer: ReturnType<typeof setTimeout> | null = null
let badgeTimers: ReturnType<typeof setTimeout>[] = []
let opening = false
const outbox: { frame: EventFrame; at: number }[] = []
/** Screenshots sent and waiting for their outcome; selections leave no line. */
const pending = new Map<string, ReturnType<typeof setTimeout>>()

// ── state the popup reads ──────────────────────────────────────────────────

let state: BridgeState = { status: 'connecting' }
const stateLoaded = chrome.storage.session.get(SESSION_KEY).then((stored) => {
  const saved = stored[SESSION_KEY] as BridgeState | undefined
  if (saved) state = { ...state, lastShot: saved.lastShot, agentShot: saved.agentShot }
})

async function setState(patch: Partial<BridgeState>): Promise<void> {
  await stateLoaded
  const next = { ...state, ...patch }
  if (JSON.stringify(next) === JSON.stringify(state)) return
  state = next
  await chrome.storage.session.set({ [SESSION_KEY]: state })
}

function setStatus(status: ConnectionStatus, pairError?: string): void {
  void setState({ status, pairError, checkedAt: status === 'offline' ? Date.now() : undefined })
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
// Only for screenshots the user takes (canvas 64h), drawn into the icon
// image so it can fade; a new screenshot replaces the one showing.

const TOOLBAR_SIZES: IconSize[] = [16, 32]

function setIconFrame(badge?: IconBadge): void {
  const imageData: Record<string, ImageData> = {}
  for (const size of TOOLBAR_SIZES) {
    const canvas = new OffscreenCanvas(size, size)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    drawIcon(ctx, size, badge)
    imageData[size] = ctx.getImageData(0, 0, size, size)
  }
  void chrome.action.setIcon({ imageData }).catch(() => {})
}

function flashBadge(ok: boolean): void {
  for (const timer of badgeTimers) clearTimeout(timer)
  badgeTimers = badgeFrames().map(({ at, opacity }) =>
    setTimeout(() => setIconFrame(opacity > 0 ? { ok, opacity } : undefined), at),
  )
}

function reportShot(delivered: boolean, text: string): void {
  flashBadge(delivered)
  void setState({ lastShot: { delivered, text, at: Date.now() } })
}

// ── the socket ─────────────────────────────────────────────────────────────

function send(frame: ExtensionFrame): void {
  socket?.send(JSON.stringify(frame))
}

function clearConnectTimer(): void {
  if (connectTimer) clearTimeout(connectTimer)
  connectTimer = null
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
    // One bounded check: a port that neither answers nor refuses reads as
    // not running once this runs out, and onclose takes it from there.
    clearConnectTimer()
    connectTimer = setTimeout(() => {
      if (ws === socket && !ready) ws.close()
    }, CONNECT_TIMEOUT_MS)
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
      const timer = pending.get(frame.eventId)
      if (!timer) return
      clearTimeout(timer)
      pending.delete(frame.eventId)
      reportShot(frame.delivered, outcomeText(frame))
      return
    }
    case 'capture':
      await answerCapture(frame.requestId)
      return
  }
}

function onReady(): void {
  clearConnectTimer()
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
  clearConnectTimer()
  const { token } = await settings()
  const decision = decideOnClose(code, Boolean(token))
  if (decision.forgetToken) await chrome.storage.local.remove(LOCAL_KEYS.token)
  // A refused pairing code already set `unpaired` with its reason; keep it.
  if (!(state.pairError && !token)) setStatus(decision.status)
  failOutbox(decision.status)
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
  if (frame.type !== 'screenshot') return
  const timer = setTimeout(() => {
    pending.delete(frame.eventId)
    reportShot(false, outcomeText({ delivered: false, reason: 'no-window' }))
  }, OUTCOME_TIMEOUT_MS)
  pending.set(frame.eventId, timer)
}

/** Events that could not wait for the socket: a screenshot says so, a selection just lapses. */
function failOutbox(status: ConnectionStatus): void {
  const lost = outbox.splice(0)
  if (lost.some(({ frame }) => frame.type === 'screenshot')) reportShot(false, notSentText(status))
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
    if (!socket && outbox.length) failOutbox(state.status)
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
    void setState({ agentShot: { at: Date.now() } })
  } catch (error) {
    // chrome:// pages, the Web Store and other extensions' pages cannot be captured.
    send({ type: 'capture_failed', requestId, reason: errorText(error) })
  }
}

async function takeScreenshot(): Promise<void> {
  try {
    const shot = await captureActiveTab()
    emit({ type: 'screenshot', eventId: crypto.randomUUID(), ...shot })
  } catch {
    reportShot(false, CAPTURE_FAILED_TEXT)
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
