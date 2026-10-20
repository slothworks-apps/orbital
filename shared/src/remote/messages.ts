/**
 * Everything that travels inside a sealed frame body. Byte 0 picks the
 * kind: 0 is a JSON message, 1 is one chunk of a blob (an image going either
 * way). Blobs are chunked so a screenshot never holds the socket the
 * transcript shares (spec 2026-09-30-mobile-remote-design § 3 binary frame).
 */
import { z } from 'zod';
import { PAIR_NAME_MAX_CHARS } from './relayApi.js';
import { ROSTER_KIND_MAX_CHARS, RosterStateSchema } from './roster.js';

export const PROTOCOL_VERSION = 1;
export const BLOB_CHUNK_BYTES = 65536;

export type Inner =
  | { kind: 'json'; value: unknown }
  | { kind: 'blob'; id: number; seq: number; last: boolean; bytes: Uint8Array };

const KIND_JSON = 0;
const KIND_BLOB = 1;
const BLOB_HEADER_BYTES = 1 + 4 + 4 + 1;

export function encodeInner(m: Inner): Uint8Array {
  if (m.kind === 'json') {
    const json = new TextEncoder().encode(JSON.stringify(m.value));
    const out = new Uint8Array(1 + json.length);
    out[0] = KIND_JSON;
    out.set(json, 1);
    return out;
  }
  const out = new Uint8Array(BLOB_HEADER_BYTES + m.bytes.length);
  const view = new DataView(out.buffer);
  out[0] = KIND_BLOB;
  view.setUint32(1, m.id);
  view.setUint32(5, m.seq);
  out[9] = m.last ? 1 : 0;
  out.set(m.bytes, BLOB_HEADER_BYTES);
  return out;
}

export function decodeInner(buf: Uint8Array): Inner | null {
  if (buf.length === 0) return null;
  if (buf[0] === KIND_JSON) {
    try {
      return { kind: 'json', value: JSON.parse(new TextDecoder().decode(buf.subarray(1))) };
    } catch {
      return null;
    }
  }
  if (buf[0] === KIND_BLOB) {
    if (buf.length < BLOB_HEADER_BYTES) return null;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return {
      kind: 'blob',
      id: view.getUint32(1),
      seq: view.getUint32(5),
      last: buf[9] === 1,
      bytes: buf.slice(BLOB_HEADER_BYTES),
    };
  }
  return null;
}

/** Always at least one chunk, so an empty blob still ends. */
export function chunkBlob(id: number, bytes: Uint8Array): Inner[] {
  const chunks: Inner[] = [];
  let seq = 0;
  for (let at = 0; at < bytes.length || seq === 0; at += BLOB_CHUNK_BYTES) {
    const end = Math.min(at + BLOB_CHUNK_BYTES, bytes.length);
    chunks.push({ kind: 'blob', id, seq, last: end >= bytes.length, bytes: bytes.slice(at, end) });
    seq++;
    if (end >= bytes.length) break;
  }
  return chunks;
}

export const NotificationSettingsSchema = z.object({
  needsInput: z.boolean(),
  sessionEnded: z.boolean(),
  sessionFailed: z.boolean(),
  onlyWhenBackground: z.boolean(),
  sound: z.boolean(),
});
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;

const HttpMethod = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const ImageRef = z.string().regex(/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/);

/** The longest path a `file_get` may name; the Mac never looks at a longer one. */
export const FILE_PATH_MAX_CHARS = 4096;
/** The longest session id a `file_get` may name. */
export const FILE_SESSION_MAX_CHARS = 256;
// Not empty, and no C0 control character or DEL: nothing a path a session
// named carries, and each one a way to make a log line or a comparison lie.
// eslint-disable-next-line no-control-regex
const NO_CONTROL_CHARS = /^[^\u0000-\u001f\u007f]+$/;
/**
 * How the phone wants a file: an image for the viewer, text for the
 * read-only preview, or a PDF's bytes for pdf.js (spec
 * 2026-10-09-session-media-design § Phone). An older Mac refuses `pdf` at
 * this schema, and the phone reads any refusal as "can't show this here".
 */
export const FileAs = z.enum(['image', 'text', 'pdf']);
export type FileAs = z.infer<typeof FileAs>;

