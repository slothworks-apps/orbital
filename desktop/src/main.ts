import { app, BrowserWindow, dialog, utilityProcess, type UtilityProcess } from 'electron';
import { join } from 'node:path';
import { probeHealth } from './lib/probe';
import { decideStartup, needsCliPrompt, windowUrl, type HealthInfo } from './lib/startup';

const PORT = Number(process.env.ORBITAL_PORT ?? 4737);
const DEV = process.env.ORBITAL_DESKTOP_DEV === '1';

const HEALTH_POLL_INTERVAL_MS = 200;
// The server resolves the login shell's PATH and probes the CLI's version
// before it listens, which can take seconds on a cold machine.
const HEALTH_POLL_TIMEOUT_MS = 15_000;

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

let win: BrowserWindow | null = null;
let child: UtilityProcess | null = null;
/** True only when this process forked the server — shutdown kills only that. */
let forked = false;
let quitting = false;

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
    } as NodeJS.ProcessEnv,
  });

  proc.on('exit', (code) => {
    // `child !== proc` means we replaced this one deliberately (a restart, or
    // the re-fork after picking a CLI path), so its death is not news.
    if (quitting || child !== proc) return;
    child = null;
    void reportServerDeath(code);
  });

  return proc;
}

/** Poll until the server answers as Orbital, or give up. */
async function waitForHealth(): Promise<HealthInfo | null> {
  const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
  for (;;) {
    const outcome = await probeHealth(PORT);
    if (outcome.kind === 'orbital') return outcome.health;
    if (Date.now() >= deadline) return null;
    await delay(HEALTH_POLL_INTERVAL_MS);
  }
}

function serverStartFailed(): void {
  const fate = child ? 'It is still running but never answered.' : 'It exited before it answered.';
  dialog.showErrorBox(
    'Orbital’s server did not start',
    `${serverEntry}\n\n${fate}\n\nRun \`npm run build -w server\` and try again; the server's output is in this app's console.`,
  );
  app.quit();
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

  child = forkServer();
  if (!(await waitForHealth())) {
    serverStartFailed();
    return;
  }
  void win?.loadURL(windowUrl(DEV, PORT));
}

/** Kill the current child and start a fresh one, waiting for both halves. */
async function restartServer(): Promise<boolean> {
  const old = child;
  child = null; // marks the kill below as deliberate for the 'exit' handler
  if (old) {
    await new Promise<void>((resolve) => {
      old.once('exit', () => resolve());
      old.kill();
    });
  }
  child = forkServer();
  return (await waitForHealth()) !== null;
}

/**
 * A missing CLI is a designed state (spec § 3): say so, offer to point at it,
 * and open the map either way.
 */
async function promptForCli(): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: 'The Claude Code CLI was not found',
    detail:
      'Orbital spawns sessions through the Claude Code CLI installed on this Mac. Until it can find one, the map still opens but no session can be started.',
    buttons: ['Choose executable…', 'Continue anyway'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;

  const picked = await dialog.showOpenDialog({
    title: 'Choose the claude executable',
    properties: ['openFile', 'showHiddenFiles'],
  });
  if (picked.canceled || picked.filePaths.length === 0) return;

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
    return;
  }

  // The server reads claude_executable_path once, at boot — so the PATCH has to
  // land before the restart, never after.
  if (!(await restartServer())) {
    serverStartFailed();
  }
}

function openWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
    },
  });
  win.on('closed', () => {
    win = null;
  });
  void win.loadURL(windowUrl(DEV, PORT));
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
      child = forkServer();
      forked = true;
      const up = await waitForHealth();
      if (!up) {
        serverStartFailed();
        return;
      }
      health = up;
      break;
    }

    case 'attach':
      // Someone else's server. We neither started it nor may kill it (spec § 1).
      break;
  }

  if (needsCliPrompt(health, forked)) await promptForCli();

  openWindow();
}

void app.whenReady().then(start);

// v1 rule: closing the window quits the app. This separates when the tray
// item lands (spec § 1 "Closing the window").
app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  if (forked && child) {
    child.kill();
    child = null;
  }
});
