/**
 * Remembered window frames: where the main window was, what page it was on,
 * and where the last detached session window was left (spec:
 * 2026-09-24-remembered-window-frames-design).
 *
 * Main owns the windows (ADR: the-main-process-owns-the-detached-windows), so
 * it owns this file too, under Electron's user-data directory. These are the
 * decisions about it; main only reads the file, hands the text in, and writes
 * back what comes out. Nothing here may import electron
 * (spec 2026-09-16-electron-wrapper-design § 4 "Testing").
 */
import type { Bounds } from './sessionWindows';

/** The file's name inside `app.getPath('userData')`. */
export const WINDOW_FRAMES_FILE = 'window-frames.json';

/**
 * Bumped only if the shape changes incompatibly. A file carrying another
 * version is read as no file at all: the windows open at their defaults, and
 * the next write replaces it.
 */
const FORMAT_VERSION = 1;

export interface WindowFrames {
  /** The main window's frame, and the in-app path it was last on. */
  main?: { bounds: Bounds; path?: string };
  /** One frame for every detached session window: the last one left. */
  session?: Bounds;
}

function isFiniteInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * A frame as the file holds it. Whatever passes ends up in a BrowserWindow's
 * constructor, so anything but whole numbers with a positive size is dropped.
 */
export function parseBounds(value: unknown): Bounds | null {
  if (typeof value !== 'object' || value === null) return null;
  const { x, y, width, height } = value as Record<string, unknown>;
  if (!isFiniteInt(x) || !isFiniteInt(y) || !isFiniteInt(width) || !isFiniteInt(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/**
 * Stands in for whatever origin the window loads: startup may pick the
 * server's or vite's, and the path has to mean the same page on either.
 */
const PLACEHOLDER_ORIGIN = 'http://orbital.invalid';

/** The detached window's route. It has no business in the main window. */
const SESSION_WINDOW_PREFIX = '/session/';

/**
 * An in-app path the main window may be sent back to: path, query and hash
 * of a URL on its own origin, or null.
 *
 * Kept wide on purpose — the map with `?session=`, `/stats`, a walkthrough —
 * because the page itself deals with whatever the path names no longer
 * existing (an unknown session drops its parameter, a missing walkthrough says
 * so, and every page has the bar back to the map). What is kept out is
 * anything that resolves to another origin, and the detached window's route,
 * which would load a lone detail panel into the main window.
 */
export function restorablePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/')) return null;
  let url: URL;
  try {
    url = new URL(value, PLACEHOLDER_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) return null;
  if (url.pathname.startsWith(SESSION_WINDOW_PREFIX)) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * The in-app path of a URL the main window is showing, when it is on the
 * origin startup chose — or null for anything else (an error page, a load
 * still on its way), which leaves the remembered path as it was.
 */
export function pathOnOrigin(currentUrl: string, windowTargetUrl: string): string | null {
  let current: URL;
  let target: URL;
  try {
    current = new URL(currentUrl);
    target = new URL(windowTargetUrl);
  } catch {
    return null;
  }
  if (current.origin !== target.origin) return null;
  return restorablePath(`${current.pathname}${current.search}${current.hash}`);
}

/**
 * The file's text as main read it, or null when there was none. Each part
 * stands on its own: a broken path costs the path, not the frame beside it,
 * and anything unreadable is simply absent — the default, never a throw.
 */
export function parseWindowFrames(text: string | null): WindowFrames {
  if (text === null) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof raw !== 'object' || raw === null) return {};
  const { version, main, session } = raw as Record<string, unknown>;
  if (version !== FORMAT_VERSION) return {};

  const frames: WindowFrames = {};
  if (typeof main === 'object' && main !== null) {
    const { bounds, path } = main as Record<string, unknown>;
    const parsed = parseBounds(bounds);
    if (parsed) {
      const restored = restorablePath(path);
      frames.main = restored === null ? { bounds: parsed } : { bounds: parsed, path: restored };
    }
  }
  const sessionBounds = parseBounds(session);
  if (sessionBounds) frames.session = sessionBounds;
  return frames;
}

export function serializeWindowFrames(frames: WindowFrames): string {
  return `${JSON.stringify({ version: FORMAT_VERSION, ...frames }, null, 2)}\n`;
}

function sameBounds(a: Bounds | undefined, b: Bounds): boolean {
  return !!a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * The frames with the main window's updated, or null when nothing changed and
 * there is nothing to write. A null path keeps the one remembered before —
 * the window was somewhere main could not read as an in-app page.
 */
export function withMainFrame(frames: WindowFrames, bounds: Bounds, path: string | null): WindowFrames | null {
  const nextPath = path ?? frames.main?.path;
  if (sameBounds(frames.main?.bounds, bounds) && nextPath === frames.main?.path) return null;
  return { ...frames, main: nextPath === undefined ? { bounds } : { bounds, path: nextPath } };
}

/** The frames with the detached windows' one frame updated, or null when unchanged. */
export function withSessionFrame(frames: WindowFrames, bounds: Bounds): WindowFrames | null {
  if (sameBounds(frames.session, bounds)) return null;
  return { ...frames, session: bounds };
}

function overlapArea(a: Bounds, b: Bounds): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * A remembered frame put back on a display that still exists.
 *
 * The frame goes to the work area it overlaps most; one that overlaps none (a
 * display unplugged since) goes to the first work area, which main passes as
 * the primary display's, centred there. It is then made to fit — no larger
 * than the work area, and moved just far enough to sit wholly inside it — so
 * a window is never restored where its title bar cannot be reached. Null only
 * when there is no display at all, which leaves the default frame to Electron.
 */
export function fitToDisplays(frame: Bounds, workAreas: readonly Bounds[]): Bounds | null {
  if (workAreas.length === 0) return null;
  let area = workAreas[0];
  let best = 0;
  for (const candidate of workAreas) {
    const overlap = overlapArea(frame, candidate);
    if (overlap > best) {
      best = overlap;
      area = candidate;
    }
  }
  const width = Math.min(frame.width, area.width);
  const height = Math.min(frame.height, area.height);
  const placed =
    best > 0
      ? { x: frame.x, y: frame.y }
      : {
          x: area.x + Math.round((area.width - width) / 2),
          y: area.y + Math.round((area.height - height) / 2),
        };
  const x = Math.min(Math.max(placed.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(placed.y, area.y), area.y + area.height - height);
  return { x, y, width, height };
}

/** A frame of the given size centred in a work area. */
export function centredIn(workArea: Bounds, width: number, height: number): Bounds {
  const w = Math.min(width, workArea.width);
  const h = Math.min(height, workArea.height);
  return {
    x: workArea.x + Math.round((workArea.width - w) / 2),
    y: workArea.y + Math.round((workArea.height - h) / 2),
    width: w,
    height: h,
  };
}

/**
 * Where a new detached window opens, given the frame it starts from (the
 * remembered one, or the default) and the frames of the detached windows
 * already open.
 *
 * Every new window starts from the same frame, so without this a second one
 * would sit exactly on the first and hide it. The rule is the smallest that
 * prevents that: while an open window has the same top-left corner, step
 * down and to the right by `step`, as macOS cascades its own windows. Each
 * step is fitted to the displays, so a cascade that runs into the work area's
 * edge stops there rather than leaving it; the steps are bounded by the
 * number of open windows, so it always ends, and at the edge it may end on
 * top of one.
 */
export function cascadeFrom(
  start: Bounds,
  open: readonly Bounds[],
  workAreas: readonly Bounds[],
  step: number,
): Bounds {
  const taken = (frame: Bounds) => open.some((o) => o.x === frame.x && o.y === frame.y);
  let frame = fitToDisplays(start, workAreas) ?? start;
  for (let i = 0; i < open.length && taken(frame); i++) {
    const next = { ...frame, x: frame.x + step, y: frame.y + step };
    frame = fitToDisplays(next, workAreas) ?? next;
  }
  return frame;
}
