import {
  app,
  autoUpdater as nativeUpdater,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  session,
  shell,
  Tray,
  utilityProcess,
  type UtilityProcess,
  type WebContents,
} from 'electron';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { autoUpdater } from 'electron-updater';
import { apiTokenPath, authCookies, bearerHeaders, parseApiToken } from './lib/apiToken';
import { appMenuTemplate, parseMenuCommands, type MenuCommand } from './lib/appMenu';
import { decideQuit, decideWindowClose, WorkingSessions } from './lib/background';
import { pickerStartPath } from './lib/chooseDirectory';
import {
  decideWindowButtons,
  mainWindowUrl,
  parseMainWindowPath,
  parseWindowButtonsVisible,
} from './lib/mainWindow';
import { SessionNotifier, parseNotificationSettings } from './lib/notifications';
import { NOTIFICATION_SETTINGS_URL, probeNotificationPermission } from './lib/notificationPermission';
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
  decideAttach,
  decideStartup,
  decideWindowTarget,
  desktopOwner,
  needsCliPrompt,
  VITE_URL,
  type HealthInfo,
} from './lib/startup';
import {
  checkAnswerMessage,
  IDLE_SETTLE_MS,
  parseAutoDownload,
  parseSkippedVersion,
  parseUpdateAction,
  serializeSkippedVersion,
  shouldCheckForUpdates,
  SKIPPED_VERSION_FILE,
  UPDATE_CHECK_INTERVAL_MS,
  updateSize,
  UpdateFlow,
  type UpdateCheckAnswer,
  type UpdateStep,
} from './lib/updates';
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
// How long a server we stop gets to exit before it is killed outright, and
// again after that before we stop waiting for it. Its shutdown closes the
// database and every session's CLI, which is quick; this is the bound on a
// hung one, not the expected time.
const CHILD_EXIT_TIMEOUT_MS = 5_000;
// The local API requests main makes itself; the server answers them at once.
const API_REQUEST_TIMEOUT_MS = 5_000;
// The working-sessions seed after a (re)connect: the largest page
// `GET /api/sessions` gives, and how soon a failed read is tried again.
const SEED_SESSIONS_LIMIT = 200;
const SEED_RETRY_MS = 2_000;

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
/** An update: whether to download it, and when it may restart the app (`lib/updates`). */
const updates = new UpdateFlow({ skippedVersion: readSkippedVersion() });
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

/**
 * The local API's token, read from the server's data dir on every use: the
 * server mints it on its first start, and deleting the file rotates it
 * (spec 2026-10-03-api-token-and-named-files-design § 1).
 */
function readApiToken(): string | null {
  let text: string | null = null;
  try {
    text = readFileSync(apiTokenPath(process.env, homedir()), 'utf8');
  } catch {
    /* not minted yet, or a server too old to have a guard */
  }
  return parseApiToken(text);
}

/** What every main-process request to the server carries. */
function authHeaders(): Record<string, string> {
  return bearerHeaders(readApiToken());
}

/**
 * Hand the token to every window as the cookie the web app carries, before
 * any of them loads — so no window has to enter through `/api/auth`. The
 * windows use the default session (no partition in `webPreferences`).
 */
async function installAuthCookies(): Promise<void> {
  const token = readApiToken();
  if (!token) return;
  try {
    await Promise.all(authCookies(token, PORT).map((cookie) => session.defaultSession.cookies.set(cookie)));
  } catch (err) {
    // The window then shows the web app's unauthorized screen, which names the
    // way in; a dialog here would only say the same thing less usefully.
    console.error('Orbital could not set the API token cookie:', err);
  }
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
      // What the phone's `hello` and the health payload report as this build
      // (spec 2026-10-07-version-compatibility-design); unset, it says 'dev'.
      ORBITAL_VERSION: app.getVersion(),
      // The server stops itself once this process is gone, so a crash leaves
      // no orphan, and health names it, so a next launch can tell one apart.
      ORBITAL_PARENT_PID: String(process.pid),
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
        reportServerDeath(code).catch(failHard);
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

/** Resolve when `proc` exits, or false once `ms` has passed without it doing so. */
function exited(proc: UtilityProcess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Kill the current child, if any, and wait for it to actually be gone — but
 * not forever: one that ignores the polite kill is killed outright, and one
 * that outlives even that is left behind rather than leaving the app hung
 * with no window. The fork after it then fails on the port and says so.
 */
async function discardChild(): Promise<void> {
  const dying = child;
  child = null; // marks the kill as deliberate for the 'exit' handler
  if (!dying || dying.pid === undefined) return; // never started, or already gone
  const pid = dying.pid;
  const gone = exited(dying, CHILD_EXIT_TIMEOUT_MS);
  dying.kill();
  if (await gone) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return; // it went between the two checks
  }
  await exited(dying, CHILD_EXIT_TIMEOUT_MS);
}

/** True when a process with this pid exists, ours to signal or not. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Poll until nothing answers on the port, or give up after `ms`. */
async function waitForPortFree(ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if ((await probeHealth(PORT)).kind === 'refused') return true;
    if (Date.now() >= deadline) return false;
    await delay(HEALTH_POLL_INTERVAL_MS);
  }
}

