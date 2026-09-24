import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  shell,
  Tray,
  utilityProcess,
  type UtilityProcess,
  type WebContents,
} from 'electron';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appMenuTemplate, parseMenuCommands, type MenuCommand } from './lib/appMenu';
import { decideQuit, decideWindowClose, WorkingSessions } from './lib/background';
import {
  decideWindowButtons,
  mainWindowUrl,
  parseMainWindowPath,
  parseWindowButtonsVisible,
} from './lib/mainWindow';
import { SessionNotifier, parseNotificationSettings } from './lib/notifications';
import { probeHealth, probeVite } from './lib/probe';
import { startSessionsFeed } from './lib/sessionsFeed';
import {
  decideDetach,
  decideNotificationClick,
  growForSubagent,
  isSessionId,
  parseSubagentPanelMessage,
  sessionWindowUrl,
  shrinkAfterSubagent,
  toCssPx,
  toDip,
  type Bounds,
  type SubagentGrowth,
  type SubagentPanelAnswer,
  type SubagentPanelMessage,
} from './lib/sessionWindows';
import {
  classifyChildExit,
  decideNavigation,
  decideStartup,
  decideWindowTarget,
  needsCliPrompt,
  VITE_URL,
  type HealthInfo,
} from './lib/startup';
import {
  atLeast,
  cascadeFrom,
  centredIn,
  fitToDisplays,
  parseWindowFrames,
  pathOnOrigin,
  serializeWindowFrames,
  sessionFrameToRemember,
  WINDOW_FRAMES_FILE,
  withMainFrame,
  withSessionFrame,
  type WindowFrames,
} from './lib/windowFrames';

const PORT = Number(process.env.ORBITAL_PORT ?? 4737);
const DEV = process.env.ORBITAL_DESKTOP_DEV === '1';

const HEALTH_POLL_INTERVAL_MS = 200;
// The server resolves the login shell's PATH and probes the CLI's version
// before it listens, which can take seconds on a cold machine.
const HEALTH_POLL_TIMEOUT_MS = 15_000;

// A detached window holds one detail panel, not the map beside it: it opens
// at the docked panel's own width until a frame is remembered, never shrinks
// below it, and has no maximum (canvas `Feature - Detached window` 22b; spec:
// 2026-09-23-detached-session-windows-design).
const SESSION_WINDOW_WIDTH = 450;
const SESSION_WINDOW_HEIGHT = 820;
const SESSION_WINDOW_MIN_HEIGHT = 520;
// The panel's own top stop, painted before the page loads so the window does
// not flash on open (22b).
const SESSION_WINDOW_BACKGROUND = '#0f1524';
// Row 1 of the panel doubles as the title bar (22b): the lights sit centred on
// that row, and the row's left padding is sized to clear them.
const SESSION_WINDOW_TRAFFIC_LIGHTS = { x: 14, y: 20 };

// The main window has no title bar either (canvas `Feature - Main window
// chrome` 24a; spec: 2026-09-24-main-window-chrome-design): the lights sit
// centred on the expanded sidebar's row 1, whose left padding clears them.
const MAIN_WINDOW_TRAFFIC_LIGHTS = { x: 30, y: 32 };
// The main window's size before it has a remembered frame.
const MAIN_WINDOW_WIDTH = 1440;
const MAIN_WINDOW_HEIGHT = 900;

// A drag or a resize fires its events continuously; the remembered frame is
// written once they have settled for this long (spec:
// 2026-09-24-remembered-window-frames-design).
const FRAME_WRITE_DELAY_MS = 500;
// Detached windows all open from the one remembered frame, so a second one
// steps this far down and to the right of the first rather than hiding it —
// roughly the offset macOS cascades its own windows by.
const SESSION_WINDOW_CASCADE_STEP = 22;

// Packaged, the three things the forked server needs sit beside the app's
// resources; unpackaged (running `electron .` in the repo) they sit in the
// sibling workspaces.
const repoRoot = join(__dirname, '..', '..');
const serverEntry = app.isPackaged
  ? join(process.resourcesPath, 'server', 'index.mjs')
  : join(repoRoot, 'server', 'dist', 'index.mjs');
const staticDir = app.isPackaged
  ? join(process.resourcesPath, 'web')
  : join(repoRoot, 'web', 'dist');
const migrationsDir = app.isPackaged
  ? join(process.resourcesPath, 'drizzle')
  : join(repoRoot, 'server', 'drizzle');
// This one is the desktop workspace's own asset, not a sibling's, so
// unpackaged it sits beside dist/ rather than up in the repo. `nativeImage`
// finds the @2x file itself, and the `Template` in the name is what marks the
// image as one macOS may restyle (spec: 2026-09-22-desktop-background-mode-design).
const trayIcon = app.isPackaged
  ? join(process.resourcesPath, 'trayTemplate.png')
  : join(__dirname, '..', 'build', 'trayTemplate.png');

