/**
 * Updating a member from the group (spec 2026-10-19-headless-server-design §
 * Updating from the group): the answer of `GET /api/server/update`, the
 * refusals of `POST /api/server/update`, the version that first serves
 * them, the messages between the desktop's main process and the server it
 * forks, and when a member's state is read again.
 *
 * The server writes the state, the desktop web, the phone and the `orbital`
 * CLI read it; each parses it here before using it.
 */
import { z } from 'zod';
import { compareVersions } from './version.js';

/**
 * The first Orbital that serves `GET`/`POST /api/server/update`, on a Mac and
 * on a headless server alike (both report the desktop version line). A
 * member whose hello names a lower version is never asked.
 */
export const SERVER_UPDATE_VERSION = '0.35.0';

/** Whether a member running `version` serves the update routes; false before its hello is known. */
export function servesServerUpdate(version: string | null | undefined): boolean {
  return typeof version === 'string' && version !== '' && compareVersions(version, SERVER_UPDATE_VERSION) >= 0;
}

/**
 * Whether `m` is asked for its update state at all: this device always, a
 * phone never — it has no server, its store updates it — and any other
 * member only when its last hello named a version that serves the route
 * (`servesServerUpdate`). The desktop's Settings → Devices and the `orbital`
 * CLI both gate on it.
 */
export function memberServesUpdate(m: { self: boolean; kind: string; version?: string | null }): boolean {
  if (m.self) return true;
  if (m.kind === 'phone') return false;
  return servesServerUpdate(m.version ?? null);
}

/** The longest version string any side takes: apt's and electron-updater's are far shorter. */
export const UPDATE_VERSION_MAX_CHARS = 64;

/**
 * A version as apt or electron-updater spell it: digits, letters and the
 * separators Debian allows (`.`, `+`, `~`, `-`, `:`). Nothing that could
 * be read as a path or an option.
 */
export const VersionText = z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+~:-]*$/).max(UPDATE_VERSION_MAX_CHARS);

/** Whether `s` is a version as `VersionText` takes one: what apt's output is read through. */
export function isUpdateVersion(s: string): boolean {
  return VersionText.safeParse(s).success;
}

/** The longest device id `startedBy` keeps: a device id is far shorter. */
export const STARTED_BY_ID_MAX_CHARS = 128;
/**
 * Where `startedBy`'s name is cut: no shorter than the relay's
 * `PAIR_NAME_MAX_CHARS`, which every name a member goes by is cut to. Not
 * imported from there, so the desktop's main process does not bundle the relay's crypto.
 */
export const STARTED_BY_NAME_MAX_CHARS = 128;

/** Who asked for an update: a member's id and the name it goes by. */
export type UpdateAsker = { id: string; name: string };

/**
 * When an update asked for installs (canvas 50q–50t, the confirm's three
 * choices): `now`, which stops the sessions running there, or `idle`, the
 * first moment no session there is mid-turn or waiting on a decision.
 */
export type UpdateWhen = 'now' | 'idle';

/**
 * The one thing `POST /api/server/update` reads from its body: `when`. No
 * other field is taken, and nothing that names a version or a package.
 * Strict: an unknown field, or any other value, is refused.
 */
export const UpdateStartBody = z.object({ when: z.enum(['now', 'idle']).optional() }).strict();

/**
 * When a `POST /api/server/update` body asks to install: an absent body, or
 * one without `when`, is `now`; null for anything else (the route answers
 * 400 and starts nothing).
 */
export function parseUpdateStartBody(body: unknown): UpdateWhen | null {
  if (body === undefined) return 'now';
  const parsed = UpdateStartBody.safeParse(body);
  return parsed.success ? (parsed.data.when ?? 'now') : null;
}

/**
 * `GET /api/server/update`:
 *
 * - `installed` — the version installed on the member (`dev` for a server
 *   run from source);
 * - `candidate` — the version an update would install, null when none is
 *   known; it may equal `installed`;
 * - `packaged` — the member can update itself from here: a headless server
 *   installed from the package, or a server forked by the desktop app;
 * - `updating` — an update was started and the member has not come back yet;
 * - `failed` — the version the last update was meant to bring, when it ended
 *   without it (the member came back with the old version, or no restart
 *   came in time); null otherwise;
 * - `sessions` — how many sessions the member is running right now (an
 *   update stops them);
 * - `startedBy` — while `updating`, the member that asked for the update
 *   ("started on Pixel 8"): the asking peer through a channel, this device
 *   for a request made on it (its web or the CLI). Null when nothing is
 *   updating, when the asker is not known, and from a server older than the
 *   field, which sends none.
 * - `waiting` — while `updating`, an update asked for `idle` that has not
 *   started installing yet: how many sessions there it waits for (live). It
 *   installs the first moment that is none. Null otherwise; absent from a
 *   server older than the field, which never waits.
 * - `failedReason` — with `failed`, why, when the member knows:
 *   `sessions`, a Mac whose sessions started working while the update
 *   downloaded, so it did not restart over them and prompts there instead;
 *   `unknown`, a Mac that could not tell which sessions worked when it
 *   landed, and did not restart either. Null or absent otherwise; absent
 *   from a server older than the field.
 *   A reader that does not know a reason reads null.
 */
