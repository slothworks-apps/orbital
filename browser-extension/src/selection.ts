/**
 * When a selection in a page counts as an event: its end, guessed from the
 * mouse or key going up after the selection changed, debounced so a
 * shift+arrow run or a double-click-and-drag sends one event, not many.
 */

/** How long the selection must stay put after the mouse or key goes up. */
export const SELECTION_DEBOUNCE_MS = 350

/**
 * A cap on what one event carries, so a select-all on a huge page does not
 * push megabytes through the socket. The composer has its own, smaller cap.
 */
export const MAX_SELECTION_CHARS = 100_000

/** Orbital's default port, as the server's `DEFAULT_PORT`. */
export const DEFAULT_ORBITAL_PORT = 4737

/** The ports `npm run dev` serves Orbital on: its server and its web app. */
export const DEV_ORBITAL_PORTS = [4838, 4839] as const

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Trimmed and capped; empty when there is nothing worth sending. */
export function normalizeSelection(raw: string): string {
  const text = raw.trim()
  return text.length > MAX_SELECTION_CHARS ? text.slice(0, MAX_SELECTION_CHARS) : text
}

/**
 * Whether a page is Orbital itself, where a selection is the user working
 * in Orbital and must not echo back into its own composer.
 */
export function isOrbitalPage(
  location: { protocol: string; hostname: string; port: string },
  orbitalPort: number,
): boolean {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return false
  if (!LOOPBACK_HOSTS.has(location.hostname)) return false
  const port = Number(location.port)
  if (!location.port || !Number.isInteger(port)) return false
  return (
    port === orbitalPort ||
    port === DEFAULT_ORBITAL_PORT ||
    (DEV_ORBITAL_PORTS as readonly number[]).includes(port)
  )
}

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface SelectionEndOptions {
  /** The page's current selection, as text. */
  read(): string
  send(text: string): void
  debounceMs?: number
  timers?: Timers
}

export interface SelectionEndDetector {
  /** `selectionchange` (or `select` in an input). */
  onSelectionChange: () => void
  /** A press that may start a new drag: whatever was pending is not an end. */
  onPointerDown: () => void
  onPointerUp: () => void
  onKeyUp: () => void
  dispose: () => void
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Sends a selection once it has ended, when it is not empty and not the one
 * this page sent last. A selection found empty (the user clicked it away)
 * forgets the last one, so selecting the same text again sends it again.
 */
export function createSelectionEndDetector(options: SelectionEndOptions): SelectionEndDetector {
  const debounceMs = options.debounceMs ?? SELECTION_DEBOUNCE_MS
  const timers = options.timers ?? realTimers
  let changed = false
  let pending: unknown = null
  let lastSent: string | null = null

  const cancel = () => {
    if (pending !== null) timers.clear(pending)
    pending = null
  }

  const settle = () => {
    pending = null
    changed = false
    const text = normalizeSelection(options.read())
    if (!text) {
      lastSent = null
      return
    }
    if (text === lastSent) return
    lastSent = text
    options.send(text)
  }

  const release = () => {
    if (!changed) return
    cancel()
    pending = timers.set(settle, debounceMs)
  }

  return {
    onSelectionChange: () => {
      changed = true
    },
    onPointerDown: cancel,
    onPointerUp: release,
    onKeyUp: release,
    dispose: cancel,
  }
}