let win: BrowserWindow | null = null;
/**
 * What the main window's renderer last asked of the traffic lights: shown with
 * the sidebar expanded, hidden with it collapsed (24b). Kept so leaving full
 * screen, where macOS owns the lights, can put back what the sidebar wants.
 */
let mainWindowButtonsVisible = true;
/**
 * Detached session windows, by session id. Main is the only thing that knows
 * this list (ADR: the-main-process-owns-the-detached-windows); the main
 * window hears it through `detached-changed`.
 */
const sessionWindows = new Map<string, BrowserWindow>();
let tray: Tray | null = null;
let child: UtilityProcess | null = null;
let feed: { close(): void } | null = null;
/** Every rule about what is worth saying lives in here, not in this file. */
const notifier = new SessionNotifier();
/** What a quit would kill, folded off the same feed the notifier reads. */
const working = new WorkingSessions();
/** True only when this process forked the server — shutdown kills only that. */
let forked = false;
let quitting = false;
/** Set by the quit dialog, so the `app.quit()` it makes passes the guard. */
let quitConfirmed = false;
/** Where the window was sent at startup; a restarted server reloads the same. */
let windowTargetUrl = '';
/** True while a fork-and-wait is in flight; that code owns the child's fate. */
let awaitingStart = false;
/** Exit code of a child that died during a fork-and-wait, for the one dialog. */
let startExit: number | null = null;

/**
 * The remembered frames, read once at launch. Main is the file's only writer,
 * so this copy is always what the file holds, or what it is about to.
 */
let windowFrames: WindowFrames = {};
/** True when `windowFrames` holds something the file does not yet. */
let windowFramesDirty = false;
let windowFramesTimer: ReturnType<typeof setTimeout> | null = null;

function windowFramesPath(): string {
  return join(app.getPath('userData'), WINDOW_FRAMES_FILE);
}

function loadWindowFrames(): void {
  let text: string | null = null;
  try {
    text = readFileSync(windowFramesPath(), 'utf8');
  } catch {
    /* no file yet: every window opens at its default */
  }
  windowFrames = parseWindowFrames(text);
}

/**
 * Write the remembered frames now, if anything changed. Through a temporary
 * file and a rename, so a quit mid-write leaves the old file rather than half
 * of the new one. A failed write costs a remembered frame and nothing else.
 */
function flushWindowFrames(): void {
  if (windowFramesTimer) clearTimeout(windowFramesTimer);
  windowFramesTimer = null;
  if (!windowFramesDirty) return;
  windowFramesDirty = false;
  const path = windowFramesPath();
  try {
    writeFileSync(`${path}.tmp`, serializeWindowFrames(windowFrames));
    renameSync(`${path}.tmp`, path);
  } catch (err) {
    console.error('Orbital could not save the window frames:', err);
  }
}

function updateWindowFrames(next: WindowFrames | null, when: 'soon' | 'now'): void {
  if (next) {
    windowFrames = next;
    windowFramesDirty = true;
  }
  if (when === 'now') {
    flushWindowFrames();
    return;
  }
  if (windowFramesTimer) clearTimeout(windowFramesTimer);
  windowFramesTimer = setTimeout(flushWindowFrames, FRAME_WRITE_DELAY_MS);
}

/**
 * The frame a window is left at. The normal frame, not the current one: a
 * window in full screen or zoomed comes back at the size it had before.
 */
function frameOf(target: BrowserWindow) {
  return target.getNormalBounds();
}

function rememberMainWindow(when: 'soon' | 'now'): void {
  if (!win || win.isDestroyed()) return;
  const path = pathOnOrigin(win.webContents.getURL(), windowTargetUrl);
  updateWindowFrames(withMainFrame(windowFrames, frameOf(win), path), when);
}

/**
 * The frame each detached window opened at, which `sessionFrameToRemember`
 * compares against. Weak, so a closed window takes its entry with it.
 */
const sessionWindowOpenedAt = new WeakMap<BrowserWindow, Bounds>();

function rememberSessionWindow(target: BrowserWindow): void {
  if (target.isDestroyed()) return;
  const opened = sessionWindowOpenedAt.get(target);
  if (!opened) return;
  const frame = sessionFrameToRemember(
    frameOf(target),
    opened,
    subagentGrowth.get(target),
    target.getMinimumSize()[0],
  );
  if (frame) updateWindowFrames(withSessionFrame(windowFrames, frame), 'soon');
}

