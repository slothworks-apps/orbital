/**
 * The keys a focused terminal takes ahead of the menu (spec
 * 2026-10-05-embedded-terminal-design § Keys): ⌘T adds a tab, ⌘W closes the
 * active one and ⌘1–9 pick one — ahead of the window's ⌘W, ⌘T for tags and
 * ⌘1 for the map. A menu key equivalent fires before the page sees the key,
 * so main has to decide in `before-input-event`, while the renderer says
 * whether a terminal has focus.
 *
 * Nothing here may import electron (spec 2026-09-16-electron-wrapper-design
 * § 4 "Testing"); `KeyInput` is the subset of Electron's `Input` it reads.
 */

export interface KeyInput {
  type: string;
  key: string;
  code: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
  isAutoRepeat?: boolean;
}

/** The chord names the renderer understands (`web/src/terminal/keys.ts`). */
export type TerminalChord = 'new-tab' | 'close-tab' | `tab-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

/**
 * What main does with a key: let it go on to the menu and the page, swallow
 * it, or swallow it and hand the chord to the renderer.
 */
export type TerminalKeyDecision =
  | { action: 'pass' }
  | { action: 'swallow' }
  | { action: 'forward'; chord: TerminalChord };

const PASS: TerminalKeyDecision = { action: 'pass' };

/**
 * The chord a key is, read as the web app's keymap reads keys: letters by
 * character (⌘ does not change the letter on a Czech layout), digits by
 * position (there the 1 key prints `+`).
 */
function chordOf(input: KeyInput): TerminalChord | null {
  if (!input.meta || input.control || input.alt || input.shift) return null;
  const key = input.key.toLowerCase();
  if (key === 't') return 'new-tab';
  if (key === 'w') return 'close-tab';
  const digit = /^Digit([1-9])$/.exec(input.code);
  return digit ? (`tab-${digit[1]}` as TerminalChord) : null;
}

/**
 * The decision for one key in a window, given whether a terminal there has
 * focus. Without focus every key passes, so ⌘W closes the window as before.
 * A held chord's repeats are swallowed rather than passed: passing them would
 * let the menu have the second ⌘W and close the window under the terminal.
 */
export function terminalKeyDecision(input: KeyInput, terminalFocused: boolean): TerminalKeyDecision {
  if (!terminalFocused || input.type !== 'keyDown') return PASS;
  const chord = chordOf(input);
  if (!chord) return PASS;
  return input.isAutoRepeat ? { action: 'swallow' } : { action: 'forward', chord };
}

/**
 * `terminal-focus` as main reads it. Anything but a boolean is dropped: a
 * malformed message must not leave ⌘W taken from the window.
 */
export function parseTerminalFocused(payload: unknown): boolean | null {
  return typeof payload === 'boolean' ? payload : null;
}
