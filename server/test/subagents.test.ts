import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTranscript, type TranscriptEntry } from '../src/transcript/parser.js';
import {
  trackSubagents,
  SubagentTracker,
  SubagentStore,
  SubagentTranscripts,
  MAX_SUBAGENT_MESSAGES,
  type TaskEvent,
} from '../src/transcript/subagents.js';
import type { ChatMessage } from '../src/types.js';

describe('trackSubagents', () => {
  it('marks resolved Task calls ended, open ones working; ignores non-Task tools', () => {
    const entries = parseTranscript(
      readFileSync(join(import.meta.dirname, 'fixtures/transcript-subagents.jsonl'), 'utf8'),
    );
    expect(trackSubagents(entries)).toEqual([
      { id: 'task1', name: 'test-runner', state: 'ended', startedAt: expect.any(Number) },
      { id: 'task2', name: 'docs-writer', state: 'working', startedAt: expect.any(Number) },
    ]);
  });

  it('uses subagent_type fallback when description missing; uses default "subagent" when both missing; ignores unmatched tool_result', () => {
    const entries: import('../src/transcript/parser.js').TranscriptEntry[] = [
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-09-01T11:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'task3', name: 'Task', input: { subagent_type: 'code-reviewer', prompt: 'review code' } },
            { type: 'tool_use', id: 'task4', name: 'Task', input: { prompt: 'do something' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-09-01T11:02:00.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'unmatched', content: 'orphan result' },
            { type: 'tool_result', tool_use_id: 'task3', content: 'review done' },
          ],
        },
      },
    ];
    expect(trackSubagents(entries)).toEqual([
      { id: 'task3', name: 'code-reviewer', state: 'ended', startedAt: expect.any(Number) },
      { id: 'task4', name: 'subagent', state: 'working', startedAt: expect.any(Number) },
    ]);
  });
});

describe('SubagentTracker', () => {
  it('carries state across separate feed() batches: tool_use and its tool_result arriving apart still yield a working then ended transition', () => {
    const tracker = new SubagentTracker();

    const toolUseBatch: TranscriptEntry[] = [
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-09-01T11:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'task1', name: 'Task', input: { description: 'test-runner' } },
          ],
        },
      },
    ];
    expect(tracker.feed(toolUseBatch)).toEqual([
      { id: 'task1', name: 'test-runner', state: 'working', startedAt: expect.any(Number) },
    ]);

    // Delivered as its own batch minutes later, per TranscriptTail's per-append debounce.
    const toolResultBatch: TranscriptEntry[] = [
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-09-01T11:05:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'task1', content: 'tests pass' }],
        },
      },
    ];
    expect(tracker.feed(toolResultBatch)).toEqual([
      { id: 'task1', name: 'test-runner', state: 'ended', startedAt: expect.any(Number) },
    ]);

    const unrelatedBatch: TranscriptEntry[] = [
      {
        type: 'assistant',
        uuid: 'a2',
        timestamp: '2026-09-01T11:06:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } }],
        },
      },
    ];
    expect(tracker.feed(unrelatedBatch)).toEqual([]);
  });
});

