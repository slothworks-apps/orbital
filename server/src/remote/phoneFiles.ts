/**
 * What a phone's `file_get` may read: exactly what the desktop's file viewer
 * may read for the same session — inside its cwd, or an absolute path its
 * transcripts name (`resolveForSession`; spec 2026-10-05-mobile-next-design
 * § 2, which bounds it as 2026-10-03-api-token-and-named-files-design § 2
 * does). Reading only: nothing here opens or runs a file.
 */
import { eq } from 'drizzle-orm';
import type { FileAs } from '@orbital/shared/remote/messages';
import type { OrbitalDb } from '../db/database.js';
import { sessions } from '../db/schema.js';
import { NamedPathCache, readImageFile, readInSandboxes, readTextFile } from '../files/preview.js';
import type { WorkingTrees } from '../git/workingTrees.js';
import { sniffDims } from '../images/store.js';

/** The largest text file the phone previews; past it the phone says the file can't be shown there. */
export const PHONE_TEXT_PREVIEW_MAX_BYTES = 512 * 1024;
/** (session, path) answers the phone's named-path check keeps, as the routes' cache does. */
export const PHONE_NAMED_PATH_CACHE_ENTRIES = 512;

/** What the media type of a text answer says; the phone decodes it as UTF-8. */
const TEXT_MEDIA_TYPE = 'text/plain; charset=utf-8';

/**
 * The Mac's answer to one `file_get`, as `blob_meta` carries it: 200 with
 * the bytes; 403 outside what the session may show; 404 no such session or
 * file; 413 too large (with `size`); 415 not an image, or binary when text
 * was asked (with `mediaType` when the Mac knows it).
 */
export type PhoneFileAnswer = {
  status: 200 | 403 | 404 | 413 | 415;
  bytes?: Uint8Array;
  mediaType?: string;
  size?: number;
  w?: number;
  h?: number;
};

export type PhoneFileReader = (session: string, path: string, as: FileAs, cwd?: string) => PhoneFileAnswer;

/**
 * One reader for every phone, built by the remote service: the session row
 * gives the cwd and the transcript, the cache remembers which outside paths
 * those transcripts named. The path is taken verbatim, as `GET /api/files`
 * takes it, and so is `cwd`, which `trees` accepts or ignores exactly as the
 * route does (`fileSandboxes`). Without `trees`, the home alone confines.
 */
export function createPhoneFileReader(
  db: OrbitalDb,
  transcriptPath: (sessionId: string, projectDir: string, claudeDirId: number) => string,
  trees?: Pick<WorkingTrees, 'sandboxes'>,
): PhoneFileReader {
  const namedPaths = new NamedPathCache(PHONE_NAMED_PATH_CACHE_ENTRIES);
  return (session, path, as, cwd) => {
    const row = db
      .select({
        id: sessions.id, cwd: sessions.cwd, project_dir: sessions.projectDir, claude_dir_id: sessions.claudeDirId,
      })
      .from(sessions)
      .where(eq(sessions.id, session))
      .get();
    if (!row) return { status: 404 };
    const named = namedPaths.forSession(session, transcriptPath(session, row.project_dir, row.claude_dir_id));
    const sandboxes = trees?.sandboxes(row, cwd) ?? [row.cwd];

    if (as === 'image') {
      const read = readInSandboxes(sandboxes, (dir) => readImageFile(dir, path, named));
      switch (read.kind) {
        case 'ok': {
          const dims = sniffDims(read.bytes);
          // A header that claims zero pixels is no size to reserve a box from.
          const known = dims && dims[0] > 0 && dims[1] > 0;
          return {
            status: 200, bytes: new Uint8Array(read.bytes), mediaType: read.contentType, size: read.bytes.length,
            ...(known ? { w: dims[0], h: dims[1] } : {}),
          };
        }
        case 'outside':
          return { status: 403 };
        case 'not_found':
          return { status: 404 };
        case 'too_large':
          return { status: 413, size: read.size };
        case 'not_image':
          return { status: 415 };
      }
    }

    const read = readInSandboxes(sandboxes, (dir) => readTextFile(dir, path, named, PHONE_TEXT_PREVIEW_MAX_BYTES));
    switch (read.kind) {
      case 'ok':
        return { status: 200, bytes: new Uint8Array(read.bytes), mediaType: TEXT_MEDIA_TYPE, size: read.size };
      case 'outside':
        return { status: 403 };
      case 'not_found':
        return { status: 404 };
      case 'too_large':
        return { status: 413, size: read.size };
      case 'binary':
        return { status: 415, size: read.size, mediaType: read.mediaType };
    }
  };
}
