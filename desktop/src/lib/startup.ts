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

/** URLs the window loads: dev → vite (5173), packaged → the server itself. */
export function windowUrl(dev: boolean, port: number): string {
  // Dev points at vite so HMR keeps working; vite proxies /api and /ws onto
  // the same origin, which is what the web client's origin-relative URLs need.
  return dev ? 'http://127.0.0.1:5173' : `http://127.0.0.1:${port}`;
}