/**
 * Stop an orphaned server a crashed copy of this app left behind, so a fresh
 * one can take the port. Its pid came from its own authenticated health.
 */
async function stopOrphan(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* already gone, or not ours to signal — the port tells us which */
  }
  if (await waitForPortFree(CHILD_EXIT_TIMEOUT_MS)) return true;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* as above */
  }
  return waitForPortFree(CHILD_EXIT_TIMEOUT_MS);
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
  await installAuthCookies();
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
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ claude_executable_path: picked.filePaths[0] }),
      signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
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

/** Bring a window forward, out of the Dock if it was minimized there. */
function bringForward(target: BrowserWindow): void {
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
}

function focusSessionWindow(sessionId: string): void {
  const detached = sessionWindows.get(sessionId);
  if (!detached || detached.isDestroyed()) return;
  bringForward(detached);
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
function showWindow(): BrowserWindow | null {
  if (!win || win.isDestroyed()) {
    // An empty target means startup has not decided a URL yet (a Dock click
    // while a startup dialog is up lands here) — opening now would make
    // exactly the blank window the wrapper spec forbids. Startup will open
    // the window itself once it knows where to point it.
    if (!windowTargetUrl) return null;
    openWindow(windowTargetUrl);
    return win;
  }
  bringForward(win);
  return win;
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
 * Pull the settings main acts on: Settings → Notifications into the
 * notifier, and Settings › Updates › Download updates automatically into the
 * update flow.
 *
 * The WebSocket publishes `sessions` and `errors` only, so these do not
 * arrive on the feed that drives them. Rather than grow a topic for them,
 * they are fetched here — at startup, on every reconnect, before every update
 * check, and whenever the renderer reports a save (spec
 * 2026-09-21-settings-sections-design § 5). A failed read leaves whatever was
 * loaded last standing, which on a cold start is the defaults: silent
 * (spec 2026-10-08-notifications-off-by-default-design), and asking before a
 * download.
 */
async function loadSettings(): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/settings`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return;
    const body: unknown = await res.json();
    notifier.setSettings(parseNotificationSettings(body));
    applyUpdateStep(updates.setAutoDownload(parseAutoDownload(body)));
  } catch {
    /* server still coming up, or gone: keep the settings we have */
  }
}

/**
 * Read which Orbital sessions are already mid-turn, after every (re)connect:
 * the server replays nothing to a new subscriber, so the frames alone would
 * miss them (`WorkingSessions`). The same list the web app loads, narrowed to
 * Orbital's own sessions; a working one is recent, so the first page holds
 * it. A failed read is retried until it lands or a newer socket makes it
 * stale — until then the quit guard counts what the frames showed, and a
 * restart waiting for sessions to finish keeps waiting.
 */
async function seedWorkingSessions(): Promise<void> {
  const token = working.beginSeed();
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/sessions?source=web&limit=${SEED_SESSIONS_LIMIT}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
    });
    if (res.ok) {
      working.seed(token, await res.json());
      applyUpdateStep(updates.setWorkingCount(working.count, working.seeded));
    }
  } catch {
    /* server still coming up, or gone: retried below */
  }
  if (quitting || working.seeded || working.beginSeed() !== token) return;
  setTimeout(() => {
    if (working.beginSeed() === token && !working.seeded) void seedWorkingSessions();
  }, SEED_RETRY_MS);
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
  void loadSettings();
  feed = startSessionsFeed({
    url: `ws://127.0.0.1:${PORT}/ws`,
    headers: authHeaders,
    // A new socket means the world is about to replay; what we knew is stale.
    onReconnect: () => {
      notifier.reset();
      working.reset();
      // The update flow forgets the count too, so a restart waiting for
      // sessions to finish cannot take the one from before the drop.
      applyUpdateStep(updates.setWorkingCount(working.count, working.seeded));
      void seedWorkingSessions();
      void loadSettings();
    },
    onFrame: (frame) => {
      // Two folds over one socket: what is worth saying, and what a quit would
      // cost (spec: 2026-09-22-desktop-background-mode-design § "Quit guard").
      working.onFrame(frame);
      onWorkingFrame(frame);
      const d = notifier.onEvent(frame);
      if (!d) return;
      if (!win || win.isDestroyed()) return;
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
        // The window the notification was raised over may be gone by the
        // click (a crashed renderer), so it is looked up now, rebuilt if need
        // be, and brought back from the Dock if it was minimized.
        const main = showWindow();
        if (!main || !click.select) return;
        const select = click.select;
        // A rebuilt window has no renderer to hear it yet.
        if (main.webContents.isLoading()) {
          main.webContents.once('did-finish-load', () => main.webContents.send('select-session', select));
        } else {
          main.webContents.send('select-session', select);
        }
      });
      n.show();
    },
  });
}