describe('SubagentStore', () => {
  const taskUse = (id: string, description: string): TranscriptEntry => ({
    type: 'assistant',
    uuid: `a-${id}`,
    timestamp: '2026-09-01T11:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Task', input: { description } }],
    },
  });
  const taskResult = (id: string): TranscriptEntry => ({
    type: 'user',
    uuid: `u-${id}`,
    timestamp: '2026-09-01T11:05:00.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] },
  });

  it('keeps one tracker per session and reports only the still-running agents through running()', () => {
    const store = new SubagentStore();
    store.feed('s1', [taskUse('t1', 'reviewer')]);
    store.feed('s2', [taskUse('t2', 'tester')]);

    expect(store.running('s1')).toEqual([{ id: 't1', name: 'reviewer', state: 'working', startedAt: expect.any(Number) }]);
    expect(store.running('s2')).toEqual([{ id: 't2', name: 'tester', state: 'working', startedAt: expect.any(Number) }]);
    expect(store.running('unknown')).toEqual([]);

    store.feed('s1', [taskResult('t1')]);
    expect(store.running('s1')).toEqual([]);
    expect(store.running('s2')).toEqual([{ id: 't2', name: 'tester', state: 'working', startedAt: expect.any(Number) }]);
  });

  // task-3 brief §2, test 1: all() must keep an ended agent around; running()
  // must not — that split is the entire point of this task.
  it('all() includes an ended agent; running() does not', () => {
    const store = new SubagentStore();
    store.feed('s1', [taskUse('t1', 'reviewer')]);
    store.feed('s1', [taskResult('t1')]);

    expect(store.running('s1')).toEqual([]);
    expect(store.all('s1')).toEqual([
      { id: 't1', name: 'reviewer', state: 'ended', startedAt: expect.any(Number) },
    ]);
  });

  // task-3 brief §2, test 2: the session-stuck-at-working regression, made
  // explicit. `hasLiveSubagents` in index.ts is `running(id).length > 0`; if
  // ended agents ever leaked into `running()`, a session whose agents had
  // ALL finished would read as still `working` forever.
  it('running() goes empty once every agent has ended, even though all() still lists them', () => {
    const store = new SubagentStore();
    store.feed('s1', [taskUse('t1', 'reviewer')]);
    store.feed('s1', [taskUse('t2', 'tester')]);
    store.feed('s1', [taskResult('t1')]);
    store.feed('s1', [taskResult('t2')]);

    expect(store.running('s1')).toEqual([]); // hasLiveSubagents(s1) would now be false
    expect(store.all('s1')).toHaveLength(2); // but both moons are still on the map
  });

  it('reports whether all() changed, so callers publish only on a real change', () => {
    const store = new SubagentStore();
    expect(store.feed('s1', [taskUse('t1', 'reviewer')])).toBe(true);
    expect(store.feed('s1', [taskUse('t1', 'reviewer')])).toBe(false); // same entry replayed
    expect(store.feed('s1', [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: {} }] } }])).toBe(false);
    expect(store.feed('s1', [taskResult('t1')])).toBe(true);
    expect(store.feed('s1', [taskResult('t1')])).toBe(false); // already ended
  });

  it('drops a session so an ended session leaves no agents behind, running or all', () => {
    const store = new SubagentStore();
    store.feed('s1', [taskUse('t1', 'reviewer')]);
    store.drop('s1');
    expect(store.running('s1')).toEqual([]);
    expect(store.all('s1')).toEqual([]);

    // A dropped session starts from scratch: the old tracker is gone, so a
    // late tool_result for an agent it used to know changes nothing.
    expect(store.feed('s1', [taskResult('t1')])).toBe(false);
  });
});

describe('the subagent tool name', () => {
  const call = (name: string): TranscriptEntry => ({
    type: 'assistant',
    uuid: 'a1',
    timestamp: '2026-09-16T20:00:00.000Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'x1', name, input: { description: 'reviewer', subagent_type: 'general-purpose' } },
      ],
    },
  });

  // Claude Code 2.1.236 spawns subagents with a tool called `Agent`; no
  // transcript on this machine contains a single `Task` tool_use any more.
  // Both names are accepted so old transcripts keep working.
  it('detects the current `Agent` tool', () => {
    expect(trackSubagents([call('Agent')])).toEqual([
      { id: 'x1', name: 'reviewer', state: 'working', startedAt: expect.any(Number) },
    ]);
  });

  it('still detects the older `Task` tool', () => {
    expect(trackSubagents([call('Task')])).toEqual([
      { id: 'x1', name: 'reviewer', state: 'working', startedAt: expect.any(Number) },
    ]);
  });

  it('ignores every other tool', () => {
    expect(trackSubagents([call('Bash')])).toEqual([]);
  });
});

