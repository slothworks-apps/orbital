import { describe, expect, it } from 'vitest';
import {
  decideDetach,
  decideNotificationClick,
  growForSubagent,
  isSessionId,
  parseDetachedIds,
  parseSubagentPanelMessage,
  sessionWindowUrl,
  shrinkAfterSubagent,
  toCssPx,
  toDip,
} from '../src/lib/sessionWindows';

describe('toCssPx / toDip', () => {
  it('converts between window units and page pixels by the zoom factor', () => {
    // Under View → Zoom In a window 900 wide measures fewer CSS px inside.
    expect(toCssPx(900, 1.25)).toBe(720);
    expect(toDip(720, 1.25)).toBe(900);
    // Chromium truncates innerWidth, so a fractional result rounds down.
    expect(toCssPx(901, 1.25)).toBe(720);
    expect(toCssPx(900, 1)).toBe(900);
  });

  it('treats a zoom factor that is not a positive finite number as none', () => {
    expect(toCssPx(900, 0)).toBe(900);
    expect(toCssPx(900, Number.NaN)).toBe(900);
    expect(toDip(900, -1)).toBe(900);
  });
});

describe('parseSubagentPanelMessage', () => {
  it('reads an open with both widths, and a close', () => {
    expect(parseSubagentPanelMessage({ open: true, widthPx: 380, pairMinPx: 680 })).toEqual({
      open: true,
      widthPx: 380,
      pairMinPx: 680,
    });
    expect(parseSubagentPanelMessage({ open: false, widthPx: 'x' })).toEqual({ open: false });
  });

  it('drops an open whose widths are not positive finite numbers', () => {
    for (const widthPx of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '380', undefined]) {
      expect(parseSubagentPanelMessage({ open: true, widthPx, pairMinPx: 680 })).toBeNull();
      expect(parseSubagentPanelMessage({ open: true, widthPx: 380, pairMinPx: widthPx })).toBeNull();
    }
  });

  it('drops anything that does not say open or closed', () => {
    for (const payload of [undefined, null, 'open', {}, { open: 1, widthPx: 380, pairMinPx: 680 }]) {
      expect(parseSubagentPanelMessage(payload)).toBeNull();
    }
  });
});

describe('growForSubagent', () => {
  const workArea = { x: 0, y: 25, width: 1512, height: 920 };

  it('widens to the right by the panel width', () => {
    const before = { x: 100, y: 60, width: 450, height: 820 };
    expect(growForSubagent(before, workArea, 380, 680)).toEqual({
      before,
      after: { x: 100, y: 60, width: 830, height: 820 },
    });
  });

  it('shifts left to stay inside the work area at its right edge', () => {
    const before = { x: 1000, y: 60, width: 450, height: 820 };
    expect(growForSubagent(before, workArea, 380, 680)?.after).toEqual({
      x: 1512 - 830,
      y: 60,
      width: 830,
      height: 820,
    });
  });

  it('respects a work area that does not start at zero (a second display)', () => {
    const second = { x: 1512, y: 0, width: 1000, height: 900 };
    const before = { x: 2300, y: 60, width: 450, height: 820 };
    expect(growForSubagent(before, second, 380, 680)?.after).toMatchObject({ x: 2512 - 830, width: 830 });
  });

  it('clamps to the work area when the grown window would be wider than it', () => {
    const narrow = { x: 0, y: 25, width: 700, height: 900 };
    const before = { x: 200, y: 60, width: 450, height: 820 };
    expect(growForSubagent(before, narrow, 380, 680)?.after).toMatchObject({ x: 0, width: 700 });
  });

  it('keeps an x that is already off to the left when no shift is needed', () => {
    const before = { x: -50, y: 60, width: 450, height: 820 };
    expect(growForSubagent(before, workArea, 380, 680)?.after).toMatchObject({ x: -50, width: 830 });
  });

  it('leaves a window alone that already holds both panels at their minimums', () => {
    expect(growForSubagent({ x: 0, y: 0, width: 680, height: 820 }, workArea, 380, 680)).toBeNull();
    expect(growForSubagent({ x: 0, y: 0, width: 1200, height: 820 }, workArea, 380, 680)).toBeNull();
  });

  it('leaves a window alone that already spans the whole work area', () => {
    const narrow = { x: 0, y: 25, width: 450, height: 900 };
    expect(growForSubagent({ x: 0, y: 60, width: 450, height: 820 }, narrow, 380, 680)).toBeNull();
  });
});

