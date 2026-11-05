/** The popup: connection state, pairing, the Screenshot button, the last outcome. */

import type { ConnectionStatus } from './connection'
import {
  LOCAL_KEYS,
  parsePort,
  SESSION_KEY,
  type BridgeState,
  type WorkerMessage,
} from './messages'
import { DEFAULT_ORBITAL_PORT } from './selection'

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  unpaired: 'Not paired',
  connecting: 'Connecting…',
  connected: 'Connected to Orbital',
  offline: 'Orbital is not reachable',
  disabled: 'Switched off in Orbital',
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const status = $<HTMLParagraphElement>('status')
const pairForm = $<HTMLFormElement>('pair')
const code = $<HTMLInputElement>('code')
const pairError = $<HTMLParagraphElement>('pair-error')
const outcome = $<HTMLParagraphElement>('outcome')
const screenshot = $<HTMLButtonElement>('screenshot')
const portForm = $<HTMLFormElement>('port-form')
const port = $<HTMLInputElement>('port')
const unpair = $<HTMLButtonElement>('unpair')

let hasToken = false

function tell(message: WorkerMessage): void {
  void chrome.runtime.sendMessage(message).catch(() => {})
}

function render(state: BridgeState | undefined): void {
  const current = state?.status ?? 'connecting'
  status.dataset.status = current
  status.textContent = STATUS_TEXT[current]
  pairForm.hidden = hasToken && current !== 'unpaired'
  pairError.hidden = !state?.pairError
  pairError.textContent = state?.pairError ?? ''
  unpair.hidden = !hasToken
  screenshot.disabled = current !== 'connected'
  outcome.hidden = !state?.lastOutcome
  outcome.textContent = state?.lastOutcome?.text ?? ''
}

async function refresh(): Promise<void> {
  const [local, session] = await Promise.all([
    chrome.storage.local.get([LOCAL_KEYS.token, LOCAL_KEYS.port]),
    chrome.storage.session.get(SESSION_KEY),
  ])
  hasToken = Boolean(local[LOCAL_KEYS.token])
  if (document.activeElement !== port)
    port.value = String(parsePort(local[LOCAL_KEYS.port], DEFAULT_ORBITAL_PORT))
  render(session[SESSION_KEY] as BridgeState | undefined)
}

pairForm.addEventListener('submit', (ev) => {
  ev.preventDefault()
  const value = code.value.trim()
  if (!value) return
  tell({ kind: 'pair', code: value })
  code.value = ''
})

portForm.addEventListener('submit', (ev) => {
  ev.preventDefault()
  void chrome.storage.local.set({ [LOCAL_KEYS.port]: parsePort(port.value, DEFAULT_ORBITAL_PORT) })
  port.blur()
})

screenshot.addEventListener('click', () => tell({ kind: 'screenshot' }))
unpair.addEventListener('click', () => tell({ kind: 'unpair' }))

chrome.storage.onChanged.addListener(() => void refresh())
tell({ kind: 'wake' })
void refresh()
