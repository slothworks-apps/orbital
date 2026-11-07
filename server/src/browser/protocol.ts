/**
 * The browser bridge's wire shapes (spec 2026-11-05-browser-bridge-design).
 * The extension mirrors the socket half in `browser-extension/src/protocol.ts`
 * and the web mirrors the hub half in `web/src/lib/browserBridge.ts`; a change
 * here changes all three.
 */

/** The Labs switch. Off: no `/ws/browser`, no tool, no UI. */
export const BROWSER_BRIDGE_SETTING = 'browser_bridge_enabled';

/** The extension's one endpoint. */
export const BROWSER_WS_PATH = '/ws/browser';

/**
 * The extension's ID, fixed by the `key` in its manifest, so its origin —
 * the only one `/ws/browser` accepts — is the same on every install.
 */
export const BROWSER_EXTENSION_ID = 'iadgmbfioabehjefjeeikjcfdnnhfehb';
export const BROWSER_EXTENSION_ORIGIN = `chrome-extension://${BROWSER_EXTENSION_ID}`;

/** The hub topic every Orbital window subscribes to. */
export const BROWSER_TOPIC = 'browser';

/**
 * Why an event reached no session. `read-only`: the open session has no
 * composer (live in a terminal, or locked). `unreadable`: the server could not
 * read the screenshot or fit it under the attachment limit.
 */
export type BrowserDropReason =
  | 'no-session'
  | 'no-window'
  | 'foreign'
  | 'composer-full'
  | 'read-only'
  | 'unreadable';

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
  | { type: 'capture_failed'; requestId: string; reason: string };

// ── /ws/browser, server → extension ────────────────────────────────────────

export type ServerFrame =
  | { type: 'paired'; token: string }
  | { type: 'pair_failed'; reason: string }
  | { type: 'welcome' }
  | { type: 'pong' }
  | {
      type: 'outcome';
      eventId: string;
      delivered: boolean;
      /** The session's title when delivered. */
      sessionTitle?: string;
      reason?: BrowserDropReason;
    }
  /** The agent's `browser_screenshot`: capture the active tab. */
  | { type: 'capture'; requestId: string };

/** Close codes the extension acts on. */
export const BROWSER_CLOSE = {
  /** Token unknown or revoked: forget it and ask to pair again. */
  unauthorized: 4401,
  /** The Labs switch is off. */
  disabled: 4403,
} as const;

// ── hub topic `browser`, server → web ──────────────────────────────────────

export type BrowserHubEvent =
  | { type: 'browser_selection'; eventId: string; text: string; url: string; title: string; at: number }
  | {
      type: 'browser_screenshot';
      eventId: string;
      /** The id of the stored image, as `POST /api/attachments` returns it. */
      ref: string;
      url: string;
      title: string;
      at: number;
      /** The stored image's pixel size and byte length, for the chip's second line; absent when unread. */
      w?: number;
      h?: number;
      bytes?: number;
    }
  /**
   * What `GET /api/browser` would answer now, sent whenever it changes (a
   * pairing made or revoked, a pairing code made, cancelled or worn out by
   * wrong tries, an extension connecting or leaving, the switch moving), so
   * Settings follows it without asking again.
   */
  | { type: 'browser_status'; status: BrowserStatus };

// ── REST, web → server (API token) ─────────────────────────────────────────
//
// GET    /api/browser                → BrowserStatus
// POST   /api/browser/pairing-code   → { code: string; expiresAt: number }
// DELETE /api/browser/pairing-code   → 204
// DELETE /api/browser/pairings/:id   → 204
// POST   /api/browser/outcome        ← BrowserOutcome → 204

export interface BrowserPairing {
  id: string;
  /** What the extension called its browser: "Chrome", "Arc", … */
  browser: string;
  pairedAt: number;
  connected: boolean;
  /** When its extension was last connected, null if never since pairing was recorded. */
  lastSeenAt: number | null;
}

export interface BrowserStatus {
  enabled: boolean;
  /** The port Orbital listens on, which the extension's Advanced field takes. */
  port: number;
  pairings: BrowserPairing[];
  /**
   * When the open pairing code lapses, or null when none is open. A code
   * Settings shows whose `expiresAt` this is not has ended: spent, cancelled,
   * replaced, or worn out by wrong tries.
   */
  codeExpiresAt: number | null;
}

export interface BrowserOutcome {
  eventId: string;
  delivered: boolean;
  sessionId?: string;
  reason?: BrowserDropReason;
}
