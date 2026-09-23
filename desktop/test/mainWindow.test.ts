import { describe, expect, it } from 'vitest';
import {
  decideWindowButtons,
  parseFullScreen,
  parseWindowButtonsVisible,
} from '../src/lib/mainWindow';

describe('parseWindowButtonsVisible', () => {
  it('reads a boolean as it is', () => {
    expect(parseWindowButtonsVisible(true)).toBe(true);
    expect(parseWindowButtonsVisible(false)).toBe(false);
  });

  it('drops anything that is not a boolean instead of coercing it', () => {
    for (const payload of ['true', 'false', 0, 1, null, undefined, {}, []]) {
      expect(parseWindowButtonsVisible(payload)).toBeNull();
    }
  });
});

describe('parseFullScreen', () => {
  it('is full screen only on a literal true', () => {
    expect(parseFullScreen(true)).toBe(true);
    for (const payload of [false, 'true', 1, null, undefined, {}]) {
      expect(parseFullScreen(payload)).toBe(false);
    }
  });
});

describe('decideWindowButtons', () => {
  it('applies the request in a windowed window', () => {
    expect(decideWindowButtons(true, false)).toBe(true);
    expect(decideWindowButtons(false, false)).toBe(false);
  });

  it('leaves the lights to macOS in full screen, whatever was asked', () => {
    expect(decideWindowButtons(true, true)).toBeNull();
    expect(decideWindowButtons(false, true)).toBeNull();
  });
});
