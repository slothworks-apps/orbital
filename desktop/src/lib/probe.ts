import { classifyProbe, type ProbeOutcome } from './startup';

/** How long one probe waits before it counts as nothing listening. */
const PROBE_TIMEOUT_MS = 1000;

/**
 * One `GET /api/health` against 127.0.0.1, classified.
 *
 * Thin glue on purpose: every decision it feeds lives in `startup.ts`, which is
 * what the tests exercise.
 */
export async function probeHealth(port: number): Promise<ProbeOutcome> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return classifyProbe({ ok: res.ok, body: await res.json().catch(() => null) });
  } catch {
    return classifyProbe({ error: true });
  }
}