/** Every display's work area, the primary one first. */
function workAreas() {
  const primary = screen.getPrimaryDisplay();
  return [primary, ...screen.getAllDisplays().filter((d) => d.id !== primary.id)].map((d) => d.workArea);
}

/**
 * `startExit` read without control-flow narrowing. Every read of it follows a
 * `startExit = null` in the same function, so TypeScript narrows the variable
 * to `null` and calls the exit-code branch unreachable — it cannot see the
 * child's `exit` handler, which is the only thing that ever sets a code.
 * Reading through a function yields the declared type instead.
 */
function readStartExit(): number | null {
  return startExit;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function forkServer(): UtilityProcess {
  const proc = utilityProcess.fork(serverEntry, [], {
    stdio: 'inherit',
    env: {
      ...process.env,
      // An app launched from Finder inherits a bare PATH; the server rebuilds
      // it from the login shell so the CLI and the tools sessions run can be
      // found (spec 2026-09-16-electron-wrapper-design § 3).
      ORBITAL_RESOLVE_PATH: '1',
      ORBITAL_STATIC_DIR: staticDir,
      // The bundle's own default migrations path is relative to its source
      // module, so it is wrong by construction once bundled — always pass this.
      ORBITAL_MIGRATIONS_DIR: migrationsDir,
    },
  });

  proc.on('exit', (code) => {
    switch (classifyChildExit({ quitting, current: child === proc, awaitingStart })) {
      case 'ignore':
        return;
      case 'abort-start':
        // bringServerUp is waiting on this one; let it report the failure.
        startExit = code;
        child = null;
        return;
      case 'offer-restart':
        child = null;
        void reportServerDeath(code);
        return;
    }
  });

  return proc;
}

/** Poll until the server answers as Orbital, it dies, or we give up on it. */
async function waitForHealth(): Promise<HealthInfo | null> {
  const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
  for (;;) {
    if (startExit !== null) return null; // it died; there is nothing left to answer
    const outcome = await probeHealth(PORT);
    if (outcome.kind === 'orbital') return outcome.health;
    if (Date.now() >= deadline) return null;
    await delay(HEALTH_POLL_INTERVAL_MS);
  }
}

/** Kill the current child, if any, and wait for it to actually be gone. */
async function discardChild(): Promise<void> {
  const dying = child;
  child = null; // marks the kill as deliberate for the 'exit' handler
  if (!dying) return;
  await new Promise<void>((resolve) => {
    dying.once('exit', () => resolve());
    dying.kill();
  });
}

/**
 * Fork the server and wait for it to answer, owning its death in the meantime:
 * on failure this is the only place that reports, and the user retries or quits.
 * Returns null when they chose to quit.
 */
async function bringServerUp(): Promise<HealthInfo | null> {
  for (;;) {
    awaitingStart = true;
    startExit = null;
    child = forkServer();
    const health = await waitForHealth();
    const exitCode = readStartExit();
    awaitingStart = false;
    startExit = null;
    if (health) return health;

    // Either it died, or it is alive and silent — in both cases it is no use.
    await discardChild();

    const detail =
      exitCode === null
        ? `It did not answer on 127.0.0.1:${PORT} in time.`
        : `It exited with code ${exitCode} before it answered.`;
    const { response } = await dialog.showMessageBox({
      type: 'error',
      message: 'Orbital’s server did not start',
      detail: `${serverEntry}\n\n${detail}\n\nIts own output is in this app's console. \`npm run build -w server\` rebuilds it.`,
      buttons: ['Try again', 'Quit'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return null;
  }
}

/** A dead server is a designed state, never a blank window (spec § 1). */
async function reportServerDeath(code: number): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'error',
    message: 'Orbital’s server stopped',
    detail: `The server exited with code ${code}. The map cannot update until it runs again.`,
    buttons: ['Restart server', 'Quit'],
    defaultId: 0,
    cancelId: 1,
  });

  if (response !== 0) {
    app.quit();
    return;
  }

  if (!(await bringServerUp())) {
    app.quit();
    return;
  }
  void win?.loadURL(windowTargetUrl);
}

/**
 * A missing CLI is a designed state (spec § 3): say so, offer to point at it,
 * and open the map either way.
 *
 * Returns false only when saving the path cost us the server and the user chose
 * to quit rather than retry — the one path where no window should open.
 */
async function promptForCli(): Promise<boolean> {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: 'The Claude Code CLI was not found',
    detail:
      'Orbital spawns sessions through the Claude Code CLI installed on this Mac. Until it can find one, the map still opens but no session can be started.',
    buttons: ['Choose executable…', 'Continue anyway'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return true;

  const picked = await dialog.showOpenDialog({
    title: 'Choose the claude executable',
    properties: ['openFile', 'showHiddenFiles'],
  });
  if (picked.canceled || picked.filePaths.length === 0) return true;

  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claude_executable_path: picked.filePaths[0] }),
    });
    if (!res.ok) throw new Error(`the server answered ${res.status}`);
  } catch (err) {
    dialog.showErrorBox(
      'Could not save the CLI path',
      `${picked.filePaths[0]}\n\n${String(err)}`,
    );
    return true;
  }

  // The server reads claude_executable_path once, at boot — so the PATCH has to
  // land before the restart, never after.
  await discardChild();
  if (await bringServerUp()) return true;
  app.quit();
  return false;
}

