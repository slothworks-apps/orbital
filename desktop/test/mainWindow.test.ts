import { describe, expect, it } from 'vitest';
import {
  decideWindowButtons,
  mainWindowUrl,
  parseFullScreen,
  parseMainWindowPath,
  parseWindowButtonsVisible,
} from '../src/lib/mainWindow';

describe('parseMainWindowPath', () => {
  it('lets a walkthrough path through as it is, encoded id included', () => {
    expect(parseMainWindowPath('/walkthrough/abc-123')).toBe('/walkthrough/abc-123');
    const encoded = `/walkthrough/${encodeURIComponent('a b/c?d#e')}`;
    expect(parseMainWindowPath(encoded)).toBe(encoded);
  });

  it('drops every other in-app path', () => {
    for (const payload of ['/', '/stats', '/session/abc', '/walkthrough', '/walkthrough/', '/walkthroughs/abc']) {
      expect(parseMainWindowPath(payload)).toBeNull();
    }
  });

  it('drops anything that could leave the origin or the route', () => {
    for (const payload of [
      '',
      '//evil.com',
      '//evil.com/walkthrough/abc',
      'https://evil.com/walkthrough/abc',
      'walkthrough/abc',
      '/walkthrough/abc/../../stats',
      '/walkthrough/..',
      '/walkthrough/.',
      '/walkthrough/%2e%2e',
      '/walkthrough/%2E',
      '/walkthrough/abc/',
      '/walkthrough/abc?x=1',
      '/walkthrough/abc#x',
      '/walkthrough/a\\b',
      '/walkthrough/%E0%A4%A',
      '/walkthrough/%ZZ',
    ]) {
      expect(parseMainWindowPath(payload)).toBeNull();
    }
  });

  it('drops anything that is not a string', () => {
    for (const payload of [null, undefined, 1, {}, ['/walkthrough/abc']]) {
      expect(parseMainWindowPath(payload)).toBeNull();
    }
  });
});

describe('mainWindowUrl', () => {
  it('puts the path on the origin startup chose, dropping its path and query', () => {
    expect(mainWindowUrl('http://127.0.0.1:5173/?session=x', '/walkthrough/abc')).toBe(
      'http://127.0.0.1:5173/walkthrough/abc',
    );
  });
});

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
