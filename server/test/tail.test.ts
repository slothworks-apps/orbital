import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
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
    const tail = new TranscriptTail(file);
    const seen = collect(tail);
    tail.start();
    expect(seen).toEqual(['u1']);
    appendFileSync(file, LINE2);
    await vi.waitFor(() => expect(seen).toEqual(['u1', 'a1']), { timeout: 2000 });
    tail.stop();
  });
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