export const ServerUpdateStateSchema = z.object({
  installed: VersionText,
  candidate: VersionText.nullable(),
  packaged: z.boolean(),
  updating: z.boolean(),
  failed: VersionText.nullable(),
  sessions: z.number().int().min(0),
  startedBy: z.object({
    id: z.string().max(STARTED_BY_ID_MAX_CHARS),
    name: z.string().transform((s) => s.slice(0, STARTED_BY_NAME_MAX_CHARS)),
  }).nullable().catch(null),
  failedReason: z.enum(['sessions', 'unknown']).nullable().optional().catch(null),
  waiting: z.object({ sessions: z.number().int().min(0) }).nullable().optional().catch(null),
});
export type ServerUpdateState = z.infer<typeof ServerUpdateStateSchema>;

/** A state off the wire; null for anything malformed. */
export function parseServerUpdateState(raw: unknown): ServerUpdateState | null {
  const parsed = ServerUpdateStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Whether `candidate` is a version newer than `installed`, the one condition an update starts on. */
export function updateIsNewer(installed: string, candidate: string | null): boolean {
  return candidate !== null && candidate !== installed && compareVersions(candidate, installed) > 0;
}

/**
 * What `POST /api/server/update` refuses with, and the status of each:
 *
 * - `no_update` (409) — the candidate is not newer than what is installed;
 * - `updating` (409) — an update is already running; a second request is
 *   refused, never queued;
 * - `not_set_up` (409) — a headless server whose `orbital setup` has not
 *   run: the request directory is missing or not writable;
 * - `not_packaged` (501) — the member cannot update itself (a dev server,
 *   a server started by hand).
 */
export const SERVER_UPDATE_REFUSALS = {
  no_update: 409,
  updating: 409,
  not_set_up: 409,
  not_packaged: 501,
} as const;
export type ServerUpdateRefusal = keyof typeof SERVER_UPDATE_REFUSALS;

/**
 * What `DELETE /api/server/update` refuses with: `not_waiting` (409) — no
 * update waits there for its sessions; one that installs already cannot be
 * called back.
 */
export const SERVER_UPDATE_CANCEL_REFUSALS = { not_waiting: 409 } as const;
export type ServerUpdateCancelRefusal = keyof typeof SERVER_UPDATE_CANCEL_REFUSALS;

// ── The desktop's main process and the server it forks ──────────────────

/**
 * Main → server: the state of the desktop's own updater (electron-updater),
 * sent once after the server starts, again whenever it changes, and every
 * `UPDATE_KEEPALIVE_MS` while it downloads.
 * `installed` is the app's version, `available` the newer version a check
 * found (null when none), `downloading` while it downloads, `downloaded`
 * once it is ready to install. `waiting`: while a request asked for `idle`
 * runs and has not started installing, how many sessions here it waits for;
 * null (or absent) otherwise.
 */
export const MainUpdateStateMessage = z.object({
  t: z.literal('update_state'),
  installed: VersionText,
  available: VersionText.nullable(),
  downloading: z.boolean(),
  downloaded: z.boolean(),
  waiting: z.number().int().min(0).nullable().optional(),
}).strict();
export type MainUpdateStateMessage = z.infer<typeof MainUpdateStateMessage>;

/**
 * Main → server: a member's request ended on this Mac without the install,
 * so the server reports it failed at once rather than at its timeout.
 *
 * - `sessions` — an Orbital session started working while it downloaded: the
 *   Mac prompts as for its own download instead of restarting over it;
 * - `unknown` — the Mac could not tell which sessions work (its session
 *   list was being re-read) and did not restart either;
 * - `restart` — the app was asked again while a restart it was already
 *   making had not got it out, and its one retry was spent;
 * - `cancelled` — the person at the Mac cancelled a request that waited for
 *   its sessions to finish: not a failure, the members go back to `update
 *   available`.
 */
export const MainUpdateEndedMessage = z.object({
  t: z.literal('update_ended'),
  reason: z.enum(['sessions', 'unknown', 'restart', 'cancelled']),
}).strict();
export type MainUpdateEndedMessage = z.infer<typeof MainUpdateEndedMessage>;
export type UpdateEndReason = MainUpdateEndedMessage['reason'];
/** The reasons a failed update names to the members (`ServerUpdateState.failedReason`). */
export type UpdateFailReason = NonNullable<ServerUpdateState['failedReason']>;

/** Everything main sends the server. */
export const MainMessage = z.discriminatedUnion('t', [MainUpdateStateMessage, MainUpdateEndedMessage]);
export type MainMessage = z.infer<typeof MainMessage>;

/**
 * While main's updater downloads, how often it tells the server so again
 * even when nothing else changed: the server's wait (`UPDATE_TIMEOUT_MS`)
 * starts over with each word, so a slow download that is still moving is not
 * taken for a failed one. Well below that wait.
 */
export const UPDATE_KEEPALIVE_MS = 60_000;

/**
 * Server → main:
 *
 * - `update_start` — start the update a member asked for: download it when
 *   it is not downloaded, then install it and relaunch. `by` is the member
 *   that asked through its channel, which the Mac names on its prompt
 *   (canvas 50v); null for a request made on this Mac (its web, the CLI),
 *   which shows as the Mac's own update. `when`: `now` installs once
 *   downloaded; `idle` waits, after the download, for the sessions here to
 *   finish;
 * - `update_cancel` — the server gave up waiting (`UPDATE_TIMEOUT_MS`) and
 *   told the members it failed, or a member cancelled a request that waits
 *   for the sessions here: a download still running must not install by
 *   itself when it lands, and a wait ends; it prompts on this Mac as any
 *   download does.
 *
 * Neither names a version: main installs only what its own updater found
 * and verified.
 */
export const ServerUpdateMessage = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('update_start'),
    by: z.object({
      id: z.string().min(1).max(STARTED_BY_ID_MAX_CHARS),
      name: z.string().min(1).max(STARTED_BY_NAME_MAX_CHARS),
    }).strict().nullable(),
    when: z.enum(['now', 'idle']),
  }).strict(),
  z.object({ t: z.literal('update_cancel') }).strict(),
]);
export type ServerUpdateMessage = z.infer<typeof ServerUpdateMessage>;

