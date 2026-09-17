import { and, desc, eq, isNull, inArray, lt, sql } from 'drizzle-orm';
import type { OrbitalDb } from '../db/database.js';
import { errors, type ErrorRow } from '../db/schema.js';
import type { ErrorKind, ErrorRecord, ErrorSource } from '../types.js';
import type { Hub } from '../api/hub.js';

/** The hub topic every change to the log is published on. */
export const ERRORS_TOPIC = 'errors';

/**
 * Retention is a cap, not a clock: the newest rows survive and older ones are
 * pruned on insert. Errors are rare enough that this is only a runaway guard
 * — a loop that reports its own failure must not fill the database.
 */
export const MAX_ROWS = 1000;

/** Default page size for `list()`, and the ceiling a caller may ask for. */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** What a caller hands `record()`. `at` is stamped here; `source` is the caller's to state. */
export interface NewError {
  source: ErrorSource;
  kind: ErrorKind;
  message: string;
  detail?: string | null;
  context?: Record<string, unknown> | null;
  sessionId?: string | null;
}

export interface ErrorPage {
  errors: ErrorRecord[];
  /**
   * Unseen rows across the WHOLE table, not this page — a count of 200 has to
   * be right while looking at the newest 50.
   */
  unseen: number;
}

/**
 * Turns a stored row into the wire shape: `context` is JSON text on disk and
 * a parsed object in the API.
 *
 * A row whose JSON does not parse yields `context: null` rather than throwing.
 * The list is the one place a user goes to find out what broke, so a single
 * corrupt row must never be able to take it down — that would hide every
 * other error behind the one that is malformed.
 */
function toRecord(row: ErrorRow): ErrorRecord {
  let context: Record<string, unknown> | null = null;
  if (row.context != null) {
    try {
      const parsed = JSON.parse(row.context) as unknown;
      if (parsed && typeof parsed === 'object') context = parsed as Record<string, unknown>;
    } catch {
      /* corrupt row: report the error without its context, not nothing at all */
    }
  }
  return {
    id: row.id,
    at: row.at,
    source: row.source,
    kind: row.kind,
    sessionId: row.sessionId,
    message: row.message,
    detail: row.detail,
    context,
    seenAt: row.seenAt,
  };
}

/**
 * The server's single owner of the `errors` table.
 *
 * Both sides feed it — the runner through `index.ts`'s `onError`, the browser
 * through `POST /api/errors` — so there is one list to read rather than two,
 * and it survives a reload, which the store's old in-memory guess never did.
 * See `docs/superpowers/specs/2026-09-17-error-surface-design.md`.
 *
 * Every mutation publishes on the `errors` topic, because the count of unseen
 * rows is rendered live and a client that had to poll for it would be wrong
 * for as long as its interval.
 */
export class ErrorLog {
  private db: OrbitalDb;
  private hub: Hub;

  constructor(deps: { db: OrbitalDb; hub: Hub }) {
    this.db = deps.db;
    this.hub = deps.hub;
  }

  /** Inserts, prunes, publishes, and returns the row as the API shapes it. */
  record(entry: NewError): ErrorRecord {
    const result = this.db
      .insert(errors)
      .values({
        at: Date.now(),
        source: entry.source,
        kind: entry.kind,
        sessionId: entry.sessionId ?? null,
        message: entry.message,
        detail: entry.detail ?? null,
        context: entry.context == null ? null : JSON.stringify(entry.context),
        seenAt: null,
      })
      .run();
    const id = Number(result.lastInsertRowid);
    this.prune();
    const row = this.db.select().from(errors).where(eq(errors.id, id)).get() as ErrorRow;
    const error = toRecord(row);
    this.hub.publish(ERRORS_TOPIC, { event: 'error', error, unseen: this.unseen() });
    return error;
  }

  /**
   * Newest first, paged by id rather than by offset: rows are pruned from the
   * far end while a client pages, and an offset would silently skip or repeat
   * rows when that happens.
   */
  list(opts: { limit?: number; before?: number } = {}): ErrorPage {
    const limit = Math.min(Math.max(Number(opts.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const paged = opts.before != null && Number.isFinite(Number(opts.before));
    const rows = this.db
      .select()
      .from(errors)
      .where(paged ? lt(errors.id, Number(opts.before)) : undefined)
      .orderBy(desc(errors.id))
      .limit(limit)
      .all() as ErrorRow[];
    return { errors: rows.map(toRecord), unseen: this.unseen() };
  }

  /**
   * Stamps `seen_at` on rows that do not already have one — an id already
   * stamped keeps the moment it was first shown, so re-opening the list does
   * not rewrite history.
   */
  markSeen(target: number[] | 'all'): { unseen: number } {
    const ids = target === 'all' ? null : target.filter((id) => Number.isFinite(id));
    if (ids && ids.length === 0) return { unseen: this.unseen() };
    const where = ids ? and(isNull(errors.seenAt), inArray(errors.id, ids)) : isNull(errors.seenAt);
    this.db.update(errors).set({ seenAt: Date.now() }).where(where).run();
    const unseen = this.unseen();
    this.hub.publish(ERRORS_TOPIC, { event: 'seen', ids, unseen });
    return { unseen };
  }

  /** Empties the table. The user asked for the list to be gone, so it goes. */
  clear(): void {
    this.db.delete(errors).run();
    this.hub.publish(ERRORS_TOPIC, { event: 'cleared', unseen: 0 });
  }

  /** Unseen rows across the whole table. */
  unseen(): number {
    const row = this.db
      .select({ n: sql<number>`COUNT(*)` })
      .from(errors)
      .where(isNull(errors.seenAt))
      .get();
    return Number(row?.n ?? 0);
  }

  /** Deletes everything older than the newest `MAX_ROWS` rows. */
  private prune(): void {
    this.db
      .delete(errors)
      .where(
        sql`${errors.id} NOT IN (SELECT ${errors.id} FROM ${errors} ORDER BY ${errors.id} DESC LIMIT ${MAX_ROWS})`,
      )
      .run();
  }
}