/** True once `startUpdates` found a build that updates itself. */
let updatesEnabled = false;

function skippedVersionPath(): string {
  return join(app.getPath('userData'), SKIPPED_VERSION_FILE);
}

/**
 * The version skipped with × on Available, kept in a file of main's own in
 * `userData` rather than in the server's settings: it belongs to this app's
 * installer, main is its only reader and writer, and it has to be known at
 * the first check whether or not the server answers yet.
 */
function readSkippedVersion(): string | null {
  try {
    return parseSkippedVersion(readFileSync(skippedVersionPath(), 'utf8'));
  } catch {
    return null; // no file yet: nothing skipped
  }
}

function writeSkippedVersion(version: string | null): void {
  try {
    writeFileSync(skippedVersionPath(), serializeSkippedVersion(version));
  } catch (err) {
    // Costs one more offer of that version after a restart, nothing else.
    console.error('Orbital could not remember the skipped update:', err);
  }
}

/**
 * The app updating itself from GitHub Releases (spec
 * 2026-10-08-builds-for-testers-design § The desktop app updates itself;
 * canvas `Feature - App update`). Only a packaged build carrying
 * `app-update.yml` — what the release build's `publish` setting writes —
 * looks; a dev build and `dist:local`/`dist:self` never do.
 *
 * electron-updater's own `autoDownload` stays off: the flow says when to
 * download — at once with Settings › Updates › Download updates
 * automatically on, on the prompt's Download otherwise, and never for a
 * skipped version. What has been downloaded installs when the app next
 * quits. A failed check is logged and tried again at the next interval,
 * never shown: a tester without an update loses nothing.
 */
function startUpdates(): void {
  const hasAppUpdateYml = existsSync(join(process.resourcesPath, 'app-update.yml'));
  if (!shouldCheckForUpdates({ isPackaged: app.isPackaged, hasAppUpdateYml })) return;
  updatesEnabled = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // A failed check changes nothing; a failed `quitAndInstall` gives the
  // version back to the prompt rather than leaving it restarting forever.
  autoUpdater.on('error', (err) => {
    console.error('Orbital could not update itself:', err);
    applyUpdateStep(updates.updaterError());
  });
  autoUpdater.on('download-progress', (progress) =>
    applyUpdateStep(updates.progress(progress.percent, progress.total)),
  );
  autoUpdater.on('update-downloaded', (info) => applyUpdateStep(updates.downloaded(info.version)));
  // `quitAndInstall` has Squirrel.Mac close every window first and emit
  // `before-quit` only after. A window that hides on close would stop that
  // quit, and the quit dialog would ask again about sessions the user already
  // chose to interrupt — so both guards stand down, for this quit only. The
  // `before-quit` handler still stops the feed and the server, and
  // `will-quit` still writes the window frames.
  nativeUpdater.on('before-quit-for-update', () => {
    quitting = true;
    quitConfirmed = true;
  });
  void checkForUpdates(false);
  setInterval(() => void checkForUpdates(false), UPDATE_CHECK_INTERVAL_MS);
}

