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
 *   hours. So a session's first sighting in an upsert seeds state — news is
 *   a transition, never a state — unless the session was active after this
 *   notifier started listening, which no replay can be. A status frame is
 *   only ever sent for a change, so even a first one is a transition.
 * - Nothing ends on a timer any more (spec
 *   2026-09-24-sessions-end-only-by-hand-design): an Orbital session ends when
 *   the user ends it, a terminal session when its CLI exits. An end from a
 *   quiet state is one the user made or already expected, so only
 *   `working → ended` — a session stopping mid-turn — is worth an interruption.
 */

import type { NotificationSettings } from './remote/messages.js';

// `NotificationSettings` is declared once, in messages.ts (shared with the
// wire schema); re-exported here so `@orbital/shared/notifications` still
// offers the name its consumers import.
export type { NotificationSettings };

// This file is bundled for a phone's WebView too, where `node:path` does not
// exist — a local helper instead of the Node builtin.
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

export type SessionNotification = { title: string; body: string; sessionId: string | null };
/** @deprecated kept so the desktop's existing imports still resolve. */
export type DesktopNotification = SessionNotification;

/**
 * Silence by default (spec 2026-10-08-notifications-off-by-default-design § 1,
 * `docs/why-orbital.md`): every event and the sound start off. "Only when
 * Orbital is in the background" stays on — it notifies nothing by itself, it
 * only filters what the rows above it let through.
 *
 * An absent key reads as this default, so an event or the sound is on only
 * for the literal string 'true', and background-only is off only for
 * 'false'. Installs from before this change had their values written out by
 * migration `0027_notifications_off_by_default`, so none of them reads
 * differently for it.
 */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  needsInput: false,
  sessionEnded: false,
  sessionFailed: false,
  onlyWhenBackground: true,
  sound: false,
};

/** The settings rows behind `NotificationSettings`, by field. */
export const NOTIFICATION_SETTING_KEYS = {
  needsInput: 'notify_needs_input',
  sessionEnded: 'notify_session_ended',
  sessionFailed: 'notify_session_failed',
  onlyWhenBackground: 'notify_only_when_background',
  sound: 'notify_sound',
} as const satisfies Record<keyof NotificationSettings, string>;

export function parseNotificationSettings(raw: unknown): NotificationSettings {
  if (!isRecord(raw)) return DEFAULT_NOTIFICATION_SETTINGS;
  const on = (key: string): boolean => raw[key] === 'true';
  return {
    needsInput: on(NOTIFICATION_SETTING_KEYS.needsInput),
    sessionEnded: on(NOTIFICATION_SETTING_KEYS.sessionEnded),
    sessionFailed: on(NOTIFICATION_SETTING_KEYS.sessionFailed),
    onlyWhenBackground: raw[NOTIFICATION_SETTING_KEYS.onlyWhenBackground] !== 'false',
    sound: on(NOTIFICATION_SETTING_KEYS.sound),
  };
}

/**
 * Whether nothing would ever notify or make a sound: the condition for the
 * tip and for the one line at the top of Settings → Notifications (canvas
 * `Feature - Notifications off` 1c). Background-only does not count, it
 * filters and never notifies.
 */
export function notificationsAllOff(s: NotificationSettings): boolean {
  return !s.needsInput && !s.sessionEnded && !s.sessionFailed && !s.sound;
}

/**
 * What the tip's Turn on switches on (spec § 3, canvas 1b, phone 2c): the two
 * events that are worth an interruption. Sound and Session ended stay off.
 */
export const NOTIFICATIONS_TURN_ON = { needsInput: true, sessionFailed: true } as const satisfies Partial<NotificationSettings>;

/**
 * The desktop tip's settings row: `pending` while it may still be offered,
 * `ended` once it has gone for good (spec § 2, § 3). A fresh install seeds
 * `pending`; the migration writes `ended` for an install that existed before,
 * and changing any notification row ends it server-side. Anything else reads
 * as ended, so a tip can never come back by accident.
 */
export const NOTIFICATIONS_TIP_KEY = 'notify_tip';
export const NOTIFICATIONS_TIP_PENDING = 'pending';
export const NOTIFICATIONS_TIP_ENDED = 'ended';

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

