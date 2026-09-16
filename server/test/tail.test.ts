import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptTail } from '../src/watcher/tail.js';

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
