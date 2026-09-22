import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTranscript, type TranscriptEntry } from '../src/transcript/parser.js';
import { trackSubagents, SubagentTracker, SubagentStore, type TaskEvent } from '../src/transcript/subagents.js';

describe('trackSubagents', () => {
  it('marks resolved Task calls ended, open ones working; ignores non-Task tools', () => {
    const entries = parseTranscript(
      readFileSync(join(import.meta.dirname, 'fixtures/transcript-subagents.jsonl'), 'utf8'),
    );
    expect(trackSubagents(entries)).toEqual([
      { id: 'task1', name: 'test-runner', state: 'ended' },
      { id: 'task2', name: 'docs-writer', state: 'working' },
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
      { id: 'task3', name: 'code-reviewer', state: 'ended' },
      { id: 'task4', name: 'subagent', state: 'working' },
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
      { id: 'task1', name: 'test-runner', state: 'working' },
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
      { id: 'task1', name: 'test-runner', state: 'ended' },
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

  it('keeps one tracker per session and reports only the still-running agents', () => {
    const store = new SubagentStore();
    store.feed('s1', [taskUse('t1', 'reviewer')]);
    store.feed('s2', [taskUse('t2', 'tester')]);

    expect(store.get('s1')).toEqual([{ id: 't1', name: 'reviewer', state: 'working' }]);
    expect(store.get('s2')).toEqual([{ id: 't2', name: 'tester', state: 'working' }]);
    expect(store.get('unknown')).toEqual([]);

    store.feed('s1', [taskResult('t1')]);
    expect(store.get('s1')).toEqual([]);
    expect(store.get('s2')).toEqual([{ id: 't2', name: 'tester', state: 'working' }]);
  });

  it('reports whether the running set changed, so callers publish only on a real change', () => {
    const store = new SubagentStore();
    expect(store.feed('s1', [taskUse('t1', 'reviewer')])).toBe(true);
    expect(store.feed('s1', [taskUse('t1', 'reviewer')])).toBe(false); // same entry replayed
    expect(store.feed('s1', [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: {} }] } }])).toBe(false);
    expect(store.feed('s1', [taskResult('t1')])).toBe(true);
    expect(store.feed('s1', [taskResult('t1')])).toBe(false); // already ended
  });

  it('drops a session so an ended session leaves no agents behind', () => {
    const store = new SubagentStore();
    store.feed('s1', [taskUse('t1', 'reviewer')]);
    store.drop('s1');
    expect(store.get('s1')).toEqual([]);

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
      { id: 'x1', name: 'reviewer', state: 'working' },
    ]);
  });

  it('still detects the older `Task` tool', () => {
    expect(trackSubagents([call('Task')])).toEqual([
      { id: 'x1', name: 'reviewer', state: 'working' },
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
      { id: 'k1', name: 'reviewer', state: 'working', toolUseId: 'toolu_1' },
    ]);
    expect(tracker.running()).toHaveLength(1);
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
      { id: 'k1', name: 'reviewer', state: 'working', toolUseId: 'toolu_1' },
    ]);
  });

  it('ends the agent on its notification, whatever the status says', () => {
    const tracker = new SubagentTracker();
    tracker.feedTask(started());
    expect(tracker.feedTask(notification({ status: 'failed' }))).toEqual([
      { id: 'k1', name: 'reviewer', state: 'ended', toolUseId: 'toolu_1' },
    ]);
    expect(tracker.running()).toEqual([]);
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
      { id: 'k1', name: 'reviewer', state: 'ended', toolUseId: 'toolu_1' },
    ]);
    expect(tracker.running().map((a) => a.id)).toEqual(['k2']);
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
  const finish = (sessionId: string, taskId: string): TaskEvent =>
    ({
      type: 'system',
      subtype: 'task_notification',
      task_id: taskId,
      tool_use_id: `toolu-${taskId}`,
      status: 'completed',
      summary: 'done',
      session_id: sessionId,
    });

  it('keeps one tracker per session and reports only the still-running agents', () => {
    const store = new SubagentStore();
    store.feedTask('s1', start('s1', 'k1', 'reviewer'));
    store.feedTask('s2', start('s2', 'k2', 'tester'));

    expect(store.get('s1')).toEqual([
      { id: 'k1', name: 'reviewer', state: 'working', toolUseId: 'toolu-k1' },
    ]);
    store.feedTask('s1', finish('s1', 'k1'));
    expect(store.get('s1')).toEqual([]);
    expect(store.get('s2')).toHaveLength(1);
  });

  it('reports whether the running set changed, so callers publish only on a real change', () => {
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
    expect(store.feedTask('s1', finish('s1', 'k1'))).toBe(false); // already ended
  });
});