/** The main window and every detached one run the same renderer and bridge. */
const webPreferences = {
  preload: join(__dirname, 'preload.cjs'),
  contextIsolation: true,
};

/**
 * Every Orbital window is Orbital and nothing else. A link in a transcript
 * opens in the user's browser instead of replacing the page — there is no
 * Back here, and a remote page would be loaded with the preload attached.
 */
function confineToOrbital(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (decideNavigation(url, PORT) === 'external') void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    const decision = decideNavigation(url, PORT);
    if (decision === 'allow') return;
    event.preventDefault();
    if (decision === 'external') void shell.openExternal(url);
  });
}

/**
 * Build the main window on `url`, which becomes the URL a restarted server
 * reloads. `page` is what it loads now when that is another page on the same
 * origin — a walkthrough handed over by a detached window.
 */
function openWindow(url: string, page: string = url): void {
  windowTargetUrl = url;
  // `title` is pinned and the page's own ignored below: the window is
  // "Orbital" in Mission Control, the Dock and ⌘` whatever page it shows
  // (spec: 2026-09-24-main-window-chrome-design).
  // The frame it was last left at, put back on a display that still exists.
  const remembered = windowFrames.main ? fitToDisplays(windowFrames.main.bounds, workAreas()) : null;
  const main = new BrowserWindow({
    ...(remembered ?? { width: MAIN_WINDOW_WIDTH, height: MAIN_WINDOW_HEIGHT }),
    title: 'Orbital',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: MAIN_WINDOW_TRAFFIC_LIGHTS,
    webPreferences,
  });
  win = main;
  confineToOrbital(main.webContents);
  main.on('page-title-updated', (event) => event.preventDefault());
  // A renderer rebuilt after a crash starts with an empty list, and one that
  // reloaded has lost its own — so every finished load hears it again
  // (spec: 2026-09-23-detached-session-windows-design § "Edge cases"). The
  // full-screen state goes with it: the page lays out its chrome by it (24c).
  main.webContents.on('did-finish-load', () => {
    sendDetachedChanged();
    sendFullScreenChanged();
  });
  // A new page starts with the lights showing. Only the map's sidebar ever
  // hides them, and the page that replaces it (a reload, `/stats`) may have
  // no way to ask for them back; the map asks again as it mounts.
  main.webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    setMainWindowButtons(true);
  });
  main.on('enter-full-screen', () => sendFullScreenChanged());
  main.on('leave-full-screen', () => {
    // macOS hid the lights for full screen. The sidebar may still want them
    // hidden (24b), and it only says so when it changes.
    setMainWindowButtons(mainWindowButtonsVisible);
    sendFullScreenChanged();
  });

  // Closing is hiding: the renderer stays alive, so reopening is instant and
  // the map is exactly where it was, and the server it would have taken with
  // it keeps running (spec: 2026-09-22-desktop-background-mode-design).
  // Its frame and page are remembered for the next launch: as they change,
  // and at once when the window goes away, whether hidden or closed on quit.
  // `moved`/`resized`, not `move`/`resize`: the latter fire for every
  // intermediate frame of a drag or of an animated `setBounds`, the former
  // once, when the window has settled (macOS, the only platform built).
  main.on('moved', () => rememberMainWindow('soon'));
  main.on('resized', () => rememberMainWindow('soon'));
  main.webContents.on('did-navigate', () => rememberMainWindow('soon'));
  main.webContents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
    if (isMainFrame) rememberMainWindow('soon');
  });
  main.on('hide', () => rememberMainWindow('now'));
  main.on('close', (event) => {
    rememberMainWindow('now');
    if (decideWindowClose({ quitting }) === 'close') return;
    event.preventDefault();
    win?.hide();
  });
  main.on('closed', () => {
    win = null;
  });
  void main.loadURL(page);
}

/**
 * Tell the main window whether it is full screen, which drops the drag band,
 * its hint and the room row 1 makes for the lights (24c). Sent on every
 * change and on every load.
 */
function sendFullScreenChanged(): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('full-screen-changed', win.isFullScreen());
}