/** A message main sent the server; null for anything malformed, which the server ignores. */
export function parseMainMessage(raw: unknown): MainMessage | null {
  const parsed = MainMessage.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** A message the server sent main; null for anything malformed, which main ignores. */
export function parseServerMessage(raw: unknown): ServerUpdateMessage | null {
  const parsed = ServerUpdateMessage.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ── When a member's state is read ───────────────────────────────────────

/** How often a member shown `updating` is read again while Settings → Devices is open. */
export const UPDATE_POLL_MS = 5_000;

/**
 * How long an update may take, from the request to the member answering
 * with the new version: apt's lists and the package, or the desktop's
 * download, then a restart. Past it the update counts as failed — on the
 * member itself and on every member watching it.
 */
export const UPDATE_TIMEOUT_MS = 10 * 60_000;

/**
 * An update being watched from another member: the version the member had
 * when it started, and when it was started or first seen updating.
 */
export type UpdateWatch = { installed: string; since: number };

/** A watch begun from a state that says `updating` (or a 202), at `now`. */
export function watchUpdate(state: ServerUpdateState, now: number): UpdateWatch {
  return { installed: state.installed, since: now };
}

/**
 * Where a watched update stands after a read: `latest` is the member's
 * answer, null when it could not be read (an updating member is offline
 * for a while).
 *
 * - `updated` — it answers with a different version;
 * - `waiting` — it says it waits for its sessions (`waiting`): no time runs
 *   out on that, the wait may last hours;
 * - `ended` — it answers with the old version, not updating and not failed,
 *   after it was seen waiting (`waited`): the wait was cancelled, or a
 *   restart of the member dropped it — not a failure;
 * - `failed` — it answers with the old version and is no longer updating,
 *   or says so itself (`failed`), or `UPDATE_TIMEOUT_MS` passed;
 * - `updating` — anything else: keep reading.
 *
 * `waited`: the watch saw the member waiting.
 */
export type WatchVerdict = 'updating' | 'waiting' | 'updated' | 'ended' | 'failed';

export function watchVerdict(
  watch: UpdateWatch & { waited?: boolean }, latest: ServerUpdateState | null, now: number,
): WatchVerdict {
  if (latest !== null && latest.installed !== watch.installed) return 'updated';
  if (latest !== null && latest.updating && latest.waiting) return 'waiting';
  if (latest !== null && !latest.updating) return watch.waited && latest.failed === null ? 'ended' : 'failed';
  if (now - watch.since >= UPDATE_TIMEOUT_MS) return 'failed';
  return 'updating';
}

/**
 * When an open Settings → Devices reads the members' states again: null for
 * no timer — it read each once when it opened — and `UPDATE_POLL_MS` while a
 * row is being watched. Closed, the page runs no timer at all.
 */
export function updatePollDelay(o: { watching: boolean }): number | null {
  return o.watching ? UPDATE_POLL_MS : null;
}
