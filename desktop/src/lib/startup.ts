/**
 * Every startup decision the desktop app makes, as plain functions.
 *
 * Electron is awkward to test, so nothing here may import it: `main.ts` is a
 * decision-free shell around this module
 * (spec 2026-09-16-electron-wrapper-design § 4 "Testing").
 */

/** The shape of `GET /api/health`, read defensively — it comes off the wire. */
export type HealthInfo = {
  app?: unknown;
  /** True when that server has a built web app to serve; false on a dev server. */
  static?: boolean;
  claudeCli?: { source?: string; path?: string | null; version?: string | null };
  /** The build the server runs, from its `ORBITAL_VERSION`; null on one started by hand. Token-only. */
  version?: unknown;
  /** Set only on a server a desktop app forked: its own pid and the app's. Token-only. */
  desktop?: unknown;
};

/** Who forked a server, read off its health; null when no desktop app did (or it did not say). */
export function desktopOwner(health: HealthInfo): { pid: number; parentPid: number } | null {
  const d = health.desktop;
  if (typeof d !== 'object' || d === null) return null;
  const { pid, parentPid } = d as { pid?: unknown; parentPid?: unknown };
  const isPid = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;
  return isPid(pid) && isPid(parentPid) ? { pid, parentPid } : null;
}

export type AttachDecision =
  | 'attach' // use the server that answered, as before
  | 'replace' // an orphan of a desktop app that is gone: stop it and fork our own
  | 'refuse'; // another running Orbital app's server, of another version: say so and quit

/**
 * What to do with an Orbital server that already answers on the port.
 *
 * The rule:
 * - The dev shell (`ORBITAL_DESKTOP_DEV`) always attaches: it never forks, and
 *   the server is the user's `npm run dev`.
 * - A server no desktop app forked is the user's own — `npm run dev`, or a
 *   server they started by hand — and is attached to whatever its version, as
 *   it always was; we did not start it, so we may not stop it. A server forked
 *   before servers named their parent reads the same way, so a stray one of
 *   those is still adopted.
 * - A server a desktop app forked whose app is gone is an orphan of a crash or
 *   a force-quit. It is replaced whatever its version: it would stop itself
 *   within seconds anyway, as soon as it notices its parent is gone, and
 *   nobody would be there to restart it.
 * - One whose app is still running belongs to another copy of Orbital. The
 *   same version is attached to, as a second window onto the same server; a
 *   different one is refused, since its server is not ours to stop and this
 *   build must not run against it.
 *
 * `parentAlive` is asked of the owner's `parentPid` by the caller.
 */
export function decideAttach(input: {
  dev: boolean;
  appVersion: string;
  health: HealthInfo;
  parentAlive: boolean;
}): AttachDecision {
  if (input.dev) return 'attach';
  if (!desktopOwner(input.health)) return 'attach';
  if (!input.parentAlive) return 'replace';
  return input.health.version === input.appVersion ? 'attach' : 'refuse';
}

export type ProbeOutcome =
  | { kind: 'orbital'; health: HealthInfo } // port answered and it is us
  | { kind: 'refused' } // nothing listening (fetch threw)
  | { kind: 'other' }; // something answered that is not orbital

/** Classify a probe response. ok=false or unparseable/foreign body → 'other'. */
export function classifyProbe(
  result: { error: true } | { ok: boolean; body: unknown },
): ProbeOutcome {
  if ('error' in result) return { kind: 'refused' };
  if (!result.ok) return { kind: 'other' };

  const body = result.body;
  if (typeof body !== 'object' || body === null) return { kind: 'other' };

  const health = body as HealthInfo;
  if (health.app !== 'orbital') return { kind: 'other' };

  return { kind: 'orbital', health };
}

export type StartupDecision = 'attach' | 'fork' | 'occupied';

/** orbital → attach; refused → fork; other → occupied (spec §1: never fork onto a foreign service). */
export function decideStartup(outcome: ProbeOutcome): StartupDecision {
  switch (outcome.kind) {
    case 'orbital':
      return 'attach';
    case 'refused':
      return 'fork';
    case 'other':
      return 'occupied';
  }
}

