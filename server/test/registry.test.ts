import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRegistry } from '../src/watcher/registry.js';

function writeEntry(dir: string, pid: number, sessionId: string, status: string) {
  writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({
      pid, sessionId, cwd: '/p', name: `s-${pid}`, status,
      kind: 'interactive', startedAt: 1, updatedAt: 2,
    }),
  );
}

describe('SessionRegistry.scan', () => {
  it('emits upsert for live sessions and remove for vanished ones; drops dead pids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-reg-'));
    writeEntry(dir, 100, 'sess-a', 'working');
    writeEntry(dir, 200, 'sess-b', 'idle');
    writeEntry(dir, 300, 'sess-dead', 'idle');
    const alive = new Set([100, 200]);
    const reg = new SessionRegistry(dir, { isPidAlive: (pid) => alive.has(pid) });
    const events: string[] = [];
    reg.on('upsert', (s) => events.push(`up:${s.sessionId}:${s.status}`));
    reg.on('remove', (id) => events.push(`rm:${id}`));
    reg.scan();
    expect(events.sort()).toEqual(['up:sess-a:working', 'up:sess-b:idle']);
    expect(reg.all()).toHaveLength(2);

    events.length = 0;
    rmSync(join(dir, '100.json'));
    writeEntry(dir, 200, 'sess-b', 'working');
    reg.scan();
    expect(events.sort()).toEqual(['rm:sess-a', 'up:sess-b:working']);
  });
  it('survives corrupt registry files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-reg2-'));
    writeFileSync(join(dir, '1.json'), 'not json');
    const reg = new SessionRegistry(dir, { isPidAlive: () => true });
    expect(() => reg.scan()).not.toThrow();
    expect(reg.all()).toHaveLength(0);
  });
});