/**
 * One check: the setting read first, so the flow knows whether to download
 * what it finds. `manual` is Check now, from Settings or the menu, which
 * offers a skipped version again. What it found goes to the flow from the
 * check's own result rather than from `update-available`, so a check at
 * launch or on the interval running at the same moment cannot take the
 * manual one's version for its own.
 */
async function checkForUpdates(manual: boolean): Promise<UpdateCheckAnswer> {
  if (!updatesEnabled) return { kind: 'unsupported' };
  await loadSettings();
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result) return { kind: 'unsupported' };
    applyUpdateStep(updates.checked(Date.now()));
    if (!result.isUpdateAvailable) return { kind: 'up-to-date' };
    const { version, files } = result.updateInfo;
    const step = updates.available(version, updateSize(files), { manual });
    applyUpdateStep(step);
    return { kind: 'found', version, outcome: step.outcome };
  } catch {
    // Emitted as `error` as well, and logged there.
    return { kind: 'error' };
  }
}

/**
 * Orbital → Check for Updates…: the same check as Settings' Check now, and
 * a quiet answer when the map has nothing to show for it.
 */
async function checkForUpdatesFromMenu(): Promise<void> {
  const answer = await checkForUpdates(true);
  const message = checkAnswerMessage(answer, { current: app.getVersion() });
  if (message) await dialog.showMessageBox({ type: 'none', message: message.message, detail: message.detail });
}

/**
 * Hand the update flow the working count after a `sessions` frame, the only
 * kind that moves it. A wait for sessions to finish ends here.
 */
function onWorkingFrame(frame: unknown): void {
  if (typeof frame !== 'object' || frame === null) return;
  if ((frame as { topic?: unknown }).topic !== 'sessions') return;
  applyUpdateStep(updates.setWorkingCount(working.count, working.seeded));
}

/** The pending `idleSettled` call after the working count reached zero in a wait. */
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Carry out what the flow decided: tell every Orbital window what changed,
 * remember a skip, start a download, look again once a zero has settled,
 * restart.
 */
function applyUpdateStep(step: UpdateStep): void {
  if (step.changed) {
    const view = updates.view;
    for (const target of [win, ...sessionWindows.values()]) {
      if (target && !target.isDestroyed()) target.webContents.send('update-state', view);
    }
  }
  if (step.skipChanged) writeSkippedVersion(updates.skippedVersion);
  if (step.download) {
    // Resolves only once Squirrel.Mac has staged the update, so a refusal
    // after `update-downloaded` lands here too.
    autoUpdater.downloadUpdate().catch((err: unknown) => {
      console.error('Orbital could not download the update:', err);
      applyUpdateStep(updates.downloadFailed());
    });
  }
  if (step.idleCheck) {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      applyUpdateStep(updates.idleSettled());
    }, IDLE_SETTLE_MS);
  }
  if (step.restart) autoUpdater.quitAndInstall();
}

/** Whether an IPC message came from one of Orbital's own windows. */
function fromOrbitalWindow(sender: WebContents): boolean {
  const from = BrowserWindow.fromWebContents(sender);
  return !!from && (from === win || [...sessionWindows.values()].includes(from));
}

/**
 * Something threw where nothing was there to catch it — startup, or a restart
 * after the server died. Say so and quit, rather than live on in the menu bar
 * with no window and nothing said.
 */
function failHard(err: unknown): void {
  console.error('Orbital failed:', err);
  dialog.showErrorBox(
    'Orbital ran into an error and has to quit',
    `${err instanceof Error ? err.message : String(err)}\n\nOpen Orbital again to retry.`,
  );
  quitConfirmed = true; // nothing is left running that a quit dialog would protect
  app.quit();
}

