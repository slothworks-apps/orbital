import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
// 48f sets bold at 600; the app itself loads only 400 of the mono face.
import '@fontsource/jetbrains-mono/latin-600.css'
import { resolveWsUrl } from '../lib/ws'
import { hasDesktopBridge, setTerminalFocused } from '../lib/desktop'
import { matches } from '../lib/keymap'
import type { TerminalCursor } from '../lib/experimental'
import { runTerminalChord } from './actions'
import { terminalChordOf } from './keys'
import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_PX,
  TERMINAL_ROW_PX,
  TERMINAL_SCROLLBACK,
  TERMINAL_THEME,
} from './palette'
import { findTab, useTerminals } from './store'
import { TERMINAL_GONE_CLOSE_CODE, parseTerminalControl } from './types'

/** The cursor the user picked in Settings → Experimental. */
export interface TerminalLook {
  cursor: TerminalCursor
  blink: boolean
}

/** How long a dropped socket waits before it tries again. */
const RECONNECT_MS = 2_000
/** 48f: a blinking cursor stops after this long with no input. */
const BLINK_IDLE_MS = 10_000
/** A hair over the exact ratio, so xterm's floor of the row height lands on `TERMINAL_ROW_PX`. */
const LINE_HEIGHT_EPSILON = 0.001

/**
 * The `lineHeight` multiplier that gives `TERMINAL_ROW_PX` rows (48f). xterm
 * multiplies the font's cell height by it, measuring the cell the way it does
 * itself — the font's bounding box, rounded up — and floors the product in
 * device pixels.
 */
function lineHeightFor(): number {
  const dpr = window.devicePixelRatio || 1
  let cssHeight = Math.ceil(TERMINAL_FONT_PX * 1.32)
  try {
    const ctx = document.createElement('canvas').getContext('2d')
    if (ctx) {
      ctx.font = `${TERMINAL_FONT_PX}px ${TERMINAL_FONT_FAMILY}`
      const m = ctx.measureText('W')
      const box = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent
      if (box > 0) cssHeight = Math.ceil(box)
    }
  } catch {
    // jsdom has no canvas; the estimate above stands.
  }
  const deviceHeight = Math.ceil(cssHeight * dpr)
  return Math.max(1, (TERMINAL_ROW_PX * dpr) / deviceHeight + LINE_HEIGHT_EPSILON)
}

/** Both weights the terminal draws, loaded before it first measures its cell. */
function fontsReady(): Promise<unknown> {
  if (typeof document === 'undefined' || !document.fonts) return Promise.resolve()
  return Promise.all([
    document.fonts.load(`${TERMINAL_FONT_PX}px 'JetBrains Mono'`),
    document.fonts.load(`600 ${TERMINAL_FONT_PX}px 'JetBrains Mono'`),
  ]).catch(() => undefined)
}

/**
 * One tab's live terminal: the xterm instance, the element it draws into and
 * its socket. It outlives the view that shows it — switching tabs, hiding the
 * terminal and the side slot changing hands only move `host` in and out of
 * the page, so the scrollback and the cursor stay as they were. It ends when
 * its session stops being the selected one; coming back, the server's replay
 * restores the scrollback (spec § Scrollback).
 */
class TerminalRuntime {
  readonly host: HTMLDivElement
  private readonly term: Terminal
  private readonly fit: FitAddon
  private ws: WebSocket | null = null
  private opened = false
  private opening: Promise<void> | null = null
  private disposed = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private blinkTimer: ReturnType<typeof setTimeout> | null = null
  private look: TerminalLook
  /** The size last told to the server, so a fit that changes nothing sends nothing. */
  private sent: { cols: number; rows: number } | null = null
  /** A reconnect replays the whole scrollback, so what is on screen goes first. */
  private resetOnOpen = false

  readonly id: string

