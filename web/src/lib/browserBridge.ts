import { MAX_ATTACHMENTS } from './attachments'
import { quoteSelection } from './ideSelection'

/**
 * The web's half of the browser bridge (spec 2026-11-05-browser-bridge-design):
 * the hub events and REST shapes, which window acts on an event, which session
 * it reaches, and the quoted block a browser selection rides in.
 *
 * Everything here is pure but `newWindowId`; the socket, the storage and the
 * composer intake are `useBrowserBridge`'s.
 */

// ── Mirror of server/src/browser/protocol.ts ──────────────────────────────
// The hub half and the REST half, restated because web/ does not import from
// server/. A change there changes this too (and the extension's mirror).

/** The Labs switch. */
export const BROWSER_BRIDGE_SETTING = 'browser_bridge_enabled'

/** The hub topic every Orbital window subscribes to. */
export const BROWSER_TOPIC = 'browser'

/** Why an event reached no session. */
export type BrowserDropReason = 'no-session' | 'no-window' | 'foreign' | 'composer-full'

export type BrowserHubEvent =
  | { type: 'browser_selection'; eventId: string; text: string; url: string; title: string; at: number }
  | {
      type: 'browser_screenshot'
      eventId: string
      /** The id of the stored image, as `POST /api/attachments` returns it. */
      ref: string
      url: string
      title: string
      at: number
      /** The stored image's pixel size and byte length, for the chip's second line; absent when unread. */
      w?: number
      h?: number
      bytes?: number
    }
  /**
   * What `GET /api/browser` would answer now, sent whenever it changes, so
   * Settings follows it without asking again.
   */
  | { type: 'browser_status'; status: BrowserStatus }

/** The two events that are something sent to a session. */
export type BrowserDelivery = Extract<BrowserHubEvent, { type: 'browser_selection' | 'browser_screenshot' }>

export interface BrowserPairing {
  id: string
  /** What the extension called its browser: "Chrome", "Arc", … */
  browser: string
  pairedAt: number
  connected: boolean
  /** When its extension was last connected, null if never since pairing was recorded. */
  lastSeenAt: number | null
}

export interface BrowserStatus {
  enabled: boolean
  /** The port Orbital listens on, which the extension's Advanced field takes. */
  port: number
  pairings: BrowserPairing[]
}

export interface BrowserOutcome {
  eventId: string
  delivered: boolean
  sessionId?: string
  reason?: BrowserDropReason
}

// ── The switch ─────────────────────────────────────────────────────────────

export function browserBridgeEnabled(settings: Record<string, string | undefined>): boolean {
  return settings[BROWSER_BRIDGE_SETTING] === 'true'
}

/**
 * Whether this build offers the bridge at all: the desktop app, and the
 * `npm run dev` web app so the extension can be worked on — never the Linux
 * server's web app, whose browser is usually on another machine (spec
 * § Installing it).
 */
export function browserBridgeOffered(opts: { desktop: boolean; dev: boolean }): boolean {
  return opts.desktop || opts.dev
}

/**
 * A pairing code as Settings shows it, 3 + 3 (canvas 64f, The code). The
 * server makes it from letters and digits that do not read alike and takes it
 * back in either case, with or without the space.
 */
export function pairingCodeHalves(code: string): [string, string] {
  const half = Math.ceil(code.length / 2)
  return [code.slice(0, half), code.slice(half)]
}

// ── Which window acts ──────────────────────────────────────────────────────

/**
 * The `localStorage` key every Orbital window of the origin writes when it
 * gains focus. While you are in the browser no Orbital window has focus, so
 * the one written last is the one you were in (spec § Which session gets an
 * event).
 */
export const LAST_FOCUSED_KEY = 'orbital.browserBridge.lastFocused'

export interface LastFocused {
  windowId: string
  at: number
}

export function parseLastFocused(raw: string | null): LastFocused | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<LastFocused>
    if (typeof value.windowId !== 'string' || !value.windowId || typeof value.at !== 'number') return null
    return { windowId: value.windowId, at: value.at }
  } catch {
    return null
  }
}

/**
 * Whether this window is the one that answers. Before any window has written
 * the key — or after the window that wrote it closed and cleared it — the
 * main window answers, so an event is never lost to a record nobody holds.
 */
