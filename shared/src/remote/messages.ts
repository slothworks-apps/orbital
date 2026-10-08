/**
 * Everything that travels inside a sealed frame body. Byte 0 picks the
 * kind: 0 is a JSON message, 1 is one chunk of a blob (an image going either
 * way). Blobs are chunked so a screenshot never holds the socket the
 * transcript shares (spec 2026-09-30-mobile-remote-design § 3 binary frame).
 */
import { z } from 'zod';

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
/** How the phone wants a file: an image for the viewer, or text for the read-only preview. */
export const FileAs = z.enum(['image', 'text']);
export type FileAs = z.infer<typeof FileAs>;

export const PhoneMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), protocol: z.number().int(), app: z.string() }),
  z.object({ t: z.literal('ws'), type: z.enum(['subscribe', 'unsubscribe']), topic: z.string() }),
  z.object({
    t: z.literal('http'), id: z.number().int(), method: HttpMethod, path: z.string(),
    body: z.unknown().optional(),
  }),
  z.object({ t: z.literal('blob_get'), id: z.number().int(), ref: ImageRef }),
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
export type PhoneMessage = z.infer<typeof PhoneMessage>;

const ImageRefEntry = z.object({
  ref: ImageRef, w: z.number().nullable(), h: z.number().nullable(), bytes: z.number(),
});
export type ImageRefEntry = z.infer<typeof ImageRefEntry>;

export const MacMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), protocol: z.number().int(), server: z.string(), macName: z.string() }),
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
export type MacMessage = z.infer<typeof MacMessage>;
