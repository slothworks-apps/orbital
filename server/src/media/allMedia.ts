/**
 * The gallery of every session, a page at a time (spec
 * 2026-10-13-all-sessions-gallery-design § Data). Sessions are walked by
 * recency, newest activity first; each one's list comes from the per-session
 * builder, newest item first; the walk stops once the page is full, so no
 * request reads every transcript.
 *
 * The cursor names the last session the page reached, where it stood in the
 * walk, and how many of its items — its oldest — are still to come. Counting
 * from the old end keeps a page boundary inside a session stable while that
 * session gains new items: the new ones are at the other end. A session that
 * moves to the top of the walk while the user scrolls is not met again in
 * the same walk; reopening the gallery starts from the top.
 */
import type { AllMediaItem, AllMediaPage, MediaItem } from '@orbital/shared/media';

/** Where a session stands in the walk: by `lastAt` descending, then `id` descending. */
export interface WalkPosition {
  at: number;
  id: string;
}

export interface MediaCursor extends WalkPosition {
  /** How many of this session's items, its oldest, the next page starts with. */
  rest: number;
}

export interface WalkSession extends WalkPosition {
  title: string;
  tagIds: number[];
}

export interface AllMediaSource {
  /** Up to `limit` sessions after `after` in the walk; from the top when `after` is null. */
  sessionsAfter(after: WalkPosition | null, limit: number): WalkSession[];
  /** One session by id, wherever it now stands; undefined when it is gone or hidden. */
  session(id: string): WalkSession | undefined;
  /** The session's media, oldest first, as `sessionMedia` answers; null when unknown. */
  media(id: string): readonly MediaItem[] | null;
}

export interface AllMediaQuery {
  cursor: MediaCursor | null;
  limit: number;
  /** Only sessions carrying any of these tags; null for every session. */
  tags: ReadonlySet<number> | null;
  /** How many sessions one page may read before it answers with what it has. */
  scanMax: number;
}

export const ALL_MEDIA_DEFAULT_LIMIT = 60;
export const ALL_MEDIA_MAX_LIMIT = 200;
/**
 * Sessions one page may read. A bound on work, not on the answer: many
 * sessions have no media, and a page that walked past this many of them
 * answers short with a cursor, which the client follows like any other.
 */
export const ALL_MEDIA_SCAN_MAX = 100;
/** Sessions asked of the database at a time while walking. */
const BATCH = 25;

export function encodeCursor(cursor: MediaCursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id, cursor.rest]), 'utf8').toString('base64url');
}

/** The cursor a page handed out, or null for anything that is not one. */
export function decodeCursor(raw: string): MediaCursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length !== 3) return null;
    const [at, id, rest] = value as unknown[];
    if (typeof at !== 'number' || !Number.isFinite(at)) return null;
    if (typeof id !== 'string' || id === '') return null;
    if (typeof rest !== 'number' || !Number.isSafeInteger(rest) || rest < 0) return null;
    return { at, id, rest };
  } catch {
    return null;
  }
}

/** `?tag=1,3`: the tag ids, or null when absent; a part that is not an id is dropped. */
export function parseTagFilter(raw: unknown): Set<number> | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const ids = raw.split(',').filter((p) => /^\d+$/.test(p)).map(Number);
  return ids.length ? new Set(ids) : null;
}

function tagged(session: WalkSession, tags: ReadonlySet<number> | null): boolean {
  return tags === null || session.tagIds.some((id) => tags.has(id));
}

export function allMediaPage(source: AllMediaSource, query: AllMediaQuery): AllMediaPage {
  const { limit, tags, scanMax } = query;
  const items: AllMediaItem[] = [];
  let scanned = 0;

  /** Adds `session`'s items (newest first) until the page is full; the cursor when it filled mid-way. */
  const take = (session: WalkSession, newest: readonly MediaItem[]): MediaCursor | null => {
    const room = limit - items.length;
    for (const item of newest.slice(0, room)) {
      items.push({ ...item, sessionId: session.id, sessionTitle: session.title, tagIds: session.tagIds });
    }
    return newest.length > room ? { at: session.at, id: session.id, rest: newest.length - room } : null;
  };

  const newestOf = (id: string): MediaItem[] => (source.media(id) ?? []).slice().reverse();

  let after: WalkPosition | null = null;
  if (query.cursor) {
    const { cursor } = query;
    after = { at: cursor.at, id: cursor.id };
    const session = cursor.rest > 0 ? source.session(cursor.id) : undefined;
    if (session && tagged(session, tags)) {
      scanned++;
      const newest = newestOf(session.id);
      const stop = take(session, newest.slice(Math.max(0, newest.length - cursor.rest)));
      // Keep the cursor's own position: the session may have moved since.
      if (stop) return { items, next: encodeCursor({ ...after, rest: stop.rest }) };
    }
  }

  for (;;) {
    if (items.length >= limit || scanned >= scanMax) {
      return { items, next: after ? encodeCursor({ ...after, rest: 0 }) : null };
    }
    const batch = source.sessionsAfter(after, BATCH);
    if (batch.length === 0) return { items, next: null };
    for (const session of batch) {
      if (items.length >= limit || scanned >= scanMax) break;
      after = { at: session.at, id: session.id };
      if (!tagged(session, tags)) continue;
      scanned++;
      const stop = take(session, newestOf(session.id));
      if (stop) return { items, next: encodeCursor(stop) };
    }
  }
}
