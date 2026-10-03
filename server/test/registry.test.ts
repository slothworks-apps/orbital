import { describe, it, expect } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SessionRegistry } from '../src/watcher/registry.js';
import { makeTmpDir } from './tmp.js';

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
    const dir = makeTmpDir('reg');
    writeEntry(dir, 100, 'sess-a', 'busy');
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
    writeEntry(dir, 200, 'sess-b', 'busy');
    reg.scan();
    expect(events.sort()).toEqual(['rm:sess-a', 'up:sess-b:working']);
  });
  it('maps the CLI status vocabulary onto orbital session statuses', () => {
    // `~/.claude/sessions/<pid>.json` carries the CLI's own vocabulary --
    // "busy" | "shell" | "idle" | "waiting" -- and never orbital's "working".
    const dir = makeTmpDir('reg3');
    const cases: Array<[raw: string, want: string]> = [
      ['busy', 'working'],
      ['shell', 'working'],
      ['waiting', 'needs_input'],
      ['idle', 'idle'],
      ['nonsense-from-a-newer-cli', 'idle'],
    ];
    cases.forEach(([raw], i) => writeEntry(dir, 400 + i, `sess-${raw}`, raw));
    const reg = new SessionRegistry(dir, { isPidAlive: () => true });
    reg.scan();
    expect(Object.fromEntries(reg.all().map((s) => [s.sessionId, s.status]))).toEqual(
      Object.fromEntries(cases.map(([raw, want]) => [`sess-${raw}`, want])),
    );
  });
  it('skips entries written by SDK-spawned CLIs (entrypoint sdk-*)', () => {
    // The CLI Orbital's own runner spawns registers itself in
    // `~/.claude/sessions` like any other, with `entrypoint: "sdk-ts"`. Listing
    // it would make Orbital treat its own session as "live in a terminal" —
    // read-only composer, 409 on the model route. Only interactive terminals
    // (`entrypoint: "cli"`) belong in the registry.
    const dir = makeTmpDir('reg4');
    writeFileSync(
      join(dir, '500.json'),
      JSON.stringify({
        pid: 500, sessionId: 'sess-sdk', cwd: '/p', name: 's-500', status: 'idle',
        kind: 'interactive', entrypoint: 'sdk-ts', startedAt: 1, updatedAt: 2,
      }),
    );
    writeEntry(dir, 501, 'sess-terminal', 'idle'); // no entrypoint field — older CLI, keep it
    const reg = new SessionRegistry(dir, { isPidAlive: () => true });
    reg.scan();
    expect(reg.all().map((s) => s.sessionId)).toEqual(['sess-terminal']);
  });

  it('survives corrupt registry files', () => {
    const dir = makeTmpDir('reg2');
    writeFileSync(join(dir, '1.json'), 'not json');
    const reg = new SessionRegistry(dir, { isPidAlive: () => true });
    expect(() => reg.scan()).not.toThrow();
    expect(reg.all()).toHaveLength(0);
  });
});
