import { describe, it, expect, vi, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/database.js';
import { backgroundTasks as backgroundTasksTable, sessions } from '../src/db/schema.js';
import {
  BackgroundTaskStore,
  BackgroundTaskTracker,
  EXIT_CODE_RETRIES,
  EXIT_CODE_RETRY_MS,
  type LaunchingCall,
} from '../src/transcript/backgroundTasks.js';
import { SubagentTracker, type TaskEvent } from '../src/transcript/subagents.js';
import {
  OUTPUT_TAIL_BYTES,
  OutputFollower,
  completeUtf8Length,
  parseExitCode,
  readExitCode,
  readOutputTail,
} from '../src/files/taskOutput.js';

const started = (over: Record<string, unknown>): TaskEvent =>
  ({ type: 'system', subtype: 'task_started', session_id: 's', description: 'task', ...over }) as TaskEvent;
const notified = (task_id: string, status: string, over: Record<string, unknown> = {}): TaskEvent =>
  ({ type: 'system', subtype: 'task_notification', session_id: 's', task_id, status, summary: '', ...over }) as TaskEvent;
const updated = (task_id: string, patch: Record<string, unknown>): TaskEvent =>
  ({ type: 'system', subtype: 'task_updated', session_id: 's', task_id, patch }) as TaskEvent;
const changed = (ids: string[]): TaskEvent =>
  ({
    type: 'system', subtype: 'background_tasks_changed', session_id: 's',
    tasks: ids.map((task_id) => ({ task_id, task_type: 'local_bash', description: '' })),
  }) as TaskEvent;

/** The launching calls a Runner would have seen, by tool_use id. */
function calls(map: Record<string, LaunchingCall>) {
  return (id: string) => map[id];
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'orbital-bg-'));
}