/**
 * The live path. Claude Code 2.1.236 runs `Agent` in the background by
 * default, so the launch `tool_result` arrives while the agent is still
 * working — see `docs/fixes/background-agents-retire-their-moon-at-launch.md`.
 * Liveness therefore comes from the SDK's task events, and these tests pin
 * that the two paths do not interfere.
 */
describe('SubagentTracker task events', () => {
  const started = (over: Partial<TaskEvent & { subtype: 'task_started' }> = {}): TaskEvent =>
    ({
      type: 'system',
      subtype: 'task_started',
      task_id: 'k1',
      tool_use_id: 'toolu_1',
      description: 'reviewer',
      subagent_type: 'code-reviewer',
      task_type: 'local_agent',
      is_backgrounded: true,
      session_id: 's1',
      ...over,
    });

  const notification = (over: Record<string, unknown> = {}): TaskEvent =>
    ({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'k1',
      tool_use_id: 'toolu_1',
      status: 'completed',
      summary: 'Agent "reviewer" finished',
      session_id: 's1',
      ...over,
    });

  const backgroundTasks = (ids: string[]): TaskEvent =>
    ({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: ids.map((task_id) => ({ task_id, task_type: 'local_agent', description: 'x' })),
      session_id: 's1',
    });

  it('registers a started task as working, keyed by task_id and keeping its tool_use_id', () => {
    const tracker = new SubagentTracker();
    expect(tracker.feedTask(started())).toEqual([
      { id: 'k1', name: 'reviewer', state: 'working', toolUseId: 'toolu_1', startedAt: expect.any(Number) },
    ]);
    expect(tracker.running()).toHaveLength(1);
  });

  // task-3 brief §1, test 3.
  it('stamps startedAt on task_started', () => {
    const tracker = new SubagentTracker();
    const before = Date.now();
    const [agent] = tracker.feedTask(started());
    expect(agent.startedAt).toBeGreaterThanOrEqual(before);
    expect(agent.startedAt).toBeLessThanOrEqual(Date.now());
  });

  it('keeps the original startedAt across a resume, rather than restamping it', () => {
    const tracker = new SubagentTracker();
    const [first] = tracker.feedTask(started());
    tracker.feedTask(notification());
    // A resume: the same task_id starts again minutes later.
    const [resumed] = tracker.feedTask(started());
    expect(resumed.startedAt).toBe(first.startedAt);
    expect(resumed.state).toBe('working');
    expect(resumed.status).toBeUndefined(); // going back to work drops the stale terminal status
  });

  it('is not retired by the launch tool_result, which arrives while the agent still runs', () => {
    const tracker = new SubagentTracker();
    tracker.feedTask(started());
    tracker.feed([
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-09-20T11:31:05.968Z',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Async agent launched successfully.' },
          ],
        },
      },
    ]);
    expect(tracker.running()).toEqual([
      { id: 'k1', name: 'reviewer', state: 'working', toolUseId: 'toolu_1', startedAt: expect.any(Number) },
    ]);
  });

  it('ends the agent on its notification, whatever the status says', () => {
    const tracker = new SubagentTracker();
    tracker.feedTask(started());
    expect(tracker.feedTask(notification({ status: 'failed' }))).toEqual([
      { id: 'k1', name: 'reviewer', state: 'ended', status: 'failed', toolUseId: 'toolu_1', startedAt: expect.any(Number) },
    ]);
    expect(tracker.running()).toEqual([]);
  });

  // task-3 brief §1, test 4: `state` folds every outcome into 'ended', but
  // `status` must keep completed and failed apart.
  it('records status separately from state: completed and failed both end the agent, but keep their own status', () => {
    const completedTracker = new SubagentTracker();
    completedTracker.feedTask(started());
    const [completed] = completedTracker.feedTask(notification({ status: 'completed' }));
    expect(completed.state).toBe('ended');
    expect(completed.status).toBe('completed');

    const failedTracker = new SubagentTracker();
    failedTracker.feedTask(started());
    const [failed] = failedTracker.feedTask(notification({ status: 'failed' }));
    expect(failed.state).toBe('ended');
    expect(failed.status).toBe('failed');
  });

  it('falls back to the tool_use_id when the notification names a task_id it never saw', () => {
    const tracker = new SubagentTracker();
    tracker.feedTask(started());
    tracker.feedTask(notification({ task_id: 'other' }));
    expect(tracker.running()).toEqual([]);
  });

  it('names the agent by description, then subagent_type, then a default', () => {
    const tracker = new SubagentTracker();
    tracker.feedTask(started({ description: '' }));
    expect(tracker.running()[0].name).toBe('code-reviewer');
    tracker.feedTask(started({ task_id: 'k2', description: '', subagent_type: undefined }));
    expect(tracker.running().find((a) => a.id === 'k2')!.name).toBe('subagent');
  });

  it('takes a task with no task_type for a subagent only when it has a subagent_type', () => {
    const tracker = new SubagentTracker();
    tracker.feedTask(started({ task_id: 'k2', task_type: undefined }));
    tracker.feedTask(started({ task_id: 'k3', task_type: undefined, subagent_type: undefined }));
    expect(tracker.running().map((a) => a.id)).toEqual(['k2']);
  });

  it('ignores background shells and ambient housekeeping tasks', () => {
    const tracker = new SubagentTracker();
    tracker.feedTask(started({ task_id: 'sh1', task_type: 'local_bash', subagent_type: undefined }));
    tracker.feedTask(started({ task_id: 'am1', ambient: true }));
    expect(tracker.running()).toEqual([]);
  });

  it('puts a resumed agent back to working on a second task_started', () => {
    const tracker = new SubagentTracker();
    tracker.feedTask(started());
    tracker.feedTask(notification());
    expect(tracker.running()).toEqual([]);
    tracker.feedTask(started());
    expect(tracker.running()).toHaveLength(1);
  });

  it('retires a backgrounded agent that vanished from background_tasks_changed', () => {
    const tracker = new SubagentTracker();
    tracker.feedTask(started());
    tracker.feedTask(started({ task_id: 'k2' }));
    expect(tracker.feedTask(backgroundTasks(['k2']))).toEqual([
      { id: 'k1', name: 'reviewer', state: 'ended', toolUseId: 'toolu_1', startedAt: expect.any(Number) },
    ]);
    expect(tracker.running().map((a) => a.id)).toEqual(['k2']);
  });

  // task-3 brief §1, test 5: this is the safety net for a notification that
  // never arrived, so `status` must stay unset — anything else would be
  // claiming knowledge this path does not have.
  it('retires a backgrounded agent with no status, since nothing told us how it went', () => {
    const tracker = new SubagentTracker();
    tracker.feedTask(started());
    const [retired] = tracker.feedTask(backgroundTasks([]));
    expect(retired.state).toBe('ended');
    expect(retired.status).toBeUndefined();
  });

  it('leaves a foreground agent alone — the payload only ever lists background tasks', () => {
    const tracker = new SubagentTracker();
    tracker.feedTask(started({ task_id: 'fg', is_backgrounded: false }));
    expect(tracker.feedTask(backgroundTasks([]))).toEqual([]);
    expect(tracker.running().map((a) => a.id)).toEqual(['fg']);
  });

  it('ignores task_ids in the payload it has never seen, since the two edges are not ordered', () => {
    const tracker = new SubagentTracker();
    expect(tracker.feedTask(backgroundTasks(['unknown']))).toEqual([]);
    expect(tracker.running()).toEqual([]);
  });
});