/**
 * Show or hide the main window's traffic lights, as the sidebar asks (24a,
 * 24b). Full screen leaves them to macOS; the request is kept for the way out.
 */
function setMainWindowButtons(visible: boolean): void {
  mainWindowButtonsVisible = visible;
  if (!win || win.isDestroyed()) return;
  const apply = decideWindowButtons(visible, win.isFullScreen());
  if (apply === null) return;
  win.setWindowButtonVisibility(apply);
  // Showing the lights again puts them back at macOS's default corner and
  // forgets `trafficLightPosition`, so they have to be moved onto row 1
  // again every time.
  if (apply) win.setWindowButtonPosition(MAIN_WINDOW_TRAFFIC_LIGHTS);
}

/**
 * Tell the main window which sessions are detached, so its `select` focuses
 * their windows instead of opening the docked panel. Never sent to a detached
 * window: its own `select` must not be redirected to focusing itself
 * (spec: 2026-09-23-detached-session-windows-design).
 */
function sendDetachedChanged(): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('detached-changed', [...sessionWindows.keys()]);
}

function focusSessionWindow(sessionId: string): void {
  const detached = sessionWindows.get(sessionId);
  if (!detached) return;
  detached.show();
  detached.focus();
}

/**
 * Detach a session's detail panel into its own window, or bring forward the
 * one it already has — at most one window per session.
 *
 * Unlike the main window, closing this one is a real close: that is how the
 * session comes back to the docked panel. Only its frame outlives it, as the
 * one the next detached window opens at.
 */
function openSessionWindow(sessionId: string): void {
  if (decideDetach(sessionId, sessionWindows) === 'focus') {
    focusSessionWindow(sessionId);
    return;
  }
  // Nothing to put the route on until startup has chosen an origin.
  if (!windowTargetUrl) return;
  // No `title`: Electron follows the page's, which the renderer keeps set to
  // the session's, so the Dock and Mission Control name the session. No menu
  // of its own either — the application menu carries Close Window on ⌘W,
  // which with the red light is how this window closes (22c draws no × of
  // ours).
  //
  // It opens where the last detached window was left, or centred at the
  // default size, stepped clear of any detached window already there.
  const areas = workAreas();
  const start = atLeast(
    windowFrames.session ?? centredIn(areas[0], SESSION_WINDOW_WIDTH, SESSION_WINDOW_HEIGHT),
    SESSION_WINDOW_WIDTH,
    SESSION_WINDOW_MIN_HEIGHT,
  );
  const open = [...sessionWindows.values()].filter((w) => !w.isDestroyed()).map((w) => w.getBounds());
  const detached = new BrowserWindow({
    ...cascadeFrom(start, open, areas, SESSION_WINDOW_CASCADE_STEP),
    minWidth: SESSION_WINDOW_WIDTH,
    minHeight: SESSION_WINDOW_MIN_HEIGHT,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: SESSION_WINDOW_TRAFFIC_LIGHTS,
    backgroundColor: SESSION_WINDOW_BACKGROUND,
    webPreferences,
  });
  confineToOrbital(detached.webContents);
  sessionWindows.set(sessionId, detached);
  // Whatever the user moves or resizes it to is where the next detached
  // window opens; `sessionFrameToRemember` leaves out the subagent panel's
  // grow and the frame it opened at. A close only writes what is already
  // remembered.
  sessionWindowOpenedAt.set(detached, frameOf(detached));
  // The settled events only (see the main window): the subagent panel's grow
  // and shrink animate through widths `sessionFrameToRemember` cannot tell
  // from a drag, and `resize` would hand it every one of them.
  detached.on('moved', () => rememberSessionWindow(detached));
  detached.on('resized', () => rememberSessionWindow(detached));
  detached.on('close', () => flushWindowFrames());
  detached.on('closed', () => {
    sessionWindows.delete(sessionId);
    sendDetachedChanged();
  });
  sendDetachedChanged();
  void detached.loadURL(sessionWindowUrl(windowTargetUrl, sessionId));
}

/**
 * What opening the subagent panel did to each detached window's frame, so
 * closing it can undo exactly that. Absent when the panel is closed, or when
 * the window was wide enough and did not grow. Weak, so a closed window takes
 * its entry with it.
 */
const subagentGrowth = new WeakMap<BrowserWindow, SubagentGrowth>();

