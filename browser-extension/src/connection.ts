/**
 * What the service worker does when its socket closes, and how long it
 * waits before trying again. Pure, so the close-code rules are tested
 * without a browser.
 */

import { BROWSER_CLOSE, type BrowserDropReason } from './protocol'

export type ConnectionStatus =
  /** No token: the popup asks for a pairing code. */
  | 'unpaired'
  | 'connecting'
  | 'connected'
  /** Orbital is not running, or not on this port. */
  | 'offline'
  /** The Labs switch is off in Orbital. */
  | 'disabled'

export interface CloseDecision {
  status: ConnectionStatus
  /** The server no longer knows the token. */
  forgetToken: boolean
  /** Schedule another attempt. */
  retry: boolean
}

/**
 * @param hasToken whether a token is stored (after a successful `paired` on
 *   this socket, it is).
 */
export function decideOnClose(code: number, hasToken: boolean): CloseDecision {
  if (code === BROWSER_CLOSE.unauthorized)
    return { status: 'unpaired', forgetToken: true, retry: false }
  // The switch may come back on; keep knocking, slowly.
  if (code === BROWSER_CLOSE.disabled)
    return { status: 'disabled', forgetToken: false, retry: hasToken }
  // Without a token there is nothing to reconnect with: a pairing attempt
  // that could not reach Orbital says so and waits for the next code.
  return { status: 'offline', forgetToken: false, retry: hasToken }
}

export const RECONNECT_BASE_MS = 1_000
export const RECONNECT_MAX_MS = 30_000
/** While the switch is off nothing is lost by asking rarely. */
export const RECONNECT_DISABLED_MS = 60_000

/** The wait before attempt number `attempt` (0 for the first retry). */
export function reconnectDelay(attempt: number, status: ConnectionStatus): number {
  if (status === 'disabled') return RECONNECT_DISABLED_MS
  return Math.min(RECONNECT_BASE_MS * 2 ** Math.max(0, attempt), RECONNECT_MAX_MS)
}

/** Keeps the MV3 worker alive while connected: well under its idle limit. */
export const PING_INTERVAL_MS = 20_000

/** No outcome within this reads as "no Orbital window" (spec). */
export const OUTCOME_TIMEOUT_MS = 5_000

/**
 * How long one connection check may take before it counts as "not
 * running" (canvas 64g): the popup shows one bounded check, not a spinner.
 */
export const CONNECT_TIMEOUT_MS = 5_000

const NOT_SENT = ' — not sent'

const DROP_TEXT: Record<BrowserDropReason, string> = {
  'no-session': 'Nothing open in Orbital',
  'no-window': 'Nothing open in Orbital',
  foreign: 'The open session runs on another Mac',
  'composer-full': 'The composer is full',
}

/** The popup's outcome line for a screenshot the user took. */
export function outcomeText(outcome: {
  delivered: boolean
  sessionTitle?: string
  reason?: BrowserDropReason
}): string {
  if (outcome.delivered) return `Sent to ${outcome.sessionTitle || 'Orbital'}`
  return DROP_TEXT[outcome.reason ?? 'no-window'] + NOT_SENT
}

/** Why a screenshot never left the extension. */
export function notSentText(status: ConnectionStatus): string {
  switch (status) {
    case 'unpaired':
      return 'Not paired with Orbital' + NOT_SENT
    case 'disabled':
      return 'Browser bridge is off in Orbital' + NOT_SENT
    default:
      return 'Orbital isn’t running' + NOT_SENT
  }
}

/** A tab the browser will not capture: chrome:// pages, the Web Store. */
export const CAPTURE_FAILED_TEXT = 'This tab can’t be captured' + NOT_SENT
