import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { TranscriptTail } from '../src/watcher/tail.js';
import { LiveSessionStats } from '../src/watcher/liveStats.js';
import { openDb } from '../src/db/database.js';
import { sessions, sessionStats } from '../src/db/schema.js';
import { STATS_LIVE_RECOMPUTE_TURNS } from '../src/stats/constants.js';
import type { TranscriptEntry } from '../src/transcript/parser.js';

const LINE1 = '{"type":"user","uuid":"u1","message":{"role":"user","content":"hi"}}\n';
const LINE2 = '{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":"yo"}}\n';

function collect(tail: TranscriptTail) {
  const seen: string[] = [];
  tail.on('entries', (entries) => {
    for (const e of entries) seen.push(e.uuid);
  });
  return seen;
}

describe('TranscriptTail', () => {
  it('emits existing entries on start and new entries on append', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-tail-'));
    const file = join(dir, 't.jsonl');
    writeFileSync(file, LINE1);
    // Tiny delay so the initial write is fully settled on disk before the
    // watcher is registered — cheap determinism nudge for a test that has
    // flaked intermittently under CI load (see also tail.ts's own directory-
    // watch comment for the related macOS kqueue-latency race).
    await new Promise((r) => setTimeout(r, 5));
    const tail = new TranscriptTail(file);
    const seen = collect(tail);
    tail.start();
    expect(seen).toEqual(['u1']);
    appendFileSync(file, LINE2);
    // This used to be a bare `waitFor` on a 3s budget, and it became a
    // coin-flip once the suite grew past ~150 tests. Raising the budget does
    // not help, which is the whole diagnosis: the event is not late, it is
    // LOST. `fs.watch` offers no readiness signal, so a write landing in the
    // window between `start()` and the watch actually going live is never
    // reported — the same race `tail.ts` documents for the file watch, which
    // the directory watch makes rarer but does not remove.
    //
    // So re-fire the watcher instead of waiting longer. `readNew` is
    // size-driven and returns early when the file has not grown, so nudging
    // mtime emits nothing by itself — it only gives a watcher that missed the
    // append another chance to notice it. The assertion is unchanged, and it
    // still proves the entry arrived through the watcher rather than by being
    // read directly.
    await vi.waitFor(
      () => {
        utimesSync(file, new Date(), new Date());
        expect(seen).toEqual(['u1', 'a1']);
      },
      // Interval comfortably above tail.ts's own 150ms debounce, so each nudge
      // gets to resolve instead of cancelling the one before it.
      { timeout: 15_000, interval: 250 },
    );
    tail.stop();
  }, 20_000);
  it('holds back a partial trailing line until completed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-tail2-'));
    const file = join(dir, 't.jsonl');
    writeFileSync(file, LINE1 + '{"type":"user","uu'); // partial second line
    const tail = new TranscriptTail(file);
    const seen = collect(tail);
    tail.start();
    expect(seen).toEqual(['u1']);
    expect(tail.offset).toBe(Buffer.byteLength(LINE1));
    tail.stop();
  });
});

// Spec 2026-09-29-rewind-design § Reading the live branch: a tail started
// at the end of a file knows the branch from what is above it, and a rewind
// appended in the terminal is a reset, not rows to append.
describe('TranscriptTail on a rewind', () => {
  const line = (uuid: string, parentUuid: string | null, type = 'user') =>
    JSON.stringify({ type, uuid, parentUuid, message: { role: type, content: uuid } }) + '\n';

  it('emits reset when the appended entry starts a new branch off the live one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-tail-rewind-'));
    const file = join(dir, 't.jsonl');
    const history = line('p1', null) + line('a1', 'p1', 'assistant') + line('p2', 'a1') + line('a2', 'p2', 'assistant');
    writeFileSync(file, history);
    await new Promise((r) => setTimeout(r, 5));
    const tail = new TranscriptTail(file);
    const seen = collect(tail);
    let resets = 0;
    tail.on('reset', () => resets++);
    tail.start(Buffer.byteLength(history));
    appendFileSync(file, line('p2-edited', 'a1'));
    // Re-fired the same way as the append test above, for the same reason.
    await vi.waitFor(
      () => {
        utimesSync(file, new Date(), new Date());
        expect(resets).toBe(1);
      },
      { timeout: 15_000, interval: 250 },
    );
    expect(seen).toEqual([]);
    tail.stop();
  }, 20_000);
});