describe('BackgroundTaskTracker', () => {
  it('keeps the four tracked task types and nothing else', () => {
    const t = new BackgroundTaskTracker();
    const none = calls({});
    for (const [id, task_type] of [
      ['a', 'local_bash'], ['b', 'monitor_mcp'], ['c', 'local_workflow'], ['d', 'mcp_task'],
      ['e', 'local_agent'], ['f', 'remote_agent'], ['g', 'monitor_ws'], ['h', 'dream'],
      ['i', 'in_process_teammate'], ['j', 'auto_mode_scan'], ['k', undefined],
    ] as const) {
      t.feedTask(started({ task_id: id, task_type, is_backgrounded: true }), none);
    }
    expect(t.all().map((x) => [x.id, x.kind])).toEqual([
      ['a', 'shell'], ['b', 'monitor'], ['c', 'workflow'], ['d', 'mcp'],
    ]);
  });

  it('drops ambient tasks, and ignores them in background_tasks_changed', () => {
    const t = new BackgroundTaskTracker();
    t.feedTask(started({ task_id: 'amb', task_type: 'local_bash', ambient: true }), calls({}));
    t.feedTask(started({ task_id: 'real', task_type: 'mcp_task' }), calls({}));
    expect(t.all().map((x) => x.id)).toEqual(['real']);
    // An ambient task in the live set neither adds a task nor keeps one alive.
    const ambientOnly = {
      type: 'system', subtype: 'background_tasks_changed', session_id: 's',
      tasks: [{ task_id: 'amb', task_type: 'local_bash', description: '', ambient: true }],
    } as TaskEvent;
    t.feedTask(ambientOnly, calls({}));
    expect(t.all()).toEqual([expect.objectContaining({ id: 'real', state: 'ended' })]);
  });

  it('tells a Monitor from a Bash by the launching call, and takes the command from it', () => {
    const t = new BackgroundTaskTracker();
    const launched = calls({
      tb: { name: 'Bash', input: { command: 'npm run dev', run_in_background: true } },
      tm: { name: 'Monitor', input: { command: 'tail -f log' } },
    });
    t.feedTask(started({ task_id: 'b', task_type: 'local_bash', tool_use_id: 'tb', is_backgrounded: true, description: 'dev server' }), launched);
    t.feedTask(started({ task_id: 'm', task_type: 'local_bash', tool_use_id: 'tm', is_backgrounded: true, description: 'watch log' }), launched);
    // No launching call the Runner saw: a shell, with no command.
    t.feedTask(started({ task_id: 'u', task_type: 'local_bash', tool_use_id: 'unseen', is_backgrounded: true }), launched);
    expect(t.all()).toEqual([
      { id: 'b', kind: 'shell', label: 'dev server', command: 'npm run dev', state: 'running', startedAt: expect.any(Number), toolUseId: 'tb', hasOutput: false },
      { id: 'm', kind: 'monitor', label: 'watch log', command: 'tail -f log', state: 'running', startedAt: expect.any(Number), toolUseId: 'tm', hasOutput: false },
      { id: 'u', kind: 'shell', label: 'task', state: 'running', startedAt: expect.any(Number), toolUseId: 'unseen', hasOutput: false },
    ]);
  });

  it('labels a workflow by its workflow_name when it has one', () => {
    const t = new BackgroundTaskTracker();
    t.feedTask(started({ task_id: 'w1', task_type: 'local_workflow', workflow_name: 'spec', description: 'run spec' }), calls({}));
    t.feedTask(started({ task_id: 'w2', task_type: 'local_workflow', description: 'run spec' }), calls({}));
    expect(t.all().map((x) => x.label)).toEqual(['spec', 'run spec']);
  });

  it('hides a foreground Bash until task_updated moves it to the background', () => {
    const t = new BackgroundTaskTracker();
    const r1 = t.feedTask(started({ task_id: 'fg', task_type: 'local_bash', is_backgrounded: false }), calls({}));
    expect(r1.changed).toEqual([]);
    expect(t.all()).toEqual([]);
    expect(t.running()).toEqual([]);
    // Nor does the level signal judge it: foreground work is never in it.
    t.feedTask(changed([]), calls({}));
    const r2 = t.feedTask(updated('fg', { is_backgrounded: true }), calls({}));
    expect(r2.changed).toHaveLength(1);
    expect(t.running().map((x) => x.id)).toEqual(['fg']);
  });

  it('never shows a foreground Bash that ends in the foreground', () => {
    const t = new BackgroundTaskTracker();
    t.feedTask(started({ task_id: 'fg1', task_type: 'local_bash', is_backgrounded: false }), calls({}));
    t.feedTask(started({ task_id: 'fg2', task_type: 'local_bash', is_backgrounded: false }), calls({}));
    expect(t.feedTask(notified('fg1', 'completed'), calls({})).changed).toEqual([]);
    expect(t.feedTask(updated('fg2', { status: 'completed' }), calls({})).changed).toEqual([]);
    // Even a later move to the background cannot bring one back.
    t.feedTask(updated('fg1', { is_backgrounded: true }), calls({}));
    expect(t.all()).toEqual([]);
  });

  it('ends a task on its notification, with the status it reports', () => {
    const t = new BackgroundTaskTracker();
    t.feedTask(started({ task_id: 'a', task_type: 'mcp_task' }), calls({}));
    t.feedTask(notified('a', 'failed'), calls({}));
    expect(t.all()).toEqual([expect.objectContaining({ id: 'a', state: 'ended', status: 'failed', endedAt: expect.any(Number) })]);
    expect(t.running()).toEqual([]);
  });

  it('ends a task on a terminal task_updated, killed reading as stopped', () => {
    const t = new BackgroundTaskTracker();
    for (const id of ['k', 'c', 'f', 'p']) t.feedTask(started({ task_id: id, task_type: 'local_workflow' }), calls({}));
    t.feedTask(updated('k', { status: 'killed' }), calls({}));
    t.feedTask(updated('c', { status: 'completed' }), calls({}));
    t.feedTask(updated('f', { status: 'failed' }), calls({}));
    t.feedTask(updated('p', { status: 'paused' }), calls({}));
    expect(t.all().map((x) => [x.id, x.state, x.status])).toEqual([
      ['k', 'ended', 'stopped'], ['c', 'ended', 'completed'], ['f', 'ended', 'failed'], ['p', 'running', undefined],
    ]);
  });

  it('ends a running task missing from background_tasks_changed, without a status', () => {
    const t = new BackgroundTaskTracker();
    t.feedTask(started({ task_id: 'a', task_type: 'local_bash', is_backgrounded: true }), calls({}));
    t.feedTask(started({ task_id: 'b', task_type: 'local_bash', is_backgrounded: true }), calls({}));
    const r = t.feedTask(changed(['b']), calls({}));
    expect(r.changed.map((x) => x.id)).toEqual(['a']);
    const a = t.all().find((x) => x.id === 'a')!;
    expect(a.state).toBe('ended');
    expect(a).not.toHaveProperty('status');
    // Its notification, arriving late, still says how it went; the end time stands.
    const endedAt = a.endedAt;
    t.feedTask(notified('a', 'completed'), calls({}));
    expect(t.all().find((x) => x.id === 'a')).toEqual(expect.objectContaining({ status: 'completed', endedAt }));
  });

  it('ends every running task without a status when the process exits, and drops hidden ones', () => {
    const t = new BackgroundTaskTracker();
    t.feedTask(started({ task_id: 'run', task_type: 'local_bash', is_backgrounded: true }), calls({}));
    t.feedTask(started({ task_id: 'done', task_type: 'mcp_task' }), calls({}));
    t.feedTask(notified('done', 'completed'), calls({}));
    t.feedTask(started({ task_id: 'fg', task_type: 'local_bash', is_backgrounded: false }), calls({}));
    const r = t.endAll();
    expect(r.changed.map((x) => x.id)).toEqual(['run']);
    expect(t.all().map((x) => [x.id, x.state, x.status])).toEqual([
      ['run', 'ended', undefined], ['done', 'ended', 'completed'],
    ]);
    // A foreground task that was dropped cannot be revived into view.
    t.feedTask(updated('fg', { is_backgrounded: true }), calls({}));
    expect(t.all()).toHaveLength(2);
  });

  it('takes the output path from the launch result, or failing that from the notification', () => {
    const t = new BackgroundTaskTracker();
    const launched = calls({
      early: { name: 'Bash', input: { command: 'a' }, outputPath: '/tmp/x/early.output' },
      late: { name: 'Bash', input: { command: 'b' } },
    });
    t.feedTask(started({ task_id: 'e', task_type: 'local_bash', tool_use_id: 'early', is_backgrounded: true }), launched);
    t.feedTask(started({ task_id: 'l', task_type: 'local_bash', tool_use_id: 'late', is_backgrounded: true }), launched);
    t.feedTask(started({ task_id: 'n', task_type: 'local_bash', is_backgrounded: true }), launched);
    expect(t.record('e')?.outputPath).toBe('/tmp/x/early.output');
    expect(t.setOutputPath('late', '/tmp/x/late.output')?.id).toBe('l');
    // Not an absolute path: not a file the CLI named.
    expect(t.setOutputPath('late', 'relative.output')).toBeUndefined();
    t.feedTask(notified('n', 'completed', { output_file: '/tmp/x/n.output' }), launched);
    expect(t.all().map((x) => x.hasOutput)).toEqual([true, true, true]);
    expect(t.record('n')?.outputPath).toBe('/tmp/x/n.output');
  });
});