describe('shrinkAfterSubagent', () => {
  it('narrows back by exactly what the grow added', () => {
    const growth = {
      before: { x: 100, y: 60, width: 450, height: 820 },
      after: { x: 100, y: 60, width: 830, height: 820 },
    };
    expect(shrinkAfterSubagent(growth.after, growth, 450)).toEqual(growth.before);
  });

  it('undoes a shift, relative to where the window sits now', () => {
    const growth = {
      before: { x: 1000, y: 60, width: 450, height: 820 },
      after: { x: 682, y: 60, width: 830, height: 820 },
    };
    expect(shrinkAfterSubagent(growth.after, growth, 450)).toEqual(growth.before);
    // Moved 200 left and resized in height while the agent was open.
    expect(shrinkAfterSubagent({ x: 482, y: 90, width: 830, height: 700 }, growth, 450)).toEqual({
      x: 800,
      y: 90,
      width: 450,
      height: 700,
    });
  });

  it('leaves a window alone that was resized by hand while the agent was open', () => {
    const growth = {
      before: { x: 100, y: 60, width: 450, height: 820 },
      after: { x: 100, y: 60, width: 830, height: 820 },
    };
    expect(shrinkAfterSubagent({ x: 100, y: 60, width: 900, height: 820 }, growth, 450)).toBeNull();
  });

  it('never goes below the minimum width', () => {
    const growth = {
      before: { x: 100, y: 60, width: 300, height: 820 },
      after: { x: 100, y: 60, width: 680, height: 820 },
    };
    expect(shrinkAfterSubagent(growth.after, growth, 450)?.width).toBe(450);
  });
});

describe('isSessionId', () => {
  it('accepts a non-empty string', () => {
    expect(isSessionId('abc-123')).toBe(true);
  });

  it('rejects the empty string and anything that is not a string', () => {
    for (const value of ['', undefined, null, 42, {}, ['abc']]) {
      expect(isSessionId(value)).toBe(false);
    }
  });
});

describe('parseDetachedIds', () => {
  it('keeps the string ids of an array', () => {
    expect(parseDetachedIds(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('drops entries that are not ids', () => {
    expect(parseDetachedIds(['a', 1, '', null, { id: 'x' }, 'b'])).toEqual(['a', 'b']);
  });

  it('reads anything that is not an array as no detached sessions', () => {
    for (const payload of [undefined, null, 'a', { 0: 'a', length: 1 }]) {
      expect(parseDetachedIds(payload)).toEqual([]);
    }
  });
});

describe('sessionWindowUrl', () => {
  it('puts the route on the origin the main window was sent to', () => {
    expect(sessionWindowUrl('http://127.0.0.1:4737', 'abc')).toBe('http://127.0.0.1:4737/session/abc');
    expect(sessionWindowUrl('http://localhost:5173', 'abc')).toBe('http://localhost:5173/session/abc');
  });

  it("drops the main window's own path, query and hash", () => {
    expect(sessionWindowUrl('http://127.0.0.1:4737/stats?session=x#y', 'abc')).toBe(
      'http://127.0.0.1:4737/session/abc',
    );
  });

  it('keeps an id with separators inside its one path segment', () => {
    const url = new URL(sessionWindowUrl('http://127.0.0.1:4737/', 'a/../b?c#d'));
    expect(url.pathname).toBe('/session/a%2F..%2Fb%3Fc%23d');
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
  });
});

describe('decideDetach', () => {
  it('opens a window for a session that has none', () => {
    expect(decideDetach('a', new Set(['b']))).toBe('open');
  });

  it('focuses the window a session already has', () => {
    expect(decideDetach('a', new Set(['a']))).toBe('focus');
  });
});

describe('decideNotificationClick', () => {
  it("sends a detached session's notification to its own window", () => {
    expect(decideNotificationClick('a', new Set(['a']))).toEqual({
      kind: 'session-window',
      sessionId: 'a',
    });
  });

  it('shows the map and selects a session that is not detached', () => {
    expect(decideNotificationClick('a', new Set(['b']))).toEqual({ kind: 'main', select: 'a' });
  });

  it('shows the map and selects nothing when the notification names no session', () => {
    expect(decideNotificationClick(null, new Set(['a']))).toEqual({ kind: 'main', select: null });
  });
});
