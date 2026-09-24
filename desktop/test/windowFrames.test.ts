import { describe, expect, it } from 'vitest';
import {
  cascadeFrom,
  fitToDisplays,
  parseWindowFrames,
  pathOnOrigin,
  restorablePath,
  serializeWindowFrames,
  sessionFrameToRemember,
  withMainFrame,
  withSessionFrame,
  type WindowFrames,
} from '../src/lib/windowFrames';

const frame = { x: 100, y: 80, width: 1200, height: 800 };
const primary = { x: 0, y: 25, width: 1728, height: 1080 };
const external = { x: 1728, y: -200, width: 2560, height: 1415 };

describe('parseWindowFrames', () => {
  it('reads back what serializeWindowFrames wrote', () => {
    const frames: WindowFrames = {
      main: { bounds: frame, path: '/?session=abc' },
      session: { x: 10, y: 20, width: 450, height: 820 },
    };
    expect(parseWindowFrames(serializeWindowFrames(frames))).toEqual(frames);
  });

  it('treats a missing, unreadable or foreign file as no file', () => {
    for (const text of [null, '', 'not json', '[]', 'null', '42', '{"main":{"bounds":{"x":0,"y":0,"width":1,"height":1}}}']) {
      expect(parseWindowFrames(text)).toEqual({});
    }
    expect(parseWindowFrames(JSON.stringify({ version: 2, session: frame }))).toEqual({});
  });

  it('drops each broken part on its own', () => {
    const text = JSON.stringify({
      version: 1,
      main: { bounds: frame, path: '//evil.com/x' },
      session: { x: 0, y: 0, width: 0, height: 820 },
    });
    expect(parseWindowFrames(text)).toEqual({ main: { bounds: frame } });
  });

  it('drops a frame that is not whole numbers with a positive size', () => {
    for (const bounds of [
      { ...frame, x: '100' },
      { ...frame, width: -1 },
      { ...frame, height: 1.5 },
      { ...frame, y: null },
      { x: 0, y: 0, width: 100 },
    ]) {
      expect(parseWindowFrames(JSON.stringify({ version: 1, session: bounds }))).toEqual({});
    }
  });

  it('drops the path with the frame when the main frame is broken', () => {
    const text = JSON.stringify({ version: 1, main: { bounds: 'x', path: '/stats' } });
    expect(parseWindowFrames(text)).toEqual({});
  });
});

describe('restorablePath', () => {
  it('keeps in-app pages with their query and hash', () => {
    for (const path of ['/', '/stats', '/stats/abc', '/?session=abc&file=src%2Fa.ts&line=3', '/walkthrough/w1#step-2']) {
      expect(restorablePath(path)).toBe(path);
    }
  });

  it('drops anything that leaves the origin', () => {
    for (const path of ['', 'stats', '//evil.com', '//evil.com/stats', 'https://evil.com/', '/\\evil.com', 42, null]) {
      expect(restorablePath(path)).toBeNull();
    }
  });

  it('drops the detached window route, however it is spelled', () => {
    for (const path of ['/session/abc', '/session/', '/stats/../session/abc', '/./session/abc']) {
      expect(restorablePath(path)).toBeNull();
    }
  });

  it('normalises dot segments rather than keeping them', () => {
    expect(restorablePath('/walkthrough/../stats')).toBe('/stats');
  });
});

describe('pathOnOrigin', () => {
  it('reads the path of a page on the chosen origin', () => {
    expect(pathOnOrigin('http://127.0.0.1:4737/stats?range=7d', 'http://127.0.0.1:4737')).toBe('/stats?range=7d');
  });

  it('knows nothing of a page on another origin', () => {
    expect(pathOnOrigin('http://localhost:5173/stats', 'http://127.0.0.1:4737')).toBeNull();
    expect(pathOnOrigin('chrome-error://chromewebdata/', 'http://127.0.0.1:4737')).toBeNull();
    expect(pathOnOrigin('', 'http://127.0.0.1:4737')).toBeNull();
  });
});

describe('withMainFrame / withSessionFrame', () => {
  it('reports nothing to write when nothing changed', () => {
    const frames: WindowFrames = { main: { bounds: frame, path: '/stats' }, session: frame };
    expect(withMainFrame(frames, { ...frame }, '/stats')).toBeNull();
    expect(withMainFrame(frames, { ...frame }, null)).toBeNull();
    expect(withSessionFrame(frames, { ...frame })).toBeNull();
  });

  it('keeps the remembered path when the current one cannot be read', () => {
    const frames: WindowFrames = { main: { bounds: frame, path: '/stats' } };
    const moved = { ...frame, x: 0 };
    expect(withMainFrame(frames, moved, null)).toEqual({ main: { bounds: moved, path: '/stats' } });
  });

  it('touches only its own part', () => {
    const session = { x: 5, y: 5, width: 450, height: 820 };
    const frames: WindowFrames = { main: { bounds: frame }, session };
    expect(withMainFrame(frames, frame, '/')).toEqual({ main: { bounds: frame, path: '/' }, session });
    const moved = { ...session, x: 50 };
    expect(withSessionFrame(frames, moved)).toEqual({ main: { bounds: frame }, session: moved });
  });
});