export const AskMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('ws'), type: z.enum(['subscribe', 'unsubscribe']), topic: z.string() }),
  z.object({
    t: z.literal('http'), id: z.number().int(), method: HttpMethod, path: z.string(),
    body: z.unknown().optional(),
  }),
  /**
   * `edge`: the longest edge the phone wants, for a thumbnail (spec
   * 2026-10-16-image-sizes-design § 2). The Mac may answer with the full
   * image anyway, and an older Mac, which drops the field, always does.
   */
  z.object({ t: z.literal('blob_get'), id: z.number().int(), ref: ImageRef, edge: z.number().int().positive().max(4096).optional() }),
  /**
   * A file a session may show, by path (spec 2026-10-05-mobile-next-design
   * § 2), answered like `blob_get`: `blob_meta`, then chunks. The Mac
   * confines `path` to what the session may show; these bounds only keep
   * junk away from that check.
   */
  z.object({
    t: z.literal('file_get'), id: z.number().int(),
    session: z.string().max(FILE_SESSION_MAX_CHARS).regex(NO_CONTROL_CHARS),
    path: z.string().max(FILE_PATH_MAX_CHARS).regex(NO_CONTROL_CHARS),
    as: FileAs,
    /**
     * The `cwd` of the transcript entry the link came from (spec
     * 2026-10-07-live-working-tree-design § 4). The Mac uses it only when
     * the session's transcripts recorded it. Optional: an older phone sends
     * none, and an older Mac ignores it.
     */
    cwd: z.string().max(FILE_PATH_MAX_CHARS).regex(NO_CONTROL_CHARS).optional(),
  }),
  z.object({
    t: z.literal('blob_put'), id: z.number().int(), mediaType: z.string(), bytes: z.number().int().nonnegative(),
  }),
  z.object({ t: z.literal('notifications_get') }),
  z.object({ t: z.literal('notifications_set'), settings: NotificationSettingsSchema }),
  z.object({ t: z.literal('seen'), sessionId: z.string() }),
]);
export type AskMessage = z.infer<typeof AskMessage>;

const ImageRefEntry = z.object({
  ref: ImageRef, w: z.number().nullable(), h: z.number().nullable(), bytes: z.number(),
});
export type ImageRefEntry = z.infer<typeof ImageRefEntry>;

export const AnswerMessage = z.discriminatedUnion('t', [
  /**
   * `app_too_old`: the phone app is below the Mac's `MIN_PHONE_VERSION`, sent
   * with it as `needed`. A phone older than `PHONE_KNOWS_APP_TOO_OLD` cannot
   * parse it and is sent `protocol` instead (shared/src/remote/version.ts).
   */
  z.object({ t: z.literal('bye'), reason: z.enum(['protocol', 'revoked', 'app_too_old']), needed: z.string().optional() }),
  z.object({ t: z.literal('ws'), frame: z.unknown() }),
  z.object({ t: z.literal('http_res'), id: z.number().int(), status: z.number().int(), body: z.unknown() }),
  z.object({
    t: z.literal('blob_meta'), id: z.number().int(), status: z.number().int(),
    bytes: z.number().int().optional(), mediaType: z.string().optional(),
    /**
     * `file_get` only: the file's size on disk (on a 413 too), and an
     * image's pixel size when its header gives it — so the viewer can
     * reserve the box before the bytes arrive.
     */
    size: z.number().int().nonnegative().optional(),
    w: z.number().int().positive().optional(),
    h: z.number().int().positive().optional(),
  }),
  z.object({
    t: z.literal('blob_put_done'), id: z.number().int(),
    entry: ImageRefEntry.optional(), error: z.string().optional(),
  }),
  z.object({ t: z.literal('notifications'), settings: NotificationSettingsSchema }),
]);
export type AnswerMessage = z.infer<typeof AnswerMessage>;

/**
 * The group's own messages (spec 2026-10-16-device-group-design § 2, § 4),
 * sent only to a peer whose hello named the `group` capability: a shipped
 * device never sees one. They change the group, so no route carries them.
 * A `roster` is everything the sender holds of the group (`RosterState`):
 * the primary's document, the descriptions and the left notices. A member
 * removed hears it as a version that no longer names it; a member leaving
 * sends only its left notice.
 */
export const GroupMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('roster_digest'), digest: z.string().max(128) }),
  RosterStateSchema.extend({ t: z.literal('roster') }),
  /** A `roster` heard, by its `exitDigest`: a pair waiting on that document to end ends now. */
  z.object({ t: z.literal('roster_ack'), digest: z.string().max(128) }),
]);
export type GroupMessage = z.infer<typeof GroupMessage>;

