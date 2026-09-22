/**
 * Background mode: what a window close means, what a quit costs, and which
 * sessions that cost would fall on
 * (spec: 2026-09-22-desktop-background-mode-design).
 *
 * Nothing here may import electron — `main.ts` is the shell that acts on
 * these answers (spec 2026-09-16-electron-wrapper-design § 4 "Testing").
 */

export type WindowCloseDecision =
  | 'hide' // the window stays alive: reopening is instant and the map is untouched
  | 'close'; // a real teardown, which only a quit asks for

/**
 * The red button and ⌘W hide rather than close, so the renderer survives and
 * the server keeps running. Only a quit lets the window actually go.
 */
export function decideWindowClose(state: { quitting: boolean }): WindowCloseDecision {
  return state.quitting ? 'close' : 'hide';
}

export type QuitDecision =
  | 'confirm' // a quit would kill work: ask before doing it
  | 'quit'; // nothing of ours dies, so say nothing

/**
 * Quitting kills the forked server, and with it every session Orbital is
 * running — so it is guarded exactly when there is something to lose. In
 * attach mode the server is the user's own and outlives the app, so however
 * many sessions are mid-turn, none of them die with this process.
 */
export function decideQuit(state: { forked: boolean; workingCount: number }): QuitDecision {
  if (!state.forked) return 'quit';
  return state.workingCount > 0 ? 'confirm' : 'quit';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The sessions a quit would kill, folded out of the `sessions` topic.
 *
 * Only orbital-run sessions count: a terminal session belongs to the CLI in
 * someone's shell, and the server's death does not reach it. Everything comes
 * off the wire, so every frame is read defensively — a shape we did not expect
 * must cost a count, never the main process.
 */
export class WorkingSessions {
  private ids = new Set<string>();

  /** How many orbital-run sessions are mid-turn right now. */
  get count(): number {
    return this.ids.size;
  }

  /** Feed one parsed frame; anything that is not ours is ignored. */
  onFrame(frame: unknown): void {
    if (!isRecord(frame) || frame.topic !== 'sessions') return;

    if (frame.event === 'remove') {
      if (typeof frame.sessionId === 'string') this.ids.delete(frame.sessionId);
      return;
    }

    if (frame.event === 'status') {
      // The runner is the only publisher of these on this topic — the registry
      // always sends a terminal session as a full upsert — so every status
      // frame is an orbital-run session by construction, and the `source` they
      // do not carry is neither needed nor available. Without this branch the
      // guard goes stale: a turn starting and ending is announced only here.
      const id = frame.sessionId;
      if (typeof id !== 'string' || id === '') return;
      if (frame.status === 'working') this.ids.add(id);
      else this.ids.delete(id);
      return;
    }

    if (frame.event !== 'upsert') return;
    const session = frame.session;
    if (!isRecord(session)) return;
    const id = session.id;
    if (typeof id !== 'string' || id === '') return;
    // The frame carries the session's current state, so it decides membership
    // in both directions — a session that stopped working leaves the set here.
    if (session.source === 'web' && session.status === 'working') this.ids.add(id);
    else this.ids.delete(id);
  }

  /** Forget everything (called on WS reconnect — the world replays). */
  reset(): void {
    this.ids.clear();
  }
}