describe('SubagentStore task events', () => {
  const start = (sessionId: string, taskId: string, description: string): TaskEvent =>
    ({
      type: 'system',
      subtype: 'task_started',
      task_id: taskId,
      tool_use_id: `toolu-${taskId}`,
      description,
      subagent_type: 'general-purpose',
      task_type: 'local_agent',
      is_backgrounded: true,
      session_id: sessionId,
    });
  const finish = (sessionId: string, taskId: string, status: 'completed' | 'failed' | 'stopped' = 'completed'): TaskEvent =>
    ({
      type: 'system',
      subtype: 'task_notification',
      task_id: taskId,
      tool_use_id: `toolu-${taskId}`,
      status,
      summary: 'done',
      session_id: sessionId,
    });

  it('keeps one tracker per session and reports only the still-running agents through running()', () => {
    const store = new SubagentStore();
    store.feedTask('s1', start('s1', 'k1', 'reviewer'));
    store.feedTask('s2', start('s2', 'k2', 'tester'));

    expect(store.running('s1')).toEqual([
      { id: 'k1', name: 'reviewer', state: 'working', toolUseId: 'toolu-k1', startedAt: expect.any(Number) },
    ]);
    store.feedTask('s1', finish('s1', 'k1'));
    expect(store.running('s1')).toEqual([]);
    expect(store.running('s2')).toHaveLength(1);
  });

  it('reports whether all() changed, so callers publish only on a real change', () => {
    const store = new SubagentStore();
    expect(store.feedTask('s1', start('s1', 'k1', 'reviewer'))).toBe(true);
    expect(store.feedTask('s1', start('s1', 'k1', 'reviewer'))).toBe(false); // replayed
    expect(
      store.feedTask('s1', {
        type: 'system',
        subtype: 'task_started',
        task_id: 'sh1',
        description: 'npm test',
        task_type: 'local_bash',
        is_backgrounded: true,
        session_id: 's1',
      }),
    ).toBe(false);
    expect(store.feedTask('s1', finish('s1', 'k1'))).toBe(true);
    expect(store.feedTask('s1', finish('s1', 'k1'))).toBe(false); // already ended, same status
  });

  // task-3 brief §3, test 6 — this is the bug section 3 warns about. Both
  // halves of the old comparison are wrong once ended agents ride in all():
  // (a) it must diff over all(), not running(), and (b) it must compare
  // state+status, not just id. A working -> ended transition alone cannot
  // tell the two apart, because running() shrinking from 1 to 0 already
  // "looks like" a change under either basis. So this asserts the
  // transition IS reported...
  it('reports a change when an agent moves from working to ended', () => {
    const store = new SubagentStore();
    store.feedTask('s1', start('s1', 'k1', 'reviewer'));
    expect(store.feedTask('s1', finish('s1', 'k1'))).toBe(true);
  });

  // ...and this is the test that actually distinguishes the fix from the
  // bug: a SECOND notification for an already-ended agent changes its
  // `status` (completed -> failed) but not its membership in either
  // running() (empty before and after) or an id-only view of all() (the id
  // was already present). Only a diff that is both over all() AND
  // state+status-aware catches this. Against the old code — which compared
  // running() by id only — this reports `false` and the moon never turns
  // red.
  it('reports a change when an already-ended agent gets a second, different status — the case an id-only all() diff would also miss', () => {
    const store = new SubagentStore();
    store.feedTask('s1', start('s1', 'k1', 'reviewer'));
    store.feedTask('s1', finish('s1', 'k1', 'completed'));
    expect(store.all('s1')).toEqual([
      { id: 'k1', name: 'reviewer', state: 'ended', status: 'completed', toolUseId: 'toolu-k1', startedAt: expect.any(Number) },
    ]);

    expect(store.feedTask('s1', finish('s1', 'k1', 'failed'))).toBe(true);
    expect(store.all('s1')).toEqual([
      { id: 'k1', name: 'reviewer', state: 'ended', status: 'failed', toolUseId: 'toolu-k1', startedAt: expect.any(Number) },
    ]);
  });

  describe('dismissal', () => {
    // task-3 brief §4, test 7 — rewritten by the whole-branch review (C2).
    it('dismiss() MARKS the agent in all() and reports a change, rather than removing it', () => {
      const store = new SubagentStore();
      store.feedTask('s1', start('s1', 'k1', 'reviewer'));
      store.feedTask('s1', finish('s1', 'k1'));
      expect(store.all('s1')).toHaveLength(1);
      expect(store.all('s1')[0].dismissed).toBeUndefined();

      expect(store.dismiss('s1', 'k1')).toBe(true);
      // Still here. Subtracting it took the parent transcript's `OPEN →`
      // control and the messages route's `known` check with it, which the
      // spec forbids twice (§§ 5, 8) — `map/sceneModel.ts` is the only
      // reader of the mark.
      expect(store.all('s1')).toHaveLength(1);
      expect(store.all('s1')[0].dismissed).toBe(true);
    });

    it('the mark survives a later state change and does not leak onto the tracker itself', () => {
      const store = new SubagentStore();
      store.feedTask('s1', start('s1', 'k1', 'reviewer'));
      store.dismiss('s1', 'k1');
      store.feedTask('s1', finish('s1', 'k1'));

      const [agent] = store.all('s1');
      expect(agent.state).toBe('ended');
      expect(agent.dismissed).toBe(true);
      // `running()` reads the tracker's own objects, which dismissal never
      // touches — the mark is applied by `all()` on a copy.
      expect(store.running('s1')).toEqual([]);
    });

    it('dismissing an unknown id is a no-op that reports no change, not an error', () => {
      const store = new SubagentStore();
      store.feedTask('s1', start('s1', 'k1', 'reviewer'));

      expect(store.dismiss('s1', 'not-a-real-id')).toBe(false);
      expect(() => store.dismiss('no-such-session', 'x')).not.toThrow();
      expect(store.dismiss('no-such-session', 'x')).toBe(false);
      // The real agent is untouched.
      expect(store.all('s1')).toHaveLength(1);
    });

    it('a still-running agent can be dismissed too, and running() stays unaffected', () => {
      const store = new SubagentStore();
      store.feedTask('s1', start('s1', 'k1', 'reviewer'));

      expect(store.dismiss('s1', 'k1')).toBe(true);
      expect(store.all('s1')[0].dismissed).toBe(true);
      // dismiss() only ever marks what all() reports; running() answers
      // "is the session still waiting", which dismissing the moon does not
      // change — the agent is, in fact, still working.
      expect(store.running('s1')).toHaveLength(1);
      expect(store.running('s1')[0].dismissed).toBeUndefined();
    });

    // task-3 brief §4, test 8.
    it('drop(sessionId) clears dismissals too — a fresh agent with a previously-dismissed id in a new session is visible', () => {
      const store = new SubagentStore();
      store.feedTask('s1', start('s1', 'k1', 'reviewer'));
      store.dismiss('s1', 'k1');
      store.drop('s1');

      // A brand new session, coincidentally reusing the task id.
      store.feedTask('s1', start('s1', 'k1', 'reviewer'));
      expect(store.all('s1')).toEqual([
        { id: 'k1', name: 'reviewer', state: 'working', toolUseId: 'toolu-k1', startedAt: expect.any(Number) },
      ]);
    });
  });
});