describe('SubagentTracker and task_updated', () => {
  it('reads task_updated harmlessly and leaves background tasks alone', () => {
    const t = new SubagentTracker();
    expect(t.feedTask(started({ task_id: 'sh', task_type: 'local_bash', is_backgrounded: true }))).toEqual([]);
    expect(t.feedTask(updated('sh', { status: 'killed' }))).toEqual([]);
    expect(t.all()).toEqual([]);
  });
});

describe('parseExitCode', () => {
  it('reads the closing line, allowing trailing blank lines', () => {
    expect(parseExitCode('hello\n\n[exited with code 0]\n')).toBe(0);
    expect(parseExitCode('boom\n\n[exited with code 137]')).toBe(137);
    expect(parseExitCode('x\n[exited with code 2]\n\n\n')).toBe(2);
  });

  it('is absent when the last non-empty line is anything else', () => {
    expect(parseExitCode('')).toBeUndefined();
    expect(parseExitCode('still running\n')).toBeUndefined();
    expect(parseExitCode('[exited with code 1]\nmore output\n')).toBeUndefined();
    expect(parseExitCode('echo [exited with code 1]\n')).toBeUndefined();
  });

  it('reads the file end, and is absent for a missing file', () => {
    const dir = tempDir();
    const path = join(dir, 't.output');
    writeFileSync(path, `${'x'.repeat(5000)}\n\n[exited with code 3]\n`);
    expect(readExitCode(path)).toBe(3);
    expect(readExitCode(join(dir, 'missing.output'))).toBeUndefined();
  });
});

