/**
 * What the desktop app should say out loud, decided as a pure fold over the
 * server's `sessions` and `errors` topics.
 *
 * Nothing here may import electron: `main.ts` only asks this class what to show
 * and shows it (spec 2026-09-16-electron-wrapper-design § 4 "Testing").
 *
 * Two facts about the feed shape every rule below:
 *
 * - The server replays nothing on subscribe, but a registry rescan floods
 *   `upsert` frames for sessions that have been sitting in `needs_input` for
 *   hours. So a session's FIRST sighting only ever seeds state — news is a
 *   transition, never a state.
 * - Terminal sessions age out `idle → ended` on a timer. That is the clock
 *   talking, not the session, so only `working → ended` is worth an interruption.
 */

import { basename } from 'node:path';

export type DesktopNotification = { title: string; body: string; sessionId: string | null };

/** The statuses the registry produces; anything else off the wire is ignored. */
const STATUSES = new Set(['working', 'needs_input', 'idle', 'ended']);

const FALLBACK_TITLE = 'Session';

type Known = {
  status: string;
  /** `title ?? basename(cwd)` from the last upsert — status frames carry neither. */
  name: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** The body of a transition worth reporting, or null when it is not one. */
function bodyFor(from: string, to: string): string | null {
  if (from === to) return null;
  if (to === 'needs_input') {
    // A turn ending, a permission prompt and an AskUserQuestion all land here.
    return from === 'working' ? 'Needs your input' : null;
  }
  if (to === 'ended') return from === 'working' ? 'Session ended' : null;
  return null;
}

export class SessionNotifier {
  private seen = new Map<string, Known>();

  /** Feed one parsed frame; returns a notification to show, or null. */
  onEvent(frame: unknown): DesktopNotification | null {
    if (!isRecord(frame)) return null;
    switch (frame.topic) {
      case 'sessions':
        return this.onSessionEvent(frame);
      case 'errors':
        return this.onErrorEvent(frame);
      default:
        return null;
    }
  }

  /** Forget everything (called on WS reconnect — the world replays). */
  reset(): void {
    this.seen.clear();
  }

  private onSessionEvent(frame: Record<string, unknown>): DesktopNotification | null {
    if (frame.event === 'remove') {
      const id = str(frame.sessionId);
      if (id) this.seen.delete(id);
      return null;
    }

    if (frame.event === 'upsert') {
      const session = frame.session;
      if (!isRecord(session)) return null;
      const id = str(session.id);
      if (!id) return null;
      const name = str(session.title) ?? this.cwdName(session.cwd);
      return this.record(id, session.status, name);
    }

    if (frame.event === 'status') {
      const id = str(frame.sessionId);
      if (!id) return null;
      return this.record(id, frame.status, null);
    }

    return null;
  }

  private cwdName(cwd: unknown): string | null {
    const path = str(cwd);
    return path ? (str(basename(path)) ?? null) : null;
  }

  /**
   * Fold one status sighting in. `name`, when given, replaces what we knew —
   * a session gets titled after it starts, so the newest upsert wins.
   */
  private record(id: string, rawStatus: unknown, name: string | null): DesktopNotification | null {
    const status = str(rawStatus);
    const known = this.seen.get(id);

    if (!known) {
      // Unknown status on a first sighting: remember the name, but do not
      // invent a state we would later report a transition away from.
      if (!status || !STATUSES.has(status)) return null;
      this.seen.set(id, { status, name });
      return null;
    }

    if (name) known.name = name;
    if (!status || !STATUSES.has(status)) return null;

    const body = bodyFor(known.status, status);
    known.status = status;
    if (!body) return null;
    return { title: known.name ?? FALLBACK_TITLE, body, sessionId: id };
  }

  private onErrorEvent(frame: Record<string, unknown>): DesktopNotification | null {
    if (frame.event !== 'error') return null; // 'seen' frames are bookkeeping
    const error = frame.error;
    if (!isRecord(error)) return null;
    // A session that dies is not a status; it arrives here (server index.ts).
    if (error.kind !== 'session_failed') return null;
    const message = str(error.message);
    if (!message) return null;

    const sessionId = str(error.sessionId);
    const name = sessionId ? this.seen.get(sessionId)?.name : null;
    return {
      title: name ?? FALLBACK_TITLE,
      // Stack traces and multi-line detail do not fit a notification body.
      body: `Session failed: ${str(message.split('\n')[0]) ?? message}`,
      sessionId,
    };
  }
}
