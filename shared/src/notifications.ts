/**
 * What the desktop app should say out loud, decided as a pure fold over the
 * server's `sessions` and `errors` topics.
 *
 * Nothing here may import electron: `main.ts` only hands this class the
 * frames and shows what it reports (spec 2026-09-16-electron-wrapper-design
 * § 4 "Testing").
 *
 * Three facts about the feed shape every rule below:
 *
 * - The server replays nothing on subscribe, but a registry rescan floods
 *   `upsert` frames for sessions that have been sitting in `needs_input` for
 *   hours. So a session's first sighting in an upsert seeds state — news is
 *   a transition, never a state — unless the session was active after this
 *   notifier started listening, which no replay can be. A status frame is
 *   only ever sent for a change, so even a first one is a transition.
 * - `needs_input` is two things (ADR a-finished-turn-is-done-not-needs-input):
 *   something parked on the human, or a turn that merely finished — and a
 *   turn often ends only for a moment, the harness or a background agent
 *   starting the next one at once. So a `needs_input` transition is held for
 *   `NEEDS_INPUT_SETTLE_MS` and dropped if the session moves on; one that
 *   settles is reported as needing input or as Done by what the session's
 *   latest upsert says it wants, the same split the map makes.
 * - Nothing ends on a timer any more (spec
 *   2026-09-24-sessions-end-only-by-hand-design): an Orbital session ends when
 *   the user ends it, a terminal session when its CLI exits. An end from a
 *   quiet state is one the user made or already expected, so only
 *   `working → ended` — a session stopping mid-turn — is worth an interruption.
 */

import { asksForHuman } from './parked.js';
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
  /** The last upsert asks for the human (`asksForHuman`): a decision parked, or a gate waiting. */
  asks: boolean;
  /** The last upsert's harness gate is with its reviewer, who comes back to the session on its own. */
  reviewing: boolean;
  /**
   * The last upsert says the user docked it: put away, and silent whatever
   * the settings say (spec 2026-10-19-docked-sessions-design § Notifications).
   */
  docked: boolean;
  /** Cancels the held `needs_input` report, while one is held. */
  held: (() => void) | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** The body of a `needs_input` report: something is parked on the human. */
const NEEDS_INPUT_BODY = 'Needs your input';
/** The body of a `done` report: a turn that merely finished, the next move is the user's. */
const DONE_BODY = 'Done';
const ENDED_BODY = 'Session ended';

/**
 * How long a session must stay in `needs_input` before it is reported (ADR
 * a-finished-turn-is-done-not-needs-input). A turn often ends only for a
 * moment — the harness sends its next step at once, the CLI wakes itself for
 * a finished background agent — and a session that is working again by the
 * time the user looks did not need them.
 */
export const NEEDS_INPUT_SETTLE_MS = 3000;

/**
 * What a report is about: a session waiting on the human, a turn that
 * finished, a session that stopped mid-turn, or one that died. A consumer
 * words or styles a report by its kind; the body is text to show, not a key.
 */
export type SessionNotificationKind = 'needs_input' | 'done' | 'ended' | 'failed';

export type SessionNotification = {
  kind: SessionNotificationKind;
  title: string;
  body: string;
  sessionId: string | null;
};
/** @deprecated kept so the desktop's existing imports still resolve. */
export type DesktopNotification = SessionNotification;

export type SessionNotifierOptions = {
  /**
   * Called with every report. An `ended` or `failed` one is reported from
   * inside the `onEvent` that caused it; a `needs_input` or `done` one later,
   * from the timer `schedule` set, once the session has settled.
   */
  notify: (n: SessionNotification) => void;
  /** The clock behind `since` and an upsert's freshness. */
  now?: () => number;
  /** Runs `fn` after `ms` and returns what cancels it; `setTimeout` by default. */
  schedule?: (fn: () => void, ms: number) => () => void;
};

function scheduleWithTimeout(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
}

/**
 * Which status changes are worth anything: `working → needs_input` is held
 * and judged once it settles (`held`), `working → ended` is reported at once
 * (`ended`), anything else is not news.
 */