/** The body of a `working → needs_input` transition; a consumer that words it its own way compares against this. */
export const NEEDS_INPUT_BODY = 'Needs your input';

/** The body of a transition worth reporting, or null when it is not one. */
function bodyFor(from: string, to: string): string | null {
  if (from === to) return null;
  if (to === 'needs_input') {
    // A turn ending, a permission prompt and an AskUserQuestion all land here.
    return from === 'working' ? NEEDS_INPUT_BODY : null;
  }
  if (to === 'ended') return from === 'working' ? 'Session ended' : null;
  return null;
}

export class SessionNotifier {
  private seen = new Map<string, Known>();
  private settings: NotificationSettings = DEFAULT_NOTIFICATION_SETTINGS;
  /** When this notifier began listening; an upsert active after it is not a replay. */
  private since: number;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.since = now();
  }

  /** Feed one parsed frame; returns a notification to show, or null. */
  onEvent(frame: unknown): SessionNotification | null {
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

  /**
   * Replace the settings. `main.ts` calls this on startup, on every socket
   * reconnect and whenever the renderer says they changed — never mid-fold,
   * so a frame is always judged by one coherent set.
   */
  setSettings(settings: NotificationSettings): void {
    this.settings = settings;
  }

  /** What `main.ts` needs but cannot parse: the two rows it acts on itself. */
  get current(): NotificationSettings {
    return this.settings;
  }

  /** Forget everything (called on WS reconnect — the world replays). */
  reset(): void {
    this.seen.clear();
    this.since = this.now();
  }

  private onSessionEvent(frame: Record<string, unknown>): SessionNotification | null {
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
      // A rescan replays sessions that have waited for hours; one whose last
      // activity is newer than this notifier asked while we were listening.
      const fresh = typeof session.lastAt === 'number' && session.lastAt >= this.since;
      return this.record(id, session.status, name, fresh);
    }

    if (frame.event === 'status') {
      const id = str(frame.sessionId);
      if (!id) return null;
      // The server sends a status frame only when a status changes, never
      // as a replay, so even a first sighting is a transition.
      return this.record(id, frame.status, null, true);
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
   * `fresh` says a first sighting happened while this notifier listened, so
   * a question in it is news rather than a baseline.
   */
  private record(id: string, rawStatus: unknown, name: string | null, fresh: boolean): SessionNotification | null {
    const status = str(rawStatus);
    const known = this.seen.get(id);

    if (!known) {
      // Unknown status on a first sighting: remember the name, but do not
      // invent a state we would later report a transition away from.
      if (!status || !STATUSES.has(status)) return null;
      this.seen.set(id, { status, name });
      // Only a question: a first sighting that is already `ended` has no
      // `working` before it to say it stopped mid-turn.
      if (!fresh || status !== 'needs_input' || !this.settings.needsInput) return null;
      return { title: name ?? FALLBACK_TITLE, body: NEEDS_INPUT_BODY, sessionId: id };
    }

    if (name) known.name = name;
    if (!status || !STATUSES.has(status)) return null;

    const body = bodyFor(known.status, status);
    known.status = status;
    if (!body) return null;
    // Muted AFTER the fold, and gated on the transition rather than on the
    // body text: `seen` stays true either way, so turning a row back on
    // reports the next transition instead of replaying a stale one.
    if (status === 'needs_input' && !this.settings.needsInput) return null;
    if (status === 'ended' && !this.settings.sessionEnded) return null;
    return { title: known.name ?? FALLBACK_TITLE, body, sessionId: id };
  }

  private onErrorEvent(frame: Record<string, unknown>): SessionNotification | null {
    if (frame.event !== 'error') return null; // 'seen' frames are bookkeeping
    const error = frame.error;
    if (!isRecord(error)) return null;
    // A session that dies is not a status; it arrives here (server index.ts).
    if (error.kind !== 'session_failed') return null;
    // Nothing to fold for a failure — it carries no state this class keeps —
    // so unlike the transitions above, this one can bail early.
    if (!this.settings.sessionFailed) return null;
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
