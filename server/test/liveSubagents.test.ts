import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubagentStore } from '../src/transcript/subagents.js';
import { LiveSubagentWatcher } from '../src/watcher/liveSubagents.js';
import type { LiveSession, SessionRegistry } from '../src/watcher/registry.js';

const TASK_USE = (id: string, description: string) =>
  `${JSON.stringify({
    type: 'assistant',
    uuid: `a-${id}`,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Task', input: { description } }],
    },
  })}\n`;

const TASK_RESULT = (id: string) =>
  `${JSON.stringify({
    type: 'user',
    uuid: `u-${id}`,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  })}\n`;

/** A registry stand-in: the watcher only ever reads `all()` and the two events. */
function fakeRegistry(live: LiveSession[] = []) {
  const emitter = new EventEmitter() as EventEmitter & SessionRegistry;
  const sessions = new Map(live.map((s) => [s.sessionId, s]));
  (emitter as any).all = () => [...sessions.values()];
  (emitter as any).get = (id: string) => sessions.get(id);
  (emitter as any).add = (s: LiveSession) => {
    sessions.set(s.sessionId, s);
    emitter.emit('upsert', s);
  };
  (emitter as any).kill = (id: string) => {
    sessions.delete(id);
    emitter.emit('remove', id);
  };
  return emitter as EventEmitter & SessionRegistry & { add(s: LiveSession): void; kill(id: string): void };
}

const liveSession = (sessionId: string): LiveSession => ({
  sessionId, pid: 1, cwd: '/w', name: sessionId,
  status: 'working', kind: 'cli', startedAt: 0, updatedAt: 0,
});

function setup(opts: { enabled?: boolean; live?: LiveSession[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'orbital-live-'));
  const store = new SubagentStore();
  const registry = fakeRegistry(opts.live ?? []);
  const changed: string[] = [];
  const watcher = new LiveSubagentWatcher({
    registry,
    store,
    enabled: opts.enabled ?? true,
    transcriptPath: (id) => join(dir, `${id}.jsonl`),
    onChange: (id) => changed.push(id),
  });
  return { dir, store, registry, changed, watcher, file: (id: string) => join(dir, `${id}.jsonl`) };
}

describe('LiveSubagentWatcher', () => {
  it('catches up on a subagent that was already running before orbital looked', async () => {
    const s = setup({ live: [liveSession('s1')] });
    writeFileSync(s.file('s1'), TASK_USE('t1', 'reviewer'));
    await new Promise((r) => setTimeout(r, 5));

    s.watcher.start();

    expect(s.store.get('s1')).toEqual([{ id: 't1', name: 'reviewer', state: 'working' }]);
    expect(s.changed).toEqual(['s1']);
    s.watcher.stop();
  });

  it('follows the transcript afterwards, without the session being selected', async () => {
    const s = setup({ live: [liveSession('s1')] });
    writeFileSync(s.file('s1'), '');
    await new Promise((r) => setTimeout(r, 5));
    s.watcher.start();
    expect(s.store.get('s1')).toEqual([]);

    appendFileSync(s.file('s1'), TASK_USE('t1', 'reviewer'));
    await vi.waitFor(() => expect(s.store.get('s1')).toHaveLength(1), { timeout: 3000 });
    expect(s.changed).toEqual(['s1']);

    appendFileSync(s.file('s1'), TASK_RESULT('t1'));
    await vi.waitFor(() => expect(s.store.get('s1')).toEqual([]), { timeout: 3000 });
    expect(s.changed).toEqual(['s1', 's1']);
    s.watcher.stop();
  });

  it('picks up a session that goes live after start', async () => {
    const s = setup();
    s.watcher.start();
    writeFileSync(s.file('s2'), TASK_USE('t2', 'tester'));
    await new Promise((r) => setTimeout(r, 5));

    s.registry.add(liveSession('s2'));

    expect(s.store.get('s2')).toEqual([{ id: 't2', name: 'tester', state: 'working' }]);
    s.watcher.stop();
  });

  it('drops a session that leaves the registry, so its agents stop being reported', async () => {
    const s = setup({ live: [liveSession('s1')] });
    writeFileSync(s.file('s1'), TASK_USE('t1', 'reviewer'));
    await new Promise((r) => setTimeout(r, 5));
    s.watcher.start();
    s.changed.length = 0;

    s.registry.kill('s1');

    expect(s.store.get('s1')).toEqual([]);
    expect(s.changed).toEqual(['s1']);
    s.watcher.stop();
  });

  it('watches nothing while disabled, and catches up when switched on', async () => {
    const s = setup({ enabled: false, live: [liveSession('s1')] });
    writeFileSync(s.file('s1'), TASK_USE('t1', 'reviewer'));
    await new Promise((r) => setTimeout(r, 5));

    s.watcher.start();
    expect(s.store.get('s1')).toEqual([]);

    s.watcher.setEnabled(true);
    expect(s.store.get('s1')).toEqual([{ id: 't1', name: 'reviewer', state: 'working' }]);

    // Switching off again must not leave a stale "running" agent on the map.
    s.watcher.setEnabled(false);
    expect(s.store.get('s1')).toEqual([]);
    s.watcher.stop();
  });

  it('survives a transcript that is not on disk yet and picks it up later', async () => {
    const s = setup({ live: [liveSession('s1')] });
    s.watcher.start();
    expect(s.store.get('s1')).toEqual([]);

    writeFileSync(s.file('s1'), TASK_USE('t1', 'reviewer'));
    await new Promise((r) => setTimeout(r, 5));
    s.watcher.sync();

    expect(s.store.get('s1')).toEqual([{ id: 't1', name: 'reviewer', state: 'working' }]);
    s.watcher.stop();
  });
});