describe('BackgroundTaskStore', () => {
  afterEach(() => vi.useRealTimers());

  function dbWithSession(dir = tempDir()) {
    const dbPath = join(dir, 'index.db');
    const db = openDb(dbPath);
    db.insert(sessions).values({ id: 's', projectDir: '', cwd: '/w', source: 'web' }).run();
    return { db, dbPath };
  }

  it('reads the exit code when a shell ends, and again shortly after if the line was not written yet', () => {
    vi.useFakeTimers();
    const dir = tempDir();
    const path = join(dir, 'a.output');
    writeFileSync(path, 'working\n');
    const onChange = vi.fn();
    const store = new BackgroundTaskStore({ onChange });
    const launched = calls({ t: { name: 'Bash', input: { command: 'make' }, outputPath: path } });
    store.feedTask('s', started({ task_id: 'a', task_type: 'local_bash', tool_use_id: 't', is_backgrounded: true }), launched);
    store.feedTask('s', notified('a', 'completed'), launched);
    expect(store.get('s', 'a')).not.toHaveProperty('exitCode');
    appendFileSync(path, '\n[exited with code 0]\n');
    vi.advanceTimersByTime(EXIT_CODE_RETRY_MS);
    expect(store.get('s', 'a')?.exitCode).toBe(0);
    expect(onChange).toHaveBeenCalledWith('s');
  });

  it('gives up on an exit code that never appears', () => {
    vi.useFakeTimers();
    const readExitCode = vi.fn(() => undefined);
    const store = new BackgroundTaskStore({ readExitCode });
    const launched = calls({ t: { name: 'Bash', input: {}, outputPath: '/tmp/none.output' } });
    store.feedTask('s', started({ task_id: 'a', task_type: 'local_bash', tool_use_id: 't', is_backgrounded: true }), launched);
    store.endAll('s');
    vi.advanceTimersByTime(EXIT_CODE_RETRY_MS * (EXIT_CODE_RETRIES + 3));
    expect(readExitCode).toHaveBeenCalledTimes(EXIT_CODE_RETRIES + 1);
    expect(store.get('s', 'a')).not.toHaveProperty('exitCode');
  });

  it('reads no exit code for workflows and MCP tasks', () => {
    const readExitCode = vi.fn(() => 0);
    const store = new BackgroundTaskStore({ readExitCode });
    store.feedTask('s', started({ task_id: 'w', task_type: 'local_workflow' }));
    store.feedTask('s', notified('w', 'completed', { output_file: '/tmp/w.output' }));
    expect(readExitCode).not.toHaveBeenCalled();
    expect(store.get('s', 'w')).not.toHaveProperty('exitCode');
  });

  it('survives a restart, and a task stored as running comes back ended without a status', () => {
    const { db, dbPath } = dbWithSession();
    const store = new BackgroundTaskStore({ db, readExitCode: () => 7, now: () => 1000 });
    const launched = calls({
      t1: { name: 'Bash', input: { command: 'npm test' }, outputPath: '/tmp/t1.output' },
      t2: { name: 'Monitor', input: { command: 'tail -f x' } },
    });
    store.feedTask('s', started({ task_id: 'done', task_type: 'local_bash', tool_use_id: 't1', is_backgrounded: true, description: 'tests' }), launched);
    store.feedTask('s', notified('done', 'failed'), launched);
    store.feedTask('s', started({ task_id: 'live', task_type: 'local_bash', tool_use_id: 't2', is_backgrounded: true, description: 'watch' }), launched);
    // A hidden foreground task is never written.
    store.feedTask('s', started({ task_id: 'fg', task_type: 'local_bash', is_backgrounded: false }), launched);
    expect(db.select().from(backgroundTasksTable).all()).toHaveLength(2);
    const before = store.all('s');
    db.$client.close();

    const reopened = openDb(dbPath);
    const next = new BackgroundTaskStore({ db: reopened, readExitCode: () => undefined, now: () => 5000 });
    next.load();
    expect(next.all('s')).toEqual([
      before[0],
      { id: 'live', kind: 'monitor', label: 'watch', command: 'tail -f x', state: 'ended', startedAt: 1000, endedAt: 5000, toolUseId: 't2', hasOutput: false },
    ]);
    expect(before[0]).toEqual(expect.objectContaining({ id: 'done', status: 'failed', exitCode: 7, endedAt: 1000, hasOutput: true }));
    expect(next.running('s')).toEqual([]);
    expect(next.outputPath('s', 'done')).toBe('/tmp/t1.output');
    // The end made at load is written back, so a second restart agrees.
    const third = new BackgroundTaskStore({ db: reopened, now: () => 9000 });
    third.load();
    expect(third.get('s', 'live')?.endedAt).toBe(5000);
    reopened.$client.close();
  });

  it('answers whether all() changed, so a message that moves nothing does not republish', () => {
    const store = new BackgroundTaskStore();
    expect(store.feedTask('s', started({ task_id: 'x', task_type: 'local_agent' }))).toBe(false);
    expect(store.feedTask('s', started({ task_id: 'a', task_type: 'mcp_task' }))).toBe(true);
    expect(store.feedTask('s', changed(['a']))).toBe(false);
    expect(store.feedTask('s', notified('a', 'completed'))).toBe(true);
    expect(store.feedTask('s', notified('a', 'completed'))).toBe(false);
    expect(store.endAll('s')).toBe(false);
  });
});