async function start(): Promise<void> {
  // With the token when there is one, so the answer says which build the
  // server is and whether a desktop app forked it — what `decideAttach` reads.
  // A server too old to say, or one with another token, answers as before.
  let outcome = await probeHealth(PORT, readApiToken());

  if (outcome.kind === 'orbital') {
    const owner = desktopOwner(outcome.health);
    const decision = decideAttach({
      dev: DEV,
      appVersion: app.getVersion(),
      health: outcome.health,
      parentAlive: owner ? processAlive(owner.parentPid) : false,
    });
    if (decision === 'refuse') {
      const theirs = typeof outcome.health.version === 'string' ? outcome.health.version : 'another version';
      dialog.showErrorBox(
        'Another Orbital is running',
        `A copy of Orbital ${theirs} is already running its server on 127.0.0.1:${PORT}, and this is Orbital ${app.getVersion()}. Quit the other one, then open this one again.`,
      );
      app.quit();
      return;
    }
    if (decision === 'replace' && owner) {
      if (!(await stopOrphan(owner.pid))) {
        dialog.showErrorBox(
          'Orbital’s old server would not stop',
          `A server left behind by an Orbital that is no longer running still holds 127.0.0.1:${PORT} (process ${owner.pid}). Stop it, then open Orbital again.`,
        );
        app.quit();
        return;
      }
      outcome = { kind: 'refused' };
    }
  }
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
      // Someone else's server, which `decideAttach` let through. We neither
      // started it nor may kill it (spec § 1).
      break;
  }

  // A server forked just now minted its token only as it started, so the
  // probe above may have gone without one. Asked with it, health adds
  // `claudeCli`, which the prompt below reads.
  const token = readApiToken();
  if (token) {
    const full = await probeHealth(PORT, token);
    if (full.kind === 'orbital') health = full.health;
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
  await installAuthCookies();
  openWindow(target.url, rememberedPath ? mainWindowUrl(target.url, rememberedPath) : target.url);
  // Once, and only once there is a window for it to open. Every path above
  // this line ends in `app.quit()`, where a menu bar item would be a leak.
  createTray();
  startNotifications();
  startUpdates();
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
        checkForUpdates: () => void checkForUpdatesFromMenu(),
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
}).catch(failHard);

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

// The New session dialog's Browse… (canvas 1d): the native folder picker,
// sheet-attached to the window that asked. Only Orbital's own windows are
// heard. Resolves to the chosen directory, or null when the user cancels.
ipcMain.handle('choose-directory', async (event, payload: unknown) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (!sender || (sender !== win && ![...sessionWindows.values()].includes(sender))) return null;
  const picked = await dialog.showOpenDialog(sender, {
    title: 'Choose the project directory',
    buttonLabel: 'Choose',
    defaultPath: pickerStartPath(payload, homedir()),
    properties: ['openDirectory', 'createDirectory'],
  });
  return picked.canceled ? null : (picked.filePaths[0] ?? null);
});

// The notifications tip's Turn on (spec
// 2026-10-08-notifications-off-by-default-design § 3): asks macOS by showing
// one quiet notification, and answers how it went (`notificationPermission`).
// Only the main window shows the tip.
ipcMain.handle('request-notification-permission', (event) => {
  if (!win || BrowserWindow.fromWebContents(event.sender) !== win) return 'unknown';
  if (!Notification.isSupported()) return 'denied';
  return probeNotificationPermission(
    () => new Notification({ title: 'Orbital', body: 'Notifications are on.', silent: true }),
  );
});
// The update prompt (spec 2026-10-08-builds-for-testers-design § The desktop
// app updates itself): a page asks for the state on load, so a reload keeps
// it, and sends the prompt's buttons back; Settings › Updates' Check now asks
// for a check and shows its answer. Only Orbital's own windows are heard.
ipcMain.handle('get-update-state', (event) =>
  fromOrbitalWindow(event.sender) ? updates.view : { phase: 'none', checkedAt: null },
);
ipcMain.on('update-action', (event, payload: unknown) => {
  if (!fromOrbitalWindow(event.sender)) return;
  const action = parseUpdateAction(payload);
  if (action) applyUpdateStep(updates.act(action));
});
ipcMain.handle('check-for-updates', (event) =>
  fromOrbitalWindow(event.sender) ? checkForUpdates(true) : { kind: 'unsupported' },
);
// The renderer is the only thing that changes settings, so it can say so
// exactly. A missed message costs one notification judged by the previous
// rule, or one check by the previous download setting; the next reconnect or
// check corrects it.
ipcMain.on('settings-changed', () => void loadSettings());
// The refused tip's one way out (canvas 1d): System Settings → Notifications.
ipcMain.on('open-notification-settings', () => {
  void shell.openExternal(NOTIFICATION_SETTINGS_URL);
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
