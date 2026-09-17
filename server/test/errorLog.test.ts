import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { openDb, type OrbitalDb } from '../src/db/database.js';
import { errors as errorsTable } from '../src/db/schema.js';
import { ErrorLog, MAX_ROWS } from '../src/errors/log.js';
import { Hub } from '../src/api/hub.js';

/** Collects everything published on the `errors` topic through a real Hub. */
function subscribed(hub: Hub) {
  const received: any[] = [];
  const socket: any = {
    send: (d: string) => received.push(JSON.parse(d)),
    handlers: {} as Record<string, Function>,
    on(ev: string, cb: Function) { this.handlers[ev] = cb; },
  };
  hub.handleSocket(socket);
  socket.handlers['message'](JSON.stringify({ type: 'subscribe', topic: 'errors' }));
  return received;
}

describe('ErrorLog', () => {
  let db: OrbitalDb;
  let hub: Hub;
  let log: ErrorLog;
  beforeEach(() => {
    db = openDb(join(mkdtempSync(join(tmpdir(), 'orbital-errors-')), 'index.db'));
    hub = new Hub();
    log = new ErrorLog({ db, hub });
  });

  it('record() stores the whole entry, stamps `at`, and publishes it', () => {
    const received = subscribed(hub);
    const before = Date.now();
    const error = log.record({
      source: 'server',
      kind: 'session_failed',
      sessionId: 's1',
      message: 'spawn ENOENT',
      detail: 'Error: spawn ENOENT\n    at onErrorNT',
      context: { cwd: '/w/x', permissionMode: 'acceptEdits', model: 'sonnet' },
    });
    expect(error).toMatchObject({
      source: 'server',
      kind: 'session_failed',
      sessionId: 's1',
      message: 'spawn ENOENT',
      // Nothing is trimmed on the way in — the stack arrives whole.
      detail: 'Error: spawn ENOENT\n    at onErrorNT',
      context: { cwd: '/w/x', permissionMode: 'acceptEdits', model: 'sonnet' },
      seenAt: null,
    });
    expect(error.at).toBeGreaterThanOrEqual(before);
    expect(received).toEqual([
      { topic: 'errors', event: 'error', error, unseen: 1 },
    ]);
  });

  it('record() defaults the optional halves to null rather than undefined', () => {
    const error = log.record({ source: 'web', kind: 'render_crash', message: 'boom' });
    expect(error.sessionId).toBeNull();
    expect(error.detail).toBeNull();
    expect(error.context).toBeNull();
  });

  it('list() is newest first and defaults to 50 rows', () => {
    for (let i = 0; i < 60; i++) {
      log.record({ source: 'web', kind: 'api_request', message: `e${i}` });
    }
    const page = log.list();
    expect(page.errors).toHaveLength(50);
    expect(page.errors[0].message).toBe('e59');
    expect(page.errors[49].message).toBe('e10');
  });

  it('list() caps the limit at 200', () => {
    for (let i = 0; i < 205; i++) {
      log.record({ source: 'web', kind: 'api_request', message: `e${i}` });
    }
    expect(log.list({ limit: 1000 }).errors).toHaveLength(200);
  });

  it('list({ before }) pages backwards by id', () => {
    const ids = [0, 1, 2, 3, 4].map(
      (i) => log.record({ source: 'web', kind: 'api_request', message: `e${i}` }).id,
    );
    const page = log.list({ limit: 2, before: ids[3] });
    expect(page.errors.map((e) => e.message)).toEqual(['e2', 'e1']);
  });

  it('list() reports unseen across the whole table, not the page', () => {
    for (let i = 0; i < 12; i++) {
      log.record({ source: 'web', kind: 'api_request', message: `e${i}` });
    }
    const page = log.list({ limit: 3 });
    expect(page.errors).toHaveLength(3);
    expect(page.unseen).toBe(12);
  });

  it('markSeen(ids) stamps only those rows and publishes the new count', () => {
    const ids = ['a', 'b', 'c'].map(
      (m) => log.record({ source: 'web', kind: 'api_request', message: m }).id,
    );
    const received = subscribed(hub);
    expect(log.markSeen([ids[0], ids[2]])).toEqual({ unseen: 1 });
    expect(received).toEqual([
      { topic: 'errors', event: 'seen', ids: [ids[0], ids[2]], unseen: 1 },
    ]);
    const rows = log.list().errors;
    expect(rows.find((e) => e.id === ids[1])!.seenAt).toBeNull();
    expect(rows.find((e) => e.id === ids[0])!.seenAt).toBeTypeOf('number');
  });

  it("markSeen('all') stamps everything and leaves nothing unseen", () => {
    for (let i = 0; i < 4; i++) {
      log.record({ source: 'web', kind: 'api_request', message: `e${i}` });
    }
    const received = subscribed(hub);
    expect(log.markSeen('all')).toEqual({ unseen: 0 });
    expect(received[0]).toMatchObject({ event: 'seen', ids: null, unseen: 0 });
    expect(log.list().errors.every((e) => typeof e.seenAt === 'number')).toBe(true);
  });

  it('markSeen() does not rewrite a row that was already seen', () => {
    const id = log.record({ source: 'web', kind: 'api_request', message: 'a' }).id;
    log.markSeen([id]);
    const first = log.list().errors[0].seenAt;
    // A second pass must not move the moment the row was first shown.
    log.markSeen('all');
    expect(log.list().errors[0].seenAt).toBe(first);
  });

  it('clear() empties the table and says so', () => {
    log.record({ source: 'web', kind: 'api_request', message: 'a' });
    const received = subscribed(hub);
    log.clear();
    expect(log.list()).toEqual({ errors: [], unseen: 0 });
    expect(received[0]).toMatchObject({ topic: 'errors', event: 'cleared' });
  });

  it(`prunes on insert so only the newest ${MAX_ROWS} rows survive`, () => {
    for (let i = 0; i < MAX_ROWS + 5; i++) {
      log.record({ source: 'web', kind: 'api_request', message: `e${i}` });
    }
    const total = db
      .select({ n: sql<number>`COUNT(*)` })
      .from(errorsTable)
      .get()!.n;
    expect(Number(total)).toBe(MAX_ROWS);
    // The newest survived and the oldest went.
    expect(log.list({ limit: 1 }).errors[0].message).toBe(`e${MAX_ROWS + 4}`);
    const oldest = db
      .select({ n: sql<number>`COUNT(*)` })
      .from(errorsTable)
      .where(sql`${errorsTable.message} = 'e0'`)
      .get()!.n;
    expect(Number(oldest)).toBe(0);
  });

  it('a row whose context JSON is corrupt lists as null context, not a throw', () => {
    const good = log.record({
      source: 'web', kind: 'api_request', message: 'good', context: { a: 1 },
    });
    const bad = log.record({ source: 'web', kind: 'api_request', message: 'bad' });
    // Whatever wrote this — an older build, a partial write, a hand edit —
    // the list is the one place the user goes to find out what broke, so it
    // must still show every other row.
    db.$client.prepare('UPDATE errors SET context = ? WHERE id = ?').run('{not json', bad.id);

    const page = log.list();
    expect(page.errors.map((e) => e.message)).toEqual(['bad', 'good']);
    expect(page.errors[0].context).toBeNull();
    expect(page.errors[1].context).toEqual({ a: 1 });
    expect(good.context).toEqual({ a: 1 });
  });

  it('a context that parses to a non-object is reported as null too', () => {
    const row = log.record({ source: 'web', kind: 'api_request', message: 'x' });
    db.$client.prepare('UPDATE errors SET context = ? WHERE id = ?').run('"a string"', row.id);
    expect(log.list().errors[0].context).toBeNull();
  });

  it('the source check constraint refuses anything but server or web', () => {
    expect(() =>
      db.$client
        .prepare('INSERT INTO errors (at, source, kind, message) VALUES (?, ?, ?, ?)')
        .run(Date.now(), 'martian', 'api_request', 'x'),
    ).toThrow();
  });
});