/**
 * A detached window makes room for its subagent panel on the right, and gives
 * it back when the panel closes (spec: 2026-09-23-detached-session-windows-design
 * § The subagent panel in the window). The decisions are
 * `growForSubagent`/`shrinkAfterSubagent`; this only reads and sets frames.
 * Animated, as macOS resizes a window it was asked to.
 *
 * A full-screen window is its own space and keeps its size; the panel opens
 * inside it.
 *
 * Answers the width the window will have once the animation lands (spec:
 * 2026-09-24-subagent-list-design § 4): the grown or shrunk width, or the
 * current one when the frame stays. The renderer picks its layout from it
 * before the resize has finished.
 *
 * The renderer's widths are CSS px and a frame is DIP; they differ under
 * page zoom, so the message's widths go in through `toDip` and every answer
 * goes out through `toCssPx`.
 */
function resizeForSubagent(target: BrowserWindow, message: SubagentPanelMessage): SubagentPanelAnswer {
  const zoomFactor = target.webContents.getZoomFactor();
  const answer = (widthDip: number): SubagentPanelAnswer => ({
    widthPx: toCssPx(widthDip, zoomFactor),
  });
  const current = answer(target.getBounds().width);
  if (target.isFullScreen()) return current;
  if (message.open) {
    // A repeat open (the renderer reloaded mid-agent) keeps the first grow.
    if (subagentGrowth.has(target)) return current;
    const bounds = target.getBounds();
    const { workArea } = screen.getDisplayMatching(bounds);
    const growth = growForSubagent(
      bounds,
      workArea,
      toDip(message.widthPx, zoomFactor),
      toDip(message.pairMinPx, zoomFactor),
    );
    if (!growth) return current;
    subagentGrowth.set(target, growth);
    target.setBounds(growth.after, true);
    return answer(growth.after.width);
  }
  const growth = subagentGrowth.get(target);
  if (!growth) return current;
  subagentGrowth.delete(target);
  const bounds = shrinkAfterSubagent(target.getBounds(), growth, target.getMinimumSize()[0]);
  if (!bounds) return current;
  target.setBounds(bounds, true);
  return answer(bounds.width);
}

/**
 * Bring the map back: the Dock icon, the tray's Open Orbital and a clicked
 * notification all land here (spec: 2026-09-22-desktop-background-mode-design).
 *
 * A missing window means a real teardown — a crashed renderer — rather than
 * the ordinary hidden one, so it is rebuilt on the URL startup decided on.
 */
function showWindow(): void {
  if (!win) {
    // An empty target means startup has not decided a URL yet (a Dock click
    // while a startup dialog is up lands here) — opening now would make
    // exactly the blank window the wrapper spec forbids. Startup will open
    // the window itself once it knows where to point it.
    if (!windowTargetUrl) return;
    openWindow(windowTargetUrl);
    return;
  }
  win.show();
  win.focus();
}

/**
 * Load an in-app page in the main window and bring it forward: a detached
 * window's walkthrough control lands here, and the detached window stays as
 * it was (spec: 2026-09-24-page-headers-design § "Walkthrough from a detached
 * window"). A missing main window is rebuilt as `showWindow` rebuilds it, on
 * the page instead of the map; startup's URL stays the one a restart reloads.
 */
function openInMainWindow(path: string): void {
  if (!windowTargetUrl) return;
  const url = mainWindowUrl(windowTargetUrl, path);
  if (!win) {
    openWindow(windowTargetUrl, url);
    return;
  }
  void win.loadURL(url);
  win.show();
  win.focus();
}

/**
 * The menu bar item: a static template icon and two commands, no session state
 * — notifications already carry that (spec:
 * 2026-09-22-desktop-background-mode-design § "Tray content").
 *
 * `tray` is a module-level binding because it has to be: a Tray held only by a
 * local is collected, and the icon vanishes from the menu bar with it.
 */
function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(trayIcon));
  tray.setToolTip('Orbital');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Orbital', click: () => showWindow() },
      { type: 'separator' },
      // `app.quit()` rather than a teardown of our own, so this meets the same
      // guard ⌘Q does.
      { label: 'Quit Orbital', click: () => app.quit() },
    ]),
  );
}

/**
 * Pull Settings → Notifications into the notifier.
 *
 * The WebSocket publishes `sessions` and `errors` only, so these five
 * booleans do not arrive on the feed that drives them. Rather than grow a
 * topic for them, they are fetched here — at startup, on every reconnect, and
 * whenever the renderer reports a save (spec
 * 2026-09-21-settings-sections-design § 5). A failed read leaves whatever was
 * loaded last standing, which on a cold start is "everything on", i.e. what
 * the app did before the section existed.
 */