  constructor(id: string, look: TerminalLook) {
    this.id = id
    this.look = look
    this.host = document.createElement('div')
    this.host.className = 'h-full w-full'
    // The escape layer leaves Escape to whatever is inside (`ui/escapeLayer`).
    this.host.dataset.keepsEscape = ''
    this.term = new Terminal({
      theme: TERMINAL_THEME,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: TERMINAL_FONT_PX,
      fontWeight: 400,
      fontWeightBold: 600,
      // 48f: bold keeps its colour rather than jumping to the bright one.
      drawBoldTextInBrightColors: false,
      lineHeight: lineHeightFor(),
      scrollback: TERMINAL_SCROLLBACK,
      cursorStyle: look.cursor,
      cursorBlink: look.blink,
      cursorInactiveStyle: 'outline',
      macOptionIsMeta: false,
      allowProposedApi: false,
    })
    this.fit = new FitAddon()
    this.term.loadAddon(this.fit)
    // A URL in the output opens in the user's browser, the way a link in the
    // transcript does: main routes a `window.open` there (`confineToOrbital`).
    this.term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        window.open(uri, '_blank', 'noopener')
      }),
    )
    this.term.attachCustomKeyEventHandler((e) => this.keepsKey(e))
    this.term.onData((data) => this.input(data))
    this.term.onBinary((data) => this.input(data))
    this.term.onResize(({ cols, rows }) => this.reportSize(cols, rows))
    this.host.addEventListener('focusin', () => {
      useTerminals.getState().setFocused(true)
      setTerminalFocused(true)
      this.wakeBlink()
    })
    this.host.addEventListener('focusout', () => {
      useTerminals.getState().setFocused(false)
      setTerminalFocused(false)
    })
    this.connect()
  }

  /**
   * Which keys xterm may have (false hands one back to the page). A focused
   * terminal takes every key, Ctrl-C and Esc included, except ⌃` — the
   * terminal's own toggle — and the window's ⌘ shortcuts (spec § Web).
   */
  private keepsKey(e: KeyboardEvent): boolean {
    if (matches('ctrl+Backquote', e)) return false
    if (!e.metaKey) return true
    // In the desktop app main has already taken ⌘T, ⌘W and ⌘1–9 ahead of
    // the menu; a browser hands them to the page, if at all.
    if (e.type === 'keydown' && !hasDesktopBridge()) {
      const chord = terminalChordOf(e)
      if (chord) {
        e.preventDefault()
        runTerminalChord(chord)
      }
    }
    return false
  }

  private exited(): boolean {
    const found = findTab(useTerminals.getState(), this.id)
    return found !== null && found.tab.exitCode !== null
  }

  private input(data: string): void {
    this.wakeBlink()
    // 48d: ⏎ in an exited tab starts a new shell there; nothing else reaches it.
    if (this.exited()) {
      if (data === '\r') void useTerminals.getState().restart(this.id)
      return
    }
    this.send({ type: 'input', data })
  }

  private send(message: { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number }): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message))
  }

  private reportSize(cols: number, rows: number): void {
    useTerminals.getState().setSize(this.id, cols, rows)
    if (this.sent?.cols === cols && this.sent.rows === rows) return
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.sent = { cols, rows }
    this.send({ type: 'resize', cols, rows })
  }

  private connect(): void {
    if (this.disposed) return
    const ws = new WebSocket(resolveWsUrl(`/ws/terminal/${encodeURIComponent(this.id)}`, window.location))
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => {
      if (this.resetOnOpen) this.term.reset()
      this.resetOnOpen = false
      this.sent = null
      // The shell takes the view's size, once the view has one.
      if (this.opened) this.reportSize(this.term.cols, this.term.rows)
    }
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        const control = parseTerminalControl(event.data)
        if (control) useTerminals.getState().applyControl(this.id, control)
        return
      }
      this.term.write(new Uint8Array(event.data as ArrayBuffer))
    }
    ws.onclose = (event) => {
      if (this.ws !== ws || this.disposed) return
      this.ws = null
      if (event.code === TERMINAL_GONE_CLOSE_CODE) {
        // The server no longer has it — Orbital restarted, or the session
        // ended. The tab goes with it.
        useTerminals.getState().forget(this.id)
        return
      }
      this.resetOnOpen = true
      this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_MS)
    }
  }

  /** Puts the terminal into `container`, opening it there the first time. */
  attach(container: HTMLElement): void {
    if (this.disposed) return
    container.appendChild(this.host)
    if (this.opened) {
      this.refit()
      return
    }
    this.opening ??= fontsReady().then(() => {
      if (this.disposed || this.opened || !this.host.isConnected) {
        this.opening = null
        return
      }
      this.term.open(this.host)
      this.opened = true
      this.opening = null
      this.refit()
      this.reportSize(this.term.cols, this.term.rows)
    })
  }

  /** Takes the terminal off the page; it keeps running and keeps its buffer. */
  detach(): void {
    // A focused element taken out of the page does not reliably report it.
    if (this.host.contains(document.activeElement)) {
      useTerminals.getState().setFocused(false)
      setTerminalFocused(false)
    }
    this.host.remove()
  }

  /** Fits the grid to the element it is in, which reports the new size. */
  refit(): void {
    if (!this.opened || !this.host.isConnected) return
    const { width, height } = this.host.getBoundingClientRect()
    if (width === 0 || height === 0) return
    try {
      this.fit.fit()
    } catch {
      // A renderer that has not measured its cell yet: the next resize fits it.
    }
  }

  focus(): void {
    if (this.opened) this.term.focus()
    else void this.opening?.then(() => this.term.focus())
  }

  setLook(look: TerminalLook): void {
    if (look.cursor === this.look.cursor && look.blink === this.look.blink) return
    this.look = look
    this.term.options.cursorStyle = look.cursor
    this.term.options.cursorBlink = look.blink
    if (look.blink) this.wakeBlink()
  }

  /**
   * 48f: a blinking cursor stops after `BLINK_IDLE_MS` without input, and
   * starts again with the next key or focus.
   */
  private wakeBlink(): void {
    if (!this.look.blink) return
    if (this.blinkTimer) clearTimeout(this.blinkTimer)
    this.term.options.cursorBlink = true
    this.blinkTimer = setTimeout(() => {
      this.term.options.cursorBlink = false
    }, BLINK_IDLE_MS)
  }

  dispose(): void {
    this.disposed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.blinkTimer) clearTimeout(this.blinkTimer)
    const ws = this.ws
    this.ws = null
    ws?.close()
    this.detach()
    this.term.dispose()
  }
}

const runtimes = new Map<string, TerminalRuntime>()

/** The tab's runtime, started on first ask. */
export function runtimeFor(id: string, look: TerminalLook): TerminalRuntime {
  let runtime = runtimes.get(id)
  if (!runtime) {
    runtime = new TerminalRuntime(id, look)
    runtimes.set(id, runtime)
  }
  return runtime
}

/**
 * Keeps a runtime for exactly the tabs in `ids` — the selected session's —
 * starting the missing ones and ending the rest. Ending one closes only its
 * socket; the shell runs on in the server.
 */
export function syncRuntimes(ids: readonly string[], look: TerminalLook): void {
  const keep = new Set(ids)
  for (const [id, runtime] of runtimes) {
    if (!keep.has(id)) {
      runtime.dispose()
      runtimes.delete(id)
    }
  }
  for (const id of ids) runtimeFor(id, look).setLook(look)
}
