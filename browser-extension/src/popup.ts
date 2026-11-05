/** The popup (canvas 64g): one state at a time, pairing, the screenshot button, the last outcome. */

import type { ConnectionStatus } from './connection'
import { drawIcon } from './icon'
import {
  LOCAL_KEYS,
  parsePort,
  SESSION_KEY,
  type BridgeState,
  type WorkerMessage,
} from './messages'
import { isCompleteCode, normaliseCode } from './pairingCode'
import { checkedText, formatShortcut } from './popupText'
import { DEFAULT_ORBITAL_PORT } from './selection'

const TAG: Record<ConnectionStatus, string> = {
  unpaired: 'NOT PAIRED',
  connecting: 'CONNECTING',
  offline: 'NOT RUNNING',
  disabled: 'OFF IN ORBITAL',
  connected: 'CONNECTED',
}

/** The key cap when the browser cannot say which shortcut it assigned. */
const FALLBACK_SHORTCUT = '⌘⇧S'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const tag = $<HTMLSpanElement>('tag')
const states = {
  unpaired: $<HTMLElement>('state-unpaired'),
  connecting: $<HTMLElement>('state-connecting'),
  offline: $<HTMLElement>('state-offline'),
  disabled: $<HTMLElement>('state-disabled'),
  connected: $<HTMLElement>('state-connected'),
} satisfies Record<ConnectionStatus, HTMLElement>
const pairForm = $<HTMLFormElement>('pair')
const code = $<HTMLInputElement>('code')
const boxes = [...pairForm.querySelectorAll<HTMLSpanElement>('.box')]
const pairButton = $<HTMLButtonElement>('pair-button')
const pairError = $<HTMLParagraphElement>('pair-error')
const port = $<HTMLInputElement>('port')
const checked = $<HTMLParagraphElement>('checked')
const keycap = $<HTMLElement>('keycap')
const log = $<HTMLDivElement>('log')
const shot = $<HTMLParagraphElement>('shot')
const agent = $<HTMLParagraphElement>('agent')
const foot = $<HTMLElement>('foot')
const where = $<HTMLSpanElement>('where')

let hasToken = false
let currentPort = DEFAULT_ORBITAL_PORT
let current: BridgeState | undefined

function tell(message: WorkerMessage): void {
  void chrome.runtime.sendMessage(message).catch(() => {})
}

const clock = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

// ── the mark, drawn from the toolbar icon's 16 px geometry at the screen's density

function drawMark(): void {
  const canvas = $<HTMLCanvasElement>('mark')
  const ratio = Math.max(1, Math.round(devicePixelRatio))
  canvas.width = canvas.height = 16 * ratio
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.scale(ratio, ratio)
  drawIcon(ctx, 16)
}

// ── the code boxes ─────────────────────────────────────────────────────────

function renderCode(): void {
  const value = code.value
  const focused = document.activeElement === code
  boxes.forEach((box, i) => {
    box.textContent = value[i] ?? ''
    box.classList.toggle('next', focused && i === value.length)
  })
  pairButton.disabled = !isCompleteCode(value) || current?.status === 'connecting'
}

code.maxLength = 64 // a pasted code may carry spaces or a dash; normalise trims it
code.addEventListener('input', () => {
  const next = normaliseCode(code.value)
  if (next !== code.value) code.value = next
  code.setSelectionRange(next.length, next.length)
  renderCode()
})
code.addEventListener('focus', renderCode)
code.addEventListener('blur', renderCode)

pairForm.addEventListener('submit', (ev) => {
  ev.preventDefault()
  if (!isCompleteCode(code.value)) return
  tell({ kind: 'pair', code: code.value })
})

// ── the port, under Advanced ───────────────────────────────────────────────

port.addEventListener('change', () => {
  const next = parsePort(port.value.trim(), currentPort)
  port.value = String(next)
  void chrome.storage.local.set({ [LOCAL_KEYS.port]: next })
})
port.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') port.blur()
})

// ── the rest ───────────────────────────────────────────────────────────────

$<HTMLButtonElement>('retry').addEventListener('click', () => tell({ kind: 'wake' }))
$<HTMLButtonElement>('screenshot').addEventListener('click', () => tell({ kind: 'screenshot' }))
$<HTMLButtonElement>('unpair').addEventListener('click', () => tell({ kind: 'unpair' }))

/** Without a token the popup stays on the pairing form, whatever the last check said. */
function visibleStatus(state: BridgeState | undefined): ConnectionStatus {
  if (!hasToken) return 'unpaired'
  return state?.status === 'unpaired' ? 'unpaired' : (state?.status ?? 'connecting')
}

function pairErrorText(state: BridgeState | undefined): string {
  if (state?.pairError) return state.pairError
  if (state?.status === 'offline') return `Nothing answered on port ${currentPort}. Open Orbital first.`
  if (state?.status === 'disabled') return 'Browser bridge is off in Orbital. Turn it on in Settings → Labs.'
  return ''
}

function render(): void {
  const state = current
  const status = visibleStatus(state)
  tag.textContent = TAG[status]
  for (const [key, el] of Object.entries(states)) el.hidden = key !== status

  for (const el of document.querySelectorAll<HTMLElement>('[data-port]'))
    el.textContent = String(currentPort)
  where.textContent = `localhost:${currentPort}`
  foot.hidden = !hasToken

  // Not paired: a pairing attempt in flight shows in the button, a refusal under it.
  const pairing = !hasToken && state?.status === 'connecting'
  pairButton.textContent = pairing ? 'Connecting…' : 'Pair'
  const error = pairing ? '' : pairErrorText(state)
  pairError.hidden = !error
  pairError.textContent = error
  renderCode()

  checked.textContent = state?.checkedAt ? checkedText(state.checkedAt, Date.now(), clock) : ''

  const last = state?.lastShot
  shot.hidden = !last
  if (last) {
    $('shot-glyph').textContent = last.delivered ? '✓' : '–'
    $('shot-text').textContent = last.text
    $('shot-time').textContent = clock(last.at)
  }
  const agentShot = state?.agentShot
  agent.hidden = !agentShot
  if (agentShot) $('agent-time').textContent = clock(agentShot.at)
  log.hidden = !last && !agentShot
}

async function refresh(): Promise<void> {
  const [local, session] = await Promise.all([
    chrome.storage.local.get([LOCAL_KEYS.token, LOCAL_KEYS.port]),
    chrome.storage.session.get(SESSION_KEY),
  ])
  const hadToken = hasToken
  hasToken = Boolean(local[LOCAL_KEYS.token])
  currentPort = parsePort(local[LOCAL_KEYS.port], DEFAULT_ORBITAL_PORT)
  if (document.activeElement !== port) port.value = String(currentPort)
  // A fresh pairing, or an unpair: start the form from empty.
  if (hadToken !== hasToken) code.value = ''
  current = session[SESSION_KEY] as BridgeState | undefined
  render()
}

async function showShortcut(): Promise<void> {
  let text = FALLBACK_SHORTCUT
  try {
    const commands = await chrome.commands.getAll()
    const command = commands.find((c) => c.name === 'take-screenshot')
    if (command) text = formatShortcut(command.shortcut ?? '')
  } catch {
    // keep the fallback
  }
  // The browser assigns no shortcut when another one holds it: no key cap then.
  keycap.hidden = !text
  keycap.textContent = text
}

drawMark()
void showShortcut()
chrome.storage.onChanged.addListener(() => void refresh())
// "checked just now" ages while the popup stays open.
setInterval(render, 15_000)
tell({ kind: 'wake' })
void refresh().then(() => {
  if (!hasToken) code.focus()
})