describe('SubagentTranscripts', () => {
  const chat = (id: string): ChatMessage => ({ id, role: 'assistant', text: `msg ${id}` });

  it('get() answers undefined for a session/toolUseId pair that has never been appended to', () => {
    const store = new SubagentTranscripts();
    expect(store.get('s1', 'toolu_1')).toBeUndefined();
  });

  it('buffers messages per session+toolUseId and reports zero dropped while under the cap', () => {
    const store = new SubagentTranscripts();
    store.append('s1', 'toolu_1', [chat('a'), chat('b')]);
    store.append('s1', 'toolu_1', [chat('c')]);
    expect(store.get('s1', 'toolu_1')).toEqual({
      messages: [chat('a'), chat('b'), chat('c')],
      droppedCount: 0,
    });
  });

  it('evicts from the front past the cap, keeping the LAST 2000 and reporting the exact dropped count', () => {
    const store = new SubagentTranscripts();
    // One over the cap in a single append, then a few more one at a time —
    // eviction must keep working the same way on both paths.
    const first = Array.from({ length: MAX_SUBAGENT_MESSAGES + 1 }, (_, i) => chat(`m${i}`));
    store.append('s1', 'toolu_1', first);
    let buf = store.get('s1', 'toolu_1')!;
    expect(buf.droppedCount).toBe(1);
    expect(buf.messages).toHaveLength(MAX_SUBAGENT_MESSAGES);
    expect(buf.messages[0].id).toBe('m1'); // m0 was the one evicted
    expect(buf.messages.at(-1)!.id).toBe(`m${MAX_SUBAGENT_MESSAGES}`);

    store.append('s1', 'toolu_1', [chat('extra1'), chat('extra2')]);
    buf = store.get('s1', 'toolu_1')!;
    expect(buf.droppedCount).toBe(3); // 1 from before, 2 more just now
    expect(buf.messages).toHaveLength(MAX_SUBAGENT_MESSAGES);
    expect(buf.messages.at(-1)!.id).toBe('extra2');
  });

  it('keys two toolUseIds in the same session as two separate buffers — the nested-agent case', () => {
    const store = new SubagentTranscripts();
    store.append('s1', 'outer', [chat('o1')]);
    store.append('s1', 'inner', [chat('i1')]);
    expect(store.get('s1', 'outer')).toEqual({ messages: [chat('o1')], droppedCount: 0 });
    expect(store.get('s1', 'inner')).toEqual({ messages: [chat('i1')], droppedCount: 0 });
  });

  it('drop(sessionId) forgets every agent of that session and leaves another session alone', () => {
    const store = new SubagentTranscripts();
    store.append('s1', 'toolu_1', [chat('a')]);
    store.append('s1', 'toolu_2', [chat('b')]);
    store.append('s2', 'toolu_3', [chat('c')]);

    store.drop('s1');

    expect(store.get('s1', 'toolu_1')).toBeUndefined();
    expect(store.get('s1', 'toolu_2')).toBeUndefined();
    expect(store.get('s2', 'toolu_3')).toEqual({ messages: [chat('c')], droppedCount: 0 });
  });

  it("a buffer survives its agent ending — nothing here reacts to task events, unlike SubagentStore", () => {
    // Two independent stores, exactly as `server/src/index.ts` wires them:
    // `SubagentStore` tracks liveness from task events, `SubagentTranscripts`
    // only ever hears `append()`. Retiring the agent in one must not touch
    // the other — a frozen panel on a finished agent needs the buffer to
    // still be there.
    const subagents = new SubagentStore();
    const transcripts = new SubagentTranscripts();

    subagents.feedTask('s1', {
      type: 'system', subtype: 'task_started',
      task_id: 'k1', tool_use_id: 'toolu_1', description: 'reviewer',
      task_type: 'local_agent', is_backgrounded: true, session_id: 's1',
    });
    transcripts.append('s1', 'toolu_1', [chat('a'), chat('b')]);
    expect(subagents.running('s1')).toHaveLength(1); // still running

    subagents.feedTask('s1', {
      type: 'system', subtype: 'task_notification',
      task_id: 'k1', tool_use_id: 'toolu_1', status: 'completed', summary: 'done', session_id: 's1',
    });
    expect(subagents.running('s1')).toEqual([]); // the moon would stop being "live" here
    // ...but it is still on the map: `all()` keeps it, unlike the old `get()`.
    expect(subagents.all('s1')).toHaveLength(1);

    // The buffer never heard any of that and answers exactly as before.
    expect(transcripts.get('s1', 'toolu_1')).toEqual({
      messages: [chat('a'), chat('b')],
      droppedCount: 0,
    });
  });
});
