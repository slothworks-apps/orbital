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

// ── The desktop's main process and the server it forks ──────────────────

/**
 * Main → server: the state of the desktop's own updater (electron-updater),
 * sent once after the server starts and again whenever it changes.
 * `installed` is the app's version, `available` the newer version a check
 * found (null when none), `downloading` while it downloads, `downloaded`
 * once it is ready to install.
 */
export const MainUpdateStateMessage = z.object({
  t: z.literal('update_state'),
  installed: VersionText,
  available: VersionText.nullable(),
  downloading: z.boolean(),
  downloaded: z.boolean(),
}).strict();
export type MainUpdateStateMessage = z.infer<typeof MainUpdateStateMessage>;

/**
 * Server → main:
 *
 * - `update_start` — start the update a member asked for: download it when
 *   it is not downloaded, then install it and relaunch;
 * - `update_cancel` — the server gave up waiting (`UPDATE_TIMEOUT_MS`) and
 *   told the members it failed: a download still running must not install
 *   by itself when it lands; it prompts on this Mac as any download does.
 *
 * Neither names a version: main installs only what its own updater found
 * and verified.
 */
export const ServerUpdateMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('update_start') }).strict(),
  z.object({ t: z.literal('update_cancel') }).strict(),
]);
export type ServerUpdateMessage = z.infer<typeof ServerUpdateMessage>;

/** A message main sent the server; null for anything malformed, which the server ignores. */
export function parseMainMessage(raw: unknown): MainUpdateStateMessage | null {
  const parsed = MainUpdateStateMessage.safeParse(raw);
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
 * - `failed` — it answers with the old version and is no longer updating,
 *   or says so itself (`failed`), or `UPDATE_TIMEOUT_MS` passed;
 * - `updating` — anything else: keep reading.
 */
export type WatchVerdict = 'updating' | 'updated' | 'failed';

export function watchVerdict(watch: UpdateWatch, latest: ServerUpdateState | null, now: number): WatchVerdict {
  if (latest !== null && latest.installed !== watch.installed) return 'updated';
  if (latest !== null && !latest.updating) return 'failed';
  if (now - watch.since >= UPDATE_TIMEOUT_MS) return 'failed';
  return 'updating';
}

/**
 * When to read the members' states again: null for no timer — the page reads
 * once when it opens, and nothing while it is closed — and `UPDATE_POLL_MS`
 * while it is open and a row is being watched.
 */
export function updatePollDelay(o: { pageOpen: boolean; watching: boolean }): number | null {
  return o.pageOpen && o.watching ? UPDATE_POLL_MS : null;
}
