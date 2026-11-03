/**
 * `POST /api/sessions` made idempotent on the id the client minted. A
 * phone's tunnel can give up on a launch that is still running — a worktree
 * launch checks out a whole tree — and the phone asks again with the same
 * id. The second ask must not launch a second session or make a second
 * worktree: it gets the first one's answer, waiting for it while it runs.
 *
 * A launch that succeeded is answered again for `REPLAY_MS`; one that failed
 * left nothing behind and is forgotten as soon as it settles, so asking again
 * tries again. The same id with a different body is not a repeat: it is
 * refused as a taken id, as before.
 */

/** How long a successful launch is answered again to a repeat of its request. */
export const REPLAY_MS = 10 * 60_000;

export interface LaunchAnswer {
  status: number;
  body: unknown;
}

interface Entry {
  fingerprint: string;
  answer: Promise<LaunchAnswer>;
}

export class LaunchReplays {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly replayMs = REPLAY_MS) {}

  /**
   * The answer to a repeat of the launch of `id`: the first launch's,
   * pending while it runs. `'mismatch'` when `id` is launching or launched
   * with another body; null when it is not known here.
   */
  replay(id: string, body: unknown): Promise<LaunchAnswer> | 'mismatch' | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    return entry.fingerprint === fingerprintOf(body) ? entry.answer : 'mismatch';
  }

  /** Remembers the launch of `id` while it runs, and after it while it succeeded. */
  track(id: string, body: unknown, answer: Promise<LaunchAnswer>): Promise<LaunchAnswer> {
    const entry: Entry = { fingerprint: fingerprintOf(body), answer };
    this.entries.set(id, entry);
    const forget = () => {
      if (this.entries.get(id) === entry) this.entries.delete(id);
    };
    answer.then(
      (a) => {
        if (a.status >= 300) return forget();
        setTimeout(forget, this.replayMs).unref?.();
      },
      forget,
    );
    return answer;
  }
}

function fingerprintOf(body: unknown): string {
  return JSON.stringify(body ?? null);
}