function transition(from: string, to: string): 'held' | 'ended' | null {
  if (from === to || from !== 'working') return null;
  // A turn ending, a permission prompt, an AskUserQuestion and a harness gate
  // all land in `needs_input`; which of them it was is decided when it
  // settles, from the upsert that carries the why (`settled`).
  if (to === 'needs_input') return 'held';
  if (to === 'ended') return 'ended';
  return null;
}

export class SessionNotifier {
  private seen = new Map<string, Known>();
  private settings: NotificationSettings = DEFAULT_NOTIFICATION_SETTINGS;
  /** When this notifier began listening; an upsert active after it is not a replay. */
  private since: number;
  private readonly now: () => number;
  private readonly notify: (n: SessionNotification) => void;
  private readonly schedule: (fn: () => void, ms: number) => () => void;

  constructor(options: SessionNotifierOptions) {
    this.notify = options.notify;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? scheduleWithTimeout;
    this.since = this.now();
  }

  /** Feed one parsed frame; whatever it makes worth saying goes to `notify`, now or once it settles. */
  onEvent(frame: unknown): void {
    if (!isRecord(frame)) return;
    switch (frame.topic) {
      case 'sessions':
        this.onSessionEvent(frame);
        return;
      case 'errors':
        this.onErrorEvent(frame);
        return;
      default:
        return;
    }
  }

  /**
   * Fold in a session read some other way than the feed — a list fetched at
   * start or after a reconnect — as a baseline: it never reports, now or
   * later, so a session found already waiting stays quiet.
   */
  seed(session: unknown): void {
    if (!isRecord(session)) return;
    const id = str(session.id);
    if (!id) return;
    this.record(id, session.status, this.nameOf(session), false, session, false);
  }

  /**
   * Replace the settings. `main.ts` calls this on startup, on every socket
   * reconnect and whenever the renderer says they changed — never mid-fold,
   * so a frame is always judged by one coherent set. A held report reads
   * them when it settles, not when it was held.
   */
  setSettings(settings: NotificationSettings): void {
    this.settings = settings;
  }

  /** What `main.ts` needs but cannot parse: the two rows it acts on itself. */
  get current(): NotificationSettings {
    return this.settings;
  }

  /** Forget everything, held reports included (called on WS reconnect — the world replays). */
  reset(): void {
    this.dispose();
    this.since = this.now();
  }

  /** Cancel every held report and forget every session; for a notifier being thrown away. */
  dispose(): void {
    for (const known of this.seen.values()) known.held?.();
    this.seen.clear();
  }

  private onSessionEvent(frame: Record<string, unknown>): void {
    if (frame.event === 'remove') {
      const id = str(frame.sessionId);
      if (!id) return;
      this.seen.get(id)?.held?.();
      this.seen.delete(id);
      return;
    }

    if (frame.event === 'upsert') {
      const session = frame.session;
      if (!isRecord(session)) return;
      const id = str(session.id);
      if (!id) return;
      // A rescan replays sessions that have waited for hours; one whose last
      // activity is newer than this notifier asked while we were listening.
      const fresh = typeof session.lastAt === 'number' && session.lastAt >= this.since;
      this.record(id, session.status, this.nameOf(session), fresh, session, true);
      return;
    }

    if (frame.event === 'status') {
      const id = str(frame.sessionId);
      if (!id) return;
      // The server sends a status frame only when a status changes, never
      // as a replay, so even a first sighting is a transition.
      this.record(id, frame.status, null, true, null, true);
    }
  }

  private nameOf(session: Record<string, unknown>): string | null {
    return str(session.title) ?? this.cwdName(session.cwd);
  }

  private cwdName(cwd: unknown): string | null {
    const path = str(cwd);
    return path ? (str(basename(path)) ?? null) : null;
  }