/** The longest `kind` and `os` a hello keeps: what the roster holds. */
export const HELLO_KIND_MAX_CHARS = ROSTER_KIND_MAX_CHARS;
/** The longest `osVersion` a hello keeps: `Ubuntu 24.04`, `macOS 14.6`, a distro's longer name. */
export const HELLO_OS_VERSION_MAX_CHARS = 32;
/** The most capabilities a hello keeps, and the longest one it keeps at all. */
export const HELLO_CAPABILITIES_MAX = 32;
export const HELLO_CAPABILITY_MAX_CHARS = 32;

/** A cosmetic string: cut to `max` when there is one, absent when it is not a string. */
const helloText = (max?: number) =>
  z.string().transform((s) => (max === undefined ? s : s.slice(0, max))).optional().catch(undefined);

/**
 * Every device's greeting, both ways, the initiator's first (spec
 * 2026-10-16-device-group-design § 5). A shipped phone sends only
 * `protocol` and `app`; a shipped Mac only `protocol`, `server` and
 * `macName`, and a shipped phone requires those two of whatever serves it.
 * `kind` and `capabilities` stay strings: a device from a later release may
 * name one this one does not know.
 *
 * Only `t` and `protocol` can refuse a hello: a refused hello leaves the
 * peer unreachable, and nothing else in it is worth that. Every other field
 * is cut to its bound, and one of the wrong type is read as absent.
 */
export const HelloMessage = z.object({
  t: z.literal('hello'),
  protocol: z.number().int(),
  app: helloText(),
  server: helloText(),
  macName: helloText(PAIR_NAME_MAX_CHARS),
  version: helloText(),
  kind: helloText(HELLO_KIND_MAX_CHARS),
  os: helloText(HELLO_KIND_MAX_CHARS),
  name: helloText(PAIR_NAME_MAX_CHARS),
  /**
   * The OS with its version, worded for its row (`macOS 14.6`, `Ubuntu
   * 24.04`, `Android 15`); absent where the sender does not know it, and
   * from every device older than the field. Cosmetic: not in the signed
   * description, so nothing is signed or stored for it.
   */
  osVersion: helloText(HELLO_OS_VERSION_MAX_CHARS),
  capabilities: z.array(z.unknown())
    .transform((list) => list
      .filter((c): c is string => typeof c === 'string' && c.length <= HELLO_CAPABILITY_MAX_CHARS)
      .slice(0, HELLO_CAPABILITIES_MAX))
    .optional().catch(undefined),
}).transform((hello) => {
  // A field read as absent leaves no key behind, as if it had never been sent.
  const out = { ...hello };
  for (const key of Object.keys(out) as (keyof typeof out)[]) if (out[key] === undefined) delete out[key];
  return out;
});
export type HelloMessage = z.output<typeof HelloMessage>;

export type ChannelMessage =
  | { kind: 'hello'; msg: HelloMessage }
  | { kind: 'ask'; msg: AskMessage }
  | { kind: 'answer'; msg: AnswerMessage }
  | { kind: 'group'; msg: GroupMessage };

/**
 * One inner JSON message, sorted. `ws` is the one `t` both sides use: a
 * subscribe names `type` and `topic`, a hub frame carries `frame`, so the
 * ask is tried first.
 */
export function parseChannelMessage(value: unknown): ChannelMessage | null {
  const t = (value as { t?: unknown } | null)?.t;
  if (t === 'hello') {
    const hello = HelloMessage.safeParse(value);
    return hello.success ? { kind: 'hello', msg: hello.data } : null;
  }
  const ask = AskMessage.safeParse(value);
  if (ask.success) return { kind: 'ask', msg: ask.data };
  const answer = AnswerMessage.safeParse(value);
  if (answer.success) return { kind: 'answer', msg: answer.data };
  const group = GroupMessage.safeParse(value);
  return group.success ? { kind: 'group', msg: group.data } : null;
}

/** The Orbital version a hello names: a shipped Mac's `server`, else a newer device's `version`; null when neither. */
export function helloVersion(hello: HelloMessage | null | undefined): string | null {
  return hello?.server ?? hello?.version ?? null;
}

/** Whether the peer runs sessions this device may ask about: by its capabilities, else a shipped Mac by its `server`. */
export function peerServes(hello: HelloMessage): boolean {
  return hello.capabilities ? hello.capabilities.includes('sessions') : hello.server !== undefined;
}