async function loadNotificationSettings(): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/settings`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return;
    notifier.setSettings(parseNotificationSettings(await res.json()));
  } catch {
    /* server still coming up, or gone: keep the settings we have */
  }
}

/**
 * Watch the server's own WebSocket and turn what the notifier reports into
 * native notifications that jump back to the session (spec § 3).
 *
 * The focus check is the reason notifications exist: a visible, focused map
 * already shows every one of these states, so interrupting over it is noise.
 * It is now the "Only when Orbital is in the background" row rather than an
 * unconditional rule, but it keeps that default.
 */
function startNotifications(): void {
  if (!Notification.isSupported()) return;
  void loadNotificationSettings();
  // The renderer is the only thing that changes these, so it can say so
  // exactly. A missed message costs one notification judged by the previous
  // rule; the next reconnect corrects it.
  ipcMain.on('settings-changed', () => void loadNotificationSettings());
  feed = startSessionsFeed({
    url: `ws://127.0.0.1:${PORT}/ws`,
    // A new socket means the world is about to replay; what we knew is stale.
    onReconnect: () => {
      notifier.reset();
      working.reset();
      void loadNotificationSettings();
    },
    onFrame: (frame) => {
      // Two folds over one socket: what is worth saying, and what a quit would
      // cost (spec: 2026-09-22-desktop-background-mode-design § "Quit guard").
      working.onFrame(frame);
      const d = notifier.onEvent(frame);
      if (!d) return;
      const target = win;
      if (!target) return;
      // "In the background" means no Orbital window has focus: a focused
      // detached window already shows its session's state, as the map would
      // (spec: 2026-09-23-detached-session-windows-design § "Edge cases").
      if (notifier.current.onlyWhenBackground && BrowserWindow.getFocusedWindow()) return;

      const n = new Notification({
        title: d.title,
        body: d.body,
        silent: !notifier.current.sound,
      });
      n.on('click', () => {
        // Decided here, not by the renderer's `select`: a detached session's
        // window comes forward without a round trip through the map.
        const click = decideNotificationClick(d.sessionId, sessionWindows);
        if (click.kind === 'session-window') {
          focusSessionWindow(click.sessionId);
          return;
        }
        target.show();
        target.focus();
        if (click.select) target.webContents.send('select-session', click.select);
      });
      n.show();
    },
  });
}

async function start(): Promise<void> {
  const outcome = await probeHealth(PORT);
  let health: HealthInfo = outcome.kind === 'orbital' ? outcome.health : {};

  switch (decideStartup(outcome)) {
    case 'occupied':
      dialog.showErrorBox(
        `Port ${PORT} is taken`,
        `Something that is not Orbital already answers on 127.0.0.1:${PORT}. Stop it, or start Orbital with ORBITAL_PORT set to a free port.`,
      );
      app.quit();
      return;

    case 'fork': {
      if (DEV) {
        // Development attaches to the user's own dev server; the desktop app
        // does not own tsx or vite.
        dialog.showErrorBox(
          'No Orbital dev server is running',
          `Nothing answers on 127.0.0.1:${PORT}. Run \`npm run dev\` first, then start the desktop app again.`,
        );
        app.quit();
        return;
      }
      forked = true;
      const up = await bringServerUp();
      if (!up) {
        app.quit();
        return;
      }
      health = up;
      break;
    }

    case 'attach':
      // Someone else's server. We neither started it nor may kill it (spec § 1).
      break;
  }

  // `false` means the CLI prompt ended in a quit — there is nothing to open.
  if (needsCliPrompt(health, forked) && !(await promptForCli())) return;

  const target = decideWindowTarget({
    dev: DEV,
    port: PORT,
    serverServesStatic: health.static === true,
    viteReachable: await probeVite(),
  });
  if (target.kind === 'no-ui') {
    dialog.showErrorBox(
      'Orbital has no map to show',
      `The server on 127.0.0.1:${PORT} is a development server: it answers the API but serves no web app, and nothing answers on ${VITE_URL} either.\n\nEither run \`npm run dev\` so vite serves the map and start Orbital again, or stop \`npm run dev\` so Orbital can start its own server.`,
    );
    app.quit();
    return;
  }

  // Back on the page it was last on. Whatever that page named may be gone by
  // now; the page itself deals with that (spec:
  // 2026-09-24-remembered-window-frames-design).
  const rememberedPath = windowFrames.main?.path;
  openWindow(target.url, rememberedPath ? mainWindowUrl(target.url, rememberedPath) : target.url);
  // Once, and only once there is a window for it to open. Every path above
  // this line ends in `app.quit()`, where a menu bar item would be a leak.
  createTray();
  startNotifications();
}

/**
 * The keymap's menu-worthy commands, as the main window's renderer last sent
 * them (spec: 2026-09-23-shortcuts-design § 5). Empty until it does, which
 * leaves the menu as it was before the keymap.
 */
let menuCommands: MenuCommand[] = [];

function rebuildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      appMenuTemplate({
        dev: DEV,
        showMap: showWindow,
        commands: menuCommands,
        run: runCommand,
        runInMain: runCommandInMain,
      }),
    ),
  );
}