export function isLastFocusedWindow(
  record: LastFocused | null,
  self: { windowId: string; isMainWindow: boolean },
): boolean {
  if (!record) return self.isMainWindow
  return record.windowId === self.windowId
}

// ── Which session it reaches ───────────────────────────────────────────────

export type DeliverTarget = { sessionId: string } | { drop: BrowserDropReason }

/**
 * Where one event goes, decided by the window that received it. Null: not
 * this window's to answer — another window acts, and this one stays silent.
 *
 * `attachmentCount` is the open composer's chips; it only matters to a
 * screenshot, which is one more chip.
 */
export function deliverTarget(input: {
  isLastFocusedWindow: boolean
  openSessionId: string | null
  sessionIsForeign: boolean
  kind: BrowserDelivery['type']
  attachmentCount: number
}): DeliverTarget | null {
  if (!input.isLastFocusedWindow) return null
  if (!input.openSessionId) return { drop: 'no-session' }
  // Nothing from the extension leaves this Mac.
  if (input.sessionIsForeign) return { drop: 'foreign' }
  if (input.kind === 'browser_screenshot' && input.attachmentCount >= MAX_ATTACHMENTS) {
    return { drop: 'composer-full' }
  }
  return { sessionId: input.openSessionId }
}

export function outcomeFor(eventId: string, target: DeliverTarget): BrowserOutcome {
  return 'sessionId' in target
    ? { eventId, delivered: true, sessionId: target.sessionId }
    : { eventId, delivered: false, reason: target.drop }
}

// ── The selection in the composer and on the wire ──────────────────────────

/** One session's browser selection, standing until × or a send. */
export interface BrowserSelection {
  eventId: string
  text: string
  url: string
  title: string
  at: number
}

/** The opening words of the block, and the anchor the reader matches on. */
const BLOCK_HEAD = 'Selected in the browser —'

/**
 * A page title as the head carries it: on one line, so the reader's head
 * ends where the line does. A page with no title is named by its URL.
 */
function headTitle(title: string, url: string): string {
  const flat = title.replace(/\s+/g, ' ').trim()
  return flat || url
}

/** A URL as the head carries it: no whitespace, so it reads as one token. */
function headUrl(url: string): string {
  return url.replace(/\s/g, '') || 'about:blank'
}

/**
 * The prompt with a browser selection riding: the block first, the typed
 * words after, by the rules of the editor's block (adr
 * an-ide-selection-rides-as-a-quoted-block) — the fence longer than any
 * backtick run inside, the same cap and truncation note.
 *
 * The wording is a parsing contract with `parseSentBrowserSelection` and with
 * `cleanTitle` in `server/src/transcript/parser.ts`.
 */
export function promptWithBrowserSelection(text: string, selection: Pick<BrowserSelection, 'text' | 'url' | 'title'>): string {
  const { quoted, fence } = quoteSelection(selection.text)
  const block = [
    `${BLOCK_HEAD} ${headTitle(selection.title, selection.url)} (${headUrl(selection.url)}):`,
    '',
    fence,
    quoted,
    fence,
  ].join('\n')
  return text ? `${block}\n\n${text}` : block
}

/** What a sent turn carried from the browser, read back out of its own text. */
export interface SentBrowserSelection {
  title: string
  url: string
  /** The quoted text's length, as the caption counts it. */
  chars: number
  /** What followed the block — the typed words. */
  text: string
}

// The title is greedy and the URL has no spaces, so a title that carries
// "(…)" of its own still ends at the last " (" on the line.
const BLOCK_RE = new RegExp(`^${BLOCK_HEAD} (.*) \\((\\S+)\\):\\n\\n(\`{3,})\\n`)

/**
 * The block back out of a sent turn, so the transcript can draw a caption for
 * it. Null for a turn that does not open with it. Applied to what is left
 * once the editor's block or sentence is taken off, since that one rides
 * first.
 */
export function parseSentBrowserSelection(text: string | undefined | null): SentBrowserSelection | null {
  if (!text || !text.startsWith(BLOCK_HEAD)) return null
  const head = BLOCK_RE.exec(text)
  if (!head) return null
  const [matched, title, url, fence] = head
  const close = text.indexOf(`\n${fence}`, matched.length)
  if (close === -1) return null
  const body = text.slice(matched.length, close)
  return {
    title,
    url,
    chars: body.length,
    text: text.slice(close + 1 + fence.length).replace(/^\n+/, ''),
  }
}