describe('readOutputTail', () => {
  it('returns a small file whole, with its byte offsets', () => {
    const path = join(tempDir(), 'a.output');
    writeFileSync(path, 'héllo\nworld\n');
    expect(readOutputTail(path)).toEqual({ text: 'héllo\nworld\n', start: 0, end: Buffer.byteLength('héllo\nworld\n') });
  });

  it('cuts a long file forward to the first line start inside the tail', () => {
    const path = join(tempDir(), 'b.output');
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') + '\n';
    writeFileSync(path, lines);
    const size = Buffer.byteLength(lines);
    const tail = readOutputTail(path, 30)!;
    expect(tail.end).toBe(size);
    expect(tail.start).toBeGreaterThan(size - 30);
    expect(lines.slice(tail.start)).toBe(tail.text);
    expect(tail.text.startsWith('line ')).toBe(true);
  });

  it('keeps a tail with no line break at all, cut only to a whole character', () => {
    const path = join(tempDir(), 'c.output');
    writeFileSync(path, 'ééééé'); // ten bytes, no newline
    const tail = readOutputTail(path, 5)!;
    // Byte 5 is the middle of a character: the cut moves to the next one.
    expect(tail).toEqual({ text: 'éé', start: 6, end: 10 });
  });

  it('holds back a character split at the end of the file', () => {
    const path = join(tempDir(), 'd.output');
    writeFileSync(path, Buffer.concat([Buffer.from('ok\n'), Buffer.from('€').subarray(0, 2)]));
    expect(readOutputTail(path)).toEqual({ text: 'ok\n', start: 0, end: 3 });
  });

  it('is null for a file that no longer exists', () => {
    expect(readOutputTail(join(tempDir(), 'gone.output'))).toBeNull();
  });
});

describe('completeUtf8Length', () => {
  it('counts only whole characters', () => {
    const euro = Buffer.from('€'); // three bytes
    const emoji = Buffer.from('😀'); // four bytes
    expect(completeUtf8Length(Buffer.from('abc'))).toBe(3);
    expect(completeUtf8Length(Buffer.concat([Buffer.from('a'), euro]))).toBe(4);
    expect(completeUtf8Length(Buffer.concat([Buffer.from('a'), euro.subarray(0, 1)]))).toBe(1);
    expect(completeUtf8Length(Buffer.concat([Buffer.from('a'), euro.subarray(0, 2)]))).toBe(1);
    expect(completeUtf8Length(emoji)).toBe(4);
    expect(completeUtf8Length(emoji.subarray(0, 3))).toBe(0);
  });
});

describe('OutputFollower', () => {
  it('publishes appended bytes from the end of the file, at their byte offsets, never splitting a character', () => {
    const path = join(tempDir(), 'f.output');
    writeFileSync(path, 'before\n');
    const out: Array<[number, string]> = [];
    const gone = vi.fn();
    const f = new OutputFollower(path, (offset, text) => out.push([offset, text]), gone, 60_000);
    f.start();
    f.tick();
    expect(out).toEqual([]);
    const euro = Buffer.from('€');
    appendFileSync(path, Buffer.concat([Buffer.from('a'), euro.subarray(0, 1)]));
    f.tick();
    appendFileSync(path, Buffer.concat([euro.subarray(1), Buffer.from('b\n')]));
    f.tick();
    expect(out).toEqual([[7, 'a'], [8, '€b\n']]);
    rmSync(path);
    f.tick();
    expect(gone).toHaveBeenCalledTimes(1);
    f.stop();
  });

  it('skips forward when the file outruns a tick by more than the tail', () => {
    const path = join(tempDir(), 'g.output');
    writeFileSync(path, '');
    const out: Array<[number, string]> = [];
    const f = new OutputFollower(path, (offset, text) => out.push([offset, text]), () => {}, 60_000);
    f.start();
    appendFileSync(path, 'x'.repeat(OUTPUT_TAIL_BYTES + 10));
    f.tick();
    expect(out).toHaveLength(1);
    expect(out[0][0]).toBe(10);
    expect(out[0][1]).toHaveLength(OUTPUT_TAIL_BYTES);
    f.stop();
  });

  it('reports a file missing at the start as gone', () => {
    const gone = vi.fn();
    new OutputFollower(join(tempDir(), 'none.output'), () => {}, gone, 60_000).start();
    expect(gone).toHaveBeenCalledTimes(1);
  });
});