describe('sessionFrameToRemember', () => {
  const opened = { x: 222, y: 122, width: 450, height: 820 };
  const minWidth = 450;
  // What the subagent panel's grow did to a window at the right edge: wider,
  // and shifted left to stay on screen.
  const growth = { before: opened, after: { ...opened, x: 100, width: 900 } };

  it("undoes the subagent panel's grow before remembering", () => {
    const moved = { ...opened, x: 300, y: 200 };
    const grown = { ...moved, x: moved.x - (opened.x - growth.after.x), width: growth.after.width };
    expect(sessionFrameToRemember(grown, opened, growth, minWidth)).toEqual(moved);
  });

  it('remembers nothing for a window left where it opened', () => {
    expect(sessionFrameToRemember({ ...opened }, opened, undefined, minWidth)).toBeNull();
    expect(sessionFrameToRemember(growth.after, opened, growth, minWidth)).toBeNull();
  });

  it('remembers a frame the user chose', () => {
    const resized = { ...opened, width: 600 };
    expect(sessionFrameToRemember(resized, opened, undefined, minWidth)).toEqual(resized);
    // Resized by hand while grown: the user's size wins, as on the shrink.
    const handSized = { ...growth.after, width: 1000 };
    expect(sessionFrameToRemember(handSized, opened, growth, minWidth)).toEqual(handSized);
  });
});

describe('fitToDisplays', () => {
  it('leaves a frame that fits where it is', () => {
    expect(fitToDisplays(frame, [primary, external])).toEqual(frame);
  });

  it('keeps a frame on the display it overlaps most, even when that is not the first', () => {
    const onExternal = { x: 2000, y: 100, width: 1400, height: 900 };
    expect(fitToDisplays(onExternal, [primary, external])).toEqual(onExternal);
  });

  it('pulls a frame hanging off the edge wholly back inside', () => {
    expect(fitToDisplays({ ...frame, x: 1000, y: -40 }, [primary])).toEqual({
      ...frame,
      x: primary.width - frame.width,
      y: primary.y,
    });
  });

  it('shrinks a frame larger than the work area to it', () => {
    expect(fitToDisplays({ x: 0, y: 0, width: 3000, height: 2000 }, [primary])).toEqual(primary);
  });

  it('centres a frame from an unplugged display on the first work area', () => {
    const gone = { x: 5000, y: 0, width: 1200, height: 800 };
    expect(fitToDisplays(gone, [primary])).toEqual({
      x: (primary.width - 1200) / 2,
      y: primary.y + (primary.height - 800) / 2,
      width: 1200,
      height: 800,
    });
  });

  it('gives up only with no display at all', () => {
    expect(fitToDisplays(frame, [])).toBeNull();
  });
});

describe('cascadeFrom', () => {
  const start = { x: 200, y: 100, width: 450, height: 820 };
  const step = 22;

  it('opens at the start frame when nothing sits there', () => {
    expect(cascadeFrom(start, [], [primary], step)).toEqual(start);
    expect(cascadeFrom(start, [{ ...start, x: 900 }], [primary], step)).toEqual(start);
  });

  it('steps past every window already at the same corner', () => {
    const second = { ...start, x: start.x + step, y: start.y + step };
    expect(cascadeFrom(start, [start], [primary], step)).toEqual(second);
    expect(cascadeFrom(start, [second, start], [primary], step)).toEqual({
      ...start,
      x: start.x + 2 * step,
      y: start.y + 2 * step,
    });
  });

  it('ends at the work area edge instead of leaving it', () => {
    const low = { ...start, y: primary.y + primary.height - start.height };
    const result = cascadeFrom(low, [low], [primary], step);
    expect(result.y).toBe(low.y);
    expect(result.x).toBe(low.x + step);
  });

  it('terminates when the edge pins every step to a taken corner', () => {
    const corner = {
      x: primary.width - start.width,
      y: primary.y + primary.height - start.height,
      width: start.width,
      height: start.height,
    };
    expect(cascadeFrom(corner, [corner, corner], [primary], step)).toEqual(corner);
  });
});