/**
 * A menu item's command runs in the window that has focus, so ⌘. in a
 * detached window interrupts that window's session. With no window focused
 * (the menu bar stays up after the last one lost focus), the main window
 * takes it.
 */
function runCommand(id: string): void {
  const target = BrowserWindow.getFocusedWindow() ?? win;
  target?.webContents.send('command', id);
}

/** Window → Map's command, which belongs to the main window wherever focus is. */
function runCommandInMain(id: string): void {
  win?.webContents.send('command', id);
}

void app.whenReady().then(() => {
  // Before `start`, so ⌘Q and the Edit roles already work in its dialogs.
  // Map does nothing until startup has chosen a URL, as the Dock icon does not.
  rebuildMenu();
  loadWindowFrames();
  return start();
});

// The detail panel's detach control, and the renderer's `select` landing on a
// detached session (spec: 2026-09-23-detached-session-windows-design). The
// ids come from a renderer, so anything that is not one is dropped here.
ipcMain.on('detach-session', (_event, id: unknown) => {
  if (isSessionId(id)) openSessionWindow(id);
});
ipcMain.on('focus-session', (_event, id: unknown) => {
  if (isSessionId(id)) focusSessionWindow(id);
});
// A detached window's walkthrough control: the page opens in the main window
// (spec: 2026-09-24-page-headers-design). The path comes from a renderer and
// ends up in `loadURL`, so only a walkthrough path gets through.
ipcMain.on('open-in-main-window', (_event, payload: unknown) => {
  const path = parseMainWindowPath(payload);
  if (path !== null) openInMainWindow(path);
});
// The sidebar collapsing or expanding in the main window hides or shows the
// traffic lights (spec: 2026-09-24-main-window-chrome-design). A detached
// window keeps its lights whatever it sends.
ipcMain.on('set-window-buttons-visible', (event, payload: unknown) => {
  if (!win || BrowserWindow.fromWebContents(event.sender) !== win) return;
  const visible = parseWindowButtonsVisible(payload);
  if (visible !== null) setMainWindowButtons(visible);
});
// The keymap's menu commands (spec: 2026-09-23-shortcuts-design § 5). Only
// the main window's list is heard, and the list comes from a page, so it is
// validated before it reaches the menu bar.
ipcMain.on('set-menu-commands', (event, payload: unknown) => {
  if (!win || BrowserWindow.fromWebContents(event.sender) !== win) return;
  menuCommands = parseMenuCommands(payload);
  rebuildMenu();
});
// The subagent panel opening or closing inside a detached window. Only a
// detached window's own renderer is heard, and only about itself; it is
// answered with its resulting width, anything else with undefined.
ipcMain.handle('session-window-subagent', (event, payload: unknown) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (!sender || ![...sessionWindows.values()].includes(sender)) return undefined;
  const message = parseSubagentPanelMessage(payload);
  return message ? resizeForSubagent(sender, message) : undefined;
});

// There is deliberately no `window-all-closed` handler: closing the window no
// longer quits, so the app lives on in the menu bar until it is told to go.
// The Dock icon is the other way back in
// (spec: 2026-09-22-desktop-background-mode-design § "Window lifecycle").
app.on('activate', () => showWindow());

/**
 * The one thing quitting costs that cannot be undone: the forked server dies,
 * and every session Orbital is running dies mid-turn with it
 * (spec: 2026-09-22-desktop-background-mode-design § "Quit guard").
 */
/** True while the quit dialog is up — a second ⌘Q must not stack another. */
let confirmInFlight = false;

async function confirmQuit(): Promise<void> {
  if (confirmInFlight) return;
  confirmInFlight = true;
  const count = working.count;
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: `${count} ${count === 1 ? 'session' : 'sessions'} still working — quit anyway?`,
    detail:
      'Quitting stops Orbital’s server, and the turns it is running end where they are. Sessions you started in a terminal are not affected.',
    buttons: ['Quit', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  confirmInFlight = false;
  if (response !== 0) return; // cancelled: the app carries on exactly as it was
  quitConfirmed = true;
  app.quit();
}

app.on('before-quit', (event) => {
  if (!quitConfirmed && decideQuit({ forked, workingCount: working.count }) === 'confirm') {
    // The dialog cannot be answered inside this handler, so the quit is
    // stopped here and started again from the answer.
    event.preventDefault();
    void confirmQuit();
    return;
  }
  quitting = true;
  feed?.close();
  feed = null;
  if (forked && child) {
    child.kill();
    child = null;
  }
});

// Last, after every window has had its `close`: a move still waiting out its
// delay is written rather than lost.
app.on('will-quit', () => flushWindowFrames());
