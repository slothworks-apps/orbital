import { describe, expect, it } from 'vitest';
import { parseTerminalFocused, terminalKeyDecision, type KeyInput } from '../src/lib/terminalKeys';

function key(overrides: Partial<KeyInput>): KeyInput {
  return { type: 'keyDown', key: '', code: '', meta: true, control: false, alt: false, shift: false, ...overrides };
}

describe('terminalKeyDecision', () => {
  it('takes ⌘T, ⌘W and ⌘1–9 from the menu while a terminal has focus', () => {
    expect(terminalKeyDecision(key({ key: 't', code: 'KeyT' }), true)).toEqual({ action: 'forward', chord: 'new-tab' });
    expect(terminalKeyDecision(key({ key: 'w', code: 'KeyW' }), true)).toEqual({ action: 'forward', chord: 'close-tab' });
    expect(terminalKeyDecision(key({ key: '9', code: 'Digit9' }), true)).toEqual({ action: 'forward', chord: 'tab-9' });
  });

  it('leaves every key to the menu while no terminal has focus', () => {
    expect(terminalKeyDecision(key({ key: 'w', code: 'KeyW' }), false)).toEqual({ action: 'pass' });
  });

  it('reads a Czech layout: the letter by character, the digit by position', () => {
    // The 1 key prints `+` without Shift.
    expect(terminalKeyDecision(key({ key: '+', code: 'Digit1' }), true)).toEqual({ action: 'forward', chord: 'tab-1' });
    // Caps Lock on: still T.
    expect(terminalKeyDecision(key({ key: 'T', code: 'KeyT' }), true)).toEqual({ action: 'forward', chord: 'new-tab' });
  });

  it('passes the chords with another modifier, and keys other than these', () => {
    for (const input of [
      key({ key: 'w', code: 'KeyW', shift: true }),
      key({ key: 't', code: 'KeyT', alt: true }),
      key({ key: 'w', code: 'KeyW', control: true }),
      key({ key: 'w', code: 'KeyW', meta: false }),
      key({ key: 'k', code: 'KeyK' }),
      key({ key: '0', code: 'Digit0' }),
      key({ key: 'c', code: 'KeyC' }),
    ]) {
      expect(terminalKeyDecision(input, true)).toEqual({ action: 'pass' });
    }
  });

  it('passes the key going up', () => {
    expect(terminalKeyDecision(key({ type: 'keyUp', key: 'w', code: 'KeyW' }), true)).toEqual({ action: 'pass' });
  });

  it('swallows a held chord after its first press, so a held ⌘W never reaches the window', () => {
    expect(terminalKeyDecision(key({ key: 'w', code: 'KeyW', isAutoRepeat: true }), true)).toEqual({ action: 'swallow' });
  });
});

describe('parseTerminalFocused', () => {
  it('takes only a boolean', () => {
    expect(parseTerminalFocused(true)).toBe(true);
    expect(parseTerminalFocused(false)).toBe(false);
    expect(parseTerminalFocused('true')).toBeNull();
    expect(parseTerminalFocused(1)).toBeNull();
  });
});