  /**
   * Fold one status sighting in. `name`, when given, replaces what we knew —
   * a session gets titled after it starts, so the newest upsert wins; so does
   * what `session` (an upsert's, null for a status frame) says it wants.
   * `fresh` says a first sighting happened while this notifier listened, so
   * a question in it is news rather than a baseline; `reports` is false for a
   * `seed`, which folds the same way and never says anything.
   */
  private record(
    id: string,
    rawStatus: unknown,
    name: string | null,
    fresh: boolean,
    session: Record<string, unknown> | null,
    reports: boolean,
  ): void {
    const status = str(rawStatus);
    let known = this.seen.get(id);

    if (!known) {
      // Unknown status on a first sighting: remember the name, but do not
      // invent a state we would later report a transition away from.
      if (!status || !STATUSES.has(status)) return;
      known = { status, name, asks: false, reviewing: false, docked: false, held: null };
      this.seen.set(id, known);
      if (session) this.wants(known, session);
      // Only a question: a first sighting that is already `ended` has no
      // `working` before it to say it stopped mid-turn.
      if (reports && fresh && status === 'needs_input') this.hold(id, known);
      return;
    }

    if (name) known.name = name;
    const asked = known.asks;
    if (session) this.wants(known, session);
    if (!status || !STATUSES.has(status)) return;

    const from = known.status;
    known.status = status;
    // Leaving `needs_input` before it settled: the turn ended only for a moment.
    if (status !== 'needs_input' && known.held) {
      known.held();
      known.held = null;
    }
    // A session that stayed in `needs_input` and asks only now — a gate the
    // reviewer handed back, a question after a Done — has no transition to
    // carry it, and what settled before said Done or nothing: hold it again,
    // so it settles as needing input. One that already asked was reported.
    const lateAsk = from === 'needs_input' && status === 'needs_input' && !known.held && !asked && known.asks;
    const change = !reports ? null : lateAsk ? 'held' : transition(from, status);
    if (change === 'held') this.hold(id, known);
    // Muted AFTER the fold, and gated on the transition rather than on the
    // body text: `seen` stays current either way, so turning a row back on
    // reports the next transition instead of replaying a stale one.
    else if (change === 'ended' && this.settings.sessionEnded && !known.docked) {
      this.notify({ kind: 'ended', title: known.name ?? FALLBACK_TITLE, body: ENDED_BODY, sessionId: id });
    }
  }

  /** What an upsert says the session wants from the human; read when a held report settles. */
  private wants(known: Known, session: Record<string, unknown>): void {
    known.asks = asksForHuman(session);
    known.reviewing = session.harnessGate === 'reviewing';
    known.docked = typeof session.dockedAt === 'number';
  }

  /** Hold a `needs_input` report until it settles; one held report per session. */
  private hold(id: string, known: Known): void {
    known.held?.();
    known.held = this.schedule(() => {
      known.held = null;
      // Only the object this timer was set for: a `remove` or a reset forgets it.
      if (this.seen.get(id) !== known || known.status !== 'needs_input') return;
      this.settled(id, known);
    }, NEEDS_INPUT_SETTLE_MS);
  }

  /**
   * A session that stayed in `needs_input`: its latest upsert says why (ADR
   * a-finished-turn-is-done-not-needs-input, the same `asksForHuman` the
   * map splits NEEDS INPUT from DONE with). Something parked on the human — a decision, a
   * harness gate waiting for an OK — needs their input; a gate the reviewer
   * is reading comes back to the session on its own, so it is no news; any
   * other turn merely finished, and is Done. Both answer to the needsInput row.
   */
  private settled(id: string, known: Known): void {
    if (!this.settings.needsInput || known.docked) return;
    const title = known.name ?? FALLBACK_TITLE;
    if (known.asks) {
      this.notify({ kind: 'needs_input', title, body: NEEDS_INPUT_BODY, sessionId: id });
    } else if (!known.reviewing) {
      this.notify({ kind: 'done', title, body: DONE_BODY, sessionId: id });
    }
  }

  private onErrorEvent(frame: Record<string, unknown>): void {
    if (frame.event !== 'error') return; // 'seen' frames are bookkeeping
    const error = frame.error;
    if (!isRecord(error)) return;
    // A session that dies is not a status; it arrives here (server index.ts).
    if (error.kind !== 'session_failed') return;
    // Nothing to fold for a failure — it carries no state this class keeps —
    // so unlike the transitions above, this one can bail early.
    if (!this.settings.sessionFailed) return;
    const message = str(error.message);
    if (!message) return;

    const sessionId = str(error.sessionId);
    const name = sessionId ? this.seen.get(sessionId)?.name : null;
    this.notify({
      kind: 'failed',
      title: name ?? FALLBACK_TITLE,
      // Stack traces and multi-line detail do not fit a notification body.
      body: `Session failed: ${str(message.split('\n')[0]) ?? message}`,
      sessionId,
    });
  }
}