/** Only a web page's URL is offered as a link; anything else stays words. */
export function linkableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/** How much of the selected text the lip quotes (canvas 64b-3: "the quote is capped at 24 characters"). */
export const BROWSER_LIP_QUOTE_CHARS = 24

/**
 * The start of the selected text as the lip quotes it: on one line, in curly
 * quotes, cut at `BROWSER_LIP_QUOTE_CHARS` with an ellipsis inside the
 * closing quote. A short selection is quoted whole (64b-4).
 */
export function lipQuote(text: string, cap = BROWSER_LIP_QUOTE_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return `“${flat.length > cap ? `${flat.slice(0, cap).trimEnd()}…` : flat}”`
}

/** A page's host, as the lip, the chip and the tool row name it: `github.com`, `localhost:5173`. Empty when the URL has none. */
export function pageHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** A URL without its scheme, as the tool row prints its link (canvas 64d-4). */
export function bareUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '')
}

/** What a screenshot's chip is called: the page's title (canvas 64c-B), or its URL for a page with none. */
export function screenshotName(title: string, url: string): string {
  return headTitle(title, url)
}

/** A screenshot from the browser, as its chip and the sent prompt know it. */
export interface BrowserShot {
  title: string
  url: string
  /** When the extension took it, for the chip's hover. */
  at: number
}

const SHOT_HEAD = 'Screenshot of'
const SHOT_LINE_RE = /^Screenshot of (.*) — (\S+)$/

/**
 * The prompt with a line for each screenshot from the browser it carries,
 * naming the page the agent is looking at (canvas 64c-D: "Screenshot of
 * <title> — <URL>"). The lines go in front of the typed words, after any
 * selection block, and are read back by `parseSentBrowserScreenshots` and
 * stripped by `cleanTitle` in `server/src/transcript/parser.ts` — a parsing
 * contract like the selection's head.
 */
export function promptWithBrowserScreenshots(text: string, shots: readonly Pick<BrowserShot, 'title' | 'url'>[]): string {
  if (shots.length === 0) return text
  const lines = shots.map((shot) => `${SHOT_HEAD} ${headTitle(shot.title, shot.url)} — ${headUrl(shot.url)}`).join('\n')
  return text ? `${lines}\n\n${text}` : lines
}

/** The pages a sent turn's screenshots came from, and the typed words after their lines. */
export function parseSentBrowserScreenshots(text: string | undefined | null): { shots: { title: string; url: string }[]; text: string } | null {
  if (!text || !text.startsWith(SHOT_HEAD)) return null
  const lines = text.split('\n')
  const shots: { title: string; url: string }[] = []
  let i = 0
  for (; i < lines.length; i++) {
    const match = SHOT_LINE_RE.exec(lines[i])
    if (!match) break
    shots.push({ title: match[1], url: match[2] })
  }
  if (shots.length === 0) return null
  // What follows the lines is a blank line and the typed words, or nothing.
  const rest = lines.slice(i)
  if (rest.length > 0 && rest[0] !== '') return null
  return { shots, text: rest.join('\n').replace(/^\n+/, '') }
}

/** The page `browser_screenshot` captured, read out of its result's text line (`server/src/browser/tool.ts`). */
export function parseToolScreenshotPage(text: string | undefined | null): { title: string; url: string } | null {
  const match = /^The active tab: (.*) — (\(no URL\)|\S+)$/m.exec(text ?? '')
  if (!match) return null
  return { title: match[1] === '(untitled)' ? '' : match[1], url: match[2] === '(no URL)' ? '' : match[2] }
}

/** The tool's text when no browser could answer: the row says "no browser" (canvas 64d-3). */
export function isNoBrowserResult(text: string | undefined | null): boolean {
  return (text ?? '').startsWith('No browser is connected to Orbital.')
}

/** The agent's tool, as the transcript records its name. */
export const BROWSER_SCREENSHOT_TOOL_NAME = 'mcp__orbital__browser_screenshot'

/** A tool's name as a run of tool rows lists it: the browser tool in its row's words (canvas 64d-3), any other as recorded. */
export function runToolName(name: string): string {
  return name === BROWSER_SCREENSHOT_TOOL_NAME ? 'Browser: screenshot' : name
}

/** A fresh id for this window, written into `LAST_FOCUSED_KEY`. */
export function newWindowId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