/** The missing-CLI dialog shows only when WE forked the server (attach mode = the user's own dev server, their terminal already tells them) and health says missing. */
export function needsCliPrompt(health: HealthInfo, forked: boolean): boolean {
  if (!forked) return false;
  return health.claudeCli?.source === 'missing';
}

export type ChildExitAction =
  | 'ignore' // we killed it, or we are on our way out
  | 'abort-start' // it died while someone is still waiting for it to come up
  | 'offer-restart'; // it died under a running app — the designed "server stopped" state

/**
 * What a forked server's death means, given what the app was doing at the time.
 *
 * `awaitingStart` is the load-bearing one: during a fork-and-wait the waiting
 * code owns the failure, so the death must not also raise the "server stopped"
 * dialog — otherwise a server that dies before it ever answers stacks that
 * modal under the start-failure one, and its restart path has no window to
 * reload (spec § 1 wants one clear error state, not two).
 */
export function classifyChildExit(state: {
  quitting: boolean;
  current: boolean;
  awaitingStart: boolean;
}): ChildExitAction {
  if (state.quitting) return 'ignore';
  if (!state.current) return 'ignore'; // already replaced: we killed it deliberately
  if (state.awaitingStart) return 'abort-start';
  return 'offer-restart';
}

/**
 * Where vite serves the web app in the dev topology, proxying /api and /ws onto
 * its own origin — which is what the web client's origin-relative URLs need.
 *
 * `localhost`, not `127.0.0.1`: vite's default host binds `::1` only, so the
 * literal IPv4 address is refused.
 */
export const VITE_URL = 'http://localhost:4839';

/** The server's own origin, where it serves the built web app when it has one. */
export function serverUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export type WindowTarget =
  | { kind: 'vite'; url: string } // HMR in dev, or the web app of a dev server we attached to
  | { kind: 'server'; url: string } // the server serves the built app same-origin
  | { kind: 'no-ui' }; // nothing anywhere serves a web app — say so, do not open a window

/**
 * Where the window goes, once we know what the server on the port actually is.
 *
 * The fallback is the whole point: attaching to someone's `npm run dev` gives
 * us a server with no `ORBITAL_STATIC_DIR`, whose `/` is fastify's JSON 404.
 * That topology's web app lives on vite, so the window belongs there.
 */
export function decideWindowTarget(input: {
  dev: boolean;
  port: number;
  serverServesStatic: boolean;
  viteReachable: boolean;
}): WindowTarget {
  if (input.dev) return { kind: 'vite', url: VITE_URL };
  if (input.serverServesStatic) return { kind: 'server', url: serverUrl(input.port) };
  if (input.viteReachable) return { kind: 'vite', url: VITE_URL };
  return { kind: 'no-ui' };
}

/** The only origins that are Orbital: every window target, whatever mode. */
export function appOrigins(port: number): string[] {
  // Both spellings of loopback for vite: which one it binds is its own config's
  // business, and either way a dev server on vite's port is ours.
  const vitePort = new URL(VITE_URL).port;
  return [VITE_URL, `http://127.0.0.1:${vitePort}`, serverUrl(port)].map((url) => new URL(url).origin);
}

export type NavigationDecision =
  | 'allow' // Orbital's own origin — the window may follow it itself
  | 'external' // a web page: hand it to the user's browser instead
  | 'deny'; // neither — swallow it

/**
 * What the desktop window may do with a URL it is asked to navigate to.
 *
 * Assistant prose autolinks bare URLs and the renderer passes them through as
 * plain anchors, which is right in a browser tab — the user presses Back. This
 * window has no Back, and the remote page would load with the preload
 * attached, so anything that is not Orbital's own origin leaves the app.
 *
 * Only http(s) is handed to the browser: `shell.openExternal` will launch a
 * handler application for other schemes, which is the same class of hole this
 * function exists to close.
 */
export function decideNavigation(url: string, port: number): NavigationDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'deny';
  }
  if (appOrigins(port).includes(parsed.origin)) return 'allow';
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return 'external';
  return 'deny';
}
