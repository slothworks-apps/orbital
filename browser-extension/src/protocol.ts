/**
 * The socket half of the browser bridge's wire shapes. This file MIRRORS
 * `server/src/browser/protocol.ts`, which is the source of truth: a change
 * there changes this file too, and the other way round.
 */

/** The extension's one endpoint. */
export const BROWSER_WS_PATH = '/ws/browser'

/** Why an event reached no session. */
export type BrowserDropReason = 'no-session' | 'no-window' | 'foreign' | 'composer-full'

// ── /ws/browser, extension → server ────────────────────────────────────────
// The socket's first frame is `pair` or `hello`; anything else closes it.

export type ExtensionFrame =
  | { type: 'pair'; code: string; browser: string }
  | { type: 'hello'; token: string; browser: string }
  | { type: 'ping' }
  | { type: 'selection'; eventId: string; text: string; url: string; title: string }
  /** A screenshot the user took. `dataUrl` is `data:image/png;base64,…`. */
  | { type: 'screenshot'; eventId: string; dataUrl: string; url: string; title: string }
  | { type: 'captured'; requestId: string; dataUrl: string; url: string; title: string }
  | { type: 'capture_failed'; requestId: string; reason: string }

// ── /ws/browser, server → extension ────────────────────────────────────────

export type ServerFrame =
  | { type: 'paired'; token: string }
  | { type: 'pair_failed'; reason: string }
  | { type: 'welcome' }
  | { type: 'pong' }
  | {
      type: 'outcome'
      eventId: string
      delivered: boolean
      /** The session's title when delivered. */
      sessionTitle?: string
      reason?: BrowserDropReason
    }
  /** The agent's `browser_screenshot`: capture the active tab. */
  | { type: 'capture'; requestId: string }

/** Close codes the extension acts on. */
export const BROWSER_CLOSE = {
  /** Token unknown or revoked: forget it and ask to pair again. */
  unauthorized: 4401,
  /** The Labs switch is off. */
  disabled: 4403,
} as const
