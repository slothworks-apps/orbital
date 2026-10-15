import type { ITheme } from '@xterm/xterm'

/**
 * The terminal's look (canvas `Feature - Terminal` 48f): an opaque body, the
 * file viewer's syntax hues as the 16 ANSI colours, the brand accent as the
 * cursor. Every map theme gets the same terminal.
 *
 * xterm takes hex or rgb, not oklch, so the canvas's oklch values are
 * precomputed to sRGB here, each with its source beside it (web/CLAUDE.md →
 * Design values come from the canvas). The hex ones are the canvas's own.
 */
export const TERMINAL_BG = '#070a12'

export const TERMINAL_THEME: ITheme = {
  background: TERMINAL_BG,
  foreground: '#d3deef',
  // The brand accent; the text under a block cursor takes the body's ink.
  cursor: '#59e4f3', // oklch(85% .12 205)
  cursorAccent: TERMINAL_BG,
  // Keeps the ANSI ink under it rather than inverting it.
  selectionBackground: 'rgba(150,205,255,.26)',
  black: '#222b3d',
  red: '#ed8c84', // oklch(74% .12 25)
  green: '#7ccd8e', // oklch(78% .12 150)
  yellow: '#e5bf6d', // oklch(82% .11 85)
  blue: '#73b0ee', // oklch(74% .11 250)
  magenta: '#d09add', // oklch(76% .11 320)
  cyan: '#65d0dc', // oklch(80% .1 205)
  white: '#b4c2d6',
  brightBlack: '#74839c',
  brightRed: '#ffa8a0', // oklch(82% .11 25)
  brightGreen: '#9fe9ae', // oklch(87% .11 150)
  brightYellow: '#f9d68c', // oklch(89% .1 85)
  brightBlue: '#95cdff', // oklch(83% .1 250)
  brightMagenta: '#ebb9f7', // oklch(85% .1 320)
  brightCyan: '#9aebf4', // oklch(89% .08 205)
  brightWhite: '#f2f6fc',
}

/** 48f: the file viewer's glyph size, on a shorter line so 24 rows fit in 480 px. */
export const TERMINAL_FONT_PX = 12.5
export const TERMINAL_ROW_PX = 20
export const TERMINAL_FONT_FAMILY = "'JetBrains Mono', ui-monospace, monospace"
/** 48f: lines kept per tab. */
export const TERMINAL_SCROLLBACK = 10_000
