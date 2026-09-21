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
  claudeCli?: { source?: string; path?: string | null; version?: string | null };
};

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

/** URLs the window loads: dev → vite (5173), packaged → the server itself. */
export function windowUrl(dev: boolean, port: number): string {
  // Dev points at vite so HMR keeps working; vite proxies /api and /ws onto
  // the same origin, which is what the web client's origin-relative URLs need.
  return dev ? 'http://127.0.0.1:5173' : `http://127.0.0.1:${port}`;
}

/** The only origins that are Orbital: both `windowUrl` answers, whatever mode. */
function appOrigins(port: number): string[] {
  return [windowUrl(true, port), windowUrl(false, port)].map((url) => new URL(url).origin);
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