// The live half of the stats cadence (spec 2026-09-20-session-stats-design,
// § Heuristic findings → Evaluation cadence).
describe('LiveSessionStats', () => {
  const SESSION = 'sess-live';

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-livestats-'));
    const file = join(dir, `${SESSION}.jsonl`);
    const db = openDb(join(dir, 'index.db'));
    db.insert(sessions).values({ id: SESSION, projectDir: 'proj' }).run();
    const onStats = vi.fn();
    const live = new LiveSessionStats({
      db,
      transcriptPathOf: (id) => (id === SESSION ? file : null),
      onStats,
    });
    const row = () => db.select().from(sessionStats).where(eq(sessionStats.sessionId, SESSION)).get();
    return { db, file, live, row, onStats };
  }

  function turn(i: number, requestId = `r${i}`): TranscriptEntry {
    return {
      type: 'assistant',
      uuid: `a${i}`,
      timestamp: new Date(Date.parse('2026-09-20T10:00:00.000Z') + i * 1000).toISOString(),
      requestId,
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'text', text: 'ok' }],
      },
    };
  }

  /** What the tail would have emitted: the file on disk and the entries in order. */
  function write(file: string, entries: TranscriptEntry[]) {
    writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n'));
  }

  it('recomputes once the cadence of turns is reached, and not before', () => {
    const { file, live, row } = setup();
    const entries = Array.from({ length: STATS_LIVE_RECOMPUTE_TURNS }, (_, i) => turn(i));
    write(file, entries);

    for (const entry of entries.slice(0, -1)) live.feed(SESSION, [entry]);
    expect(row()).toBeUndefined();

    live.feed(SESSION, [entries[entries.length - 1]]);
    expect(row()!.turns).toBe(STATS_LIVE_RECOMPUTE_TURNS);
  });

  it('counts a turn per requestId, not per entry', () => {
    const { file, live, row } = setup();
    // One API response written as many entries — the CLI's normal shape.
    const entries = Array.from({ length: STATS_LIVE_RECOMPUTE_TURNS * 2 }, (_, i) =>
      turn(i, 'r-same'),
    );
    write(file, entries);

    live.feed(SESSION, entries);
    expect(row()).toBeUndefined();
  });

  it('recomputes when the session ends, however few turns it had', () => {
    const { file, live, row } = setup();
    const entries = [turn(0), turn(1)];
    write(file, entries);

    live.feed(SESSION, entries);
    expect(row()).toBeUndefined();

    live.end(SESSION);
    expect(row()!.turns).toBe(2);
  });

  it('ignores a session with no transcript of its own', () => {
    const { live, row } = setup();
    expect(() => live.end('no-such-session')).not.toThrow();
    expect(row()).toBeUndefined();
  });

  // What the detail panel's stats row re-reads on (ADR
  // `the-stats-row-reads-when-the-stats-are-written`): the announcement rides
  // on the write, so it cannot be sent for a rollup that was not stored.
  it('announces the session whenever it writes a rollup, and only then', () => {
    const { file, live, row, onStats } = setup();
    const entries = Array.from({ length: STATS_LIVE_RECOMPUTE_TURNS }, (_, i) => turn(i));
    write(file, entries);

    for (const entry of entries.slice(0, -1)) live.feed(SESSION, [entry]);
    expect(onStats).not.toHaveBeenCalled();

    live.feed(SESSION, [entries[entries.length - 1]]);
    expect(onStats).toHaveBeenCalledExactlyOnceWith(SESSION);

    live.end(SESSION);
    expect(onStats).toHaveBeenCalledTimes(2);
    expect(row()!.turns).toBe(STATS_LIVE_RECOMPUTE_TURNS);
  });

  it('announces nothing for a session it could not compute', () => {
    const { live, onStats } = setup();
    live.end('no-such-session');
    expect(onStats).not.toHaveBeenCalled();
  });
});
