import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROGRESS_TOOL, type ProgressItem } from '@orbital/shared/progress';
import {
  CLI_TASK_TOOLS, FROZEN_REFUSAL, ProgressService, SUBAGENT_REFUSAL, foldProgress, progressRefusal,
} from '../src/progress/service.js';
import type { TranscriptEntry } from '../src/transcript/parser.js';
import { makeTmpDir } from './tmp.js';

const list: ProgressItem[] = [
  { title: 'Read the spec', state: 'done' },
  { title: 'Write the parser', state: 'in_progress' },
  { title: 'Wire the route', state: 'pending' },
];

describe('progressRefusal', () => {
  it('lets the first list through without a reason, and a new list only with one', () => {
    expect(progressRefusal(null, { items: list }, false)).toBeNull();
    expect(progressRefusal(null, { items: list, new_list: true }, false)).toBeNull();
    const next = [{ title: 'Other task', state: 'pending' as const }];
    expect(progressRefusal(list, { items: next, new_list: true }, false)).toMatch(/A new list needs `reason`/);
    expect(progressRefusal(list, { items: next, new_list: true, reason: ' ' }, false)).toMatch(/A new list needs `reason`/);
    expect(progressRefusal(list, { items: next, new_list: true, reason: 'The user asked for something else.' }, false)).toBeNull();
  });

  it('lets a change of states alone through', () => {
    expect(progressRefusal(list, { items: list.map((item) => ({ ...item, state: 'done' as const })) }, false)).toBeNull();
  });

  it('refuses every call once a harness leads', () => {
    expect(progressRefusal(list, { items: list }, true)).toBe(FROZEN_REFUSAL);
    expect(progressRefusal(null, { items: list }, true)).toBe(FROZEN_REFUSAL);
  });

  it('refuses an empty list, a blank title and a repeated one', () => {
    expect(progressRefusal(null, { items: [] }, false)).toMatch(/at least one item/);
    expect(progressRefusal(null, { items: [{ title: ' ', state: 'pending' }] }, false)).toMatch(/needs a title/);
    expect(progressRefusal(null, { items: [list[0], list[0]] }, false)).toMatch(/"Read the spec" appears more than once/);
  });

  it('refuses a dropped item without its own reason, unless it was dropped with one before', () => {
    const drop = [list[0], { title: 'Write the parser', state: 'dropped' as const }, list[2]];
    expect(progressRefusal(list, { items: drop, reason: 'Not needed.' }, false)).toMatch(/needs its own `reason`: "Write the parser"/);
    expect(progressRefusal(null, { items: drop }, false)).toMatch(/needs its own `reason`/);
    const dropped = [list[0], { title: 'Write the parser', state: 'dropped' as const, reason: 'Not needed.' }, list[2]];
    expect(progressRefusal(dropped, { items: drop }, false)).toBeNull();
  });

  it('refuses an item left out, and asks for it as dropped', () => {
    const refusal = progressRefusal(list, { items: [list[0], list[2]], reason: 'Not needed.' }, false);
    expect(refusal).toMatch(/send "Write the parser" with state "dropped"/);
    // One dropped before may be left out: it stays where it was.
    const dropped = [list[0], { title: 'Write the parser', state: 'dropped' as const, reason: 'Not needed.' }, list[2]];
    expect(progressRefusal(dropped, { items: [list[0], list[2]] }, false)).toBeNull();
  });

  it('refuses an add or a drop without the call\'s reason, and names what changed', () => {
    const added = [...list, { title: 'Add a test', state: 'pending' as const }];
    expect(progressRefusal(list, { items: added }, false)).toMatch(/This call adds "Add a test"\. Say why in `reason`/);
    expect(progressRefusal(list, { items: added, reason: '  ' }, false)).toMatch(/Say why/);
    expect(progressRefusal(list, { items: added, reason: 'The user asked for one.' }, false)).toBeNull();
    const drop = [list[0], { title: 'Write the parser', state: 'dropped' as const, reason: 'Exists.' }, list[2]];
    expect(progressRefusal(list, { items: drop }, false)).toMatch(/This call drops "Write the parser"/);
  });
});

/** An assistant entry calling the tool, chained after `parent`. */
function call(uuid: string, parent: string | null, id: string, input: unknown, extra: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    type: 'assistant', uuid, parentUuid: parent,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: PROGRESS_TOOL, input }] }, ...extra,
  };
}

/** The user entry carrying a call's result. */
function result(uuid: string, parent: string, id: string, isError = false): TranscriptEntry {
  return {
    type: 'user', uuid, parentUuid: parent,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', ...(isError ? { is_error: true } : {}) }] },
  };
}

describe('foldProgress', () => {
  it('is null for a transcript without a call', () => {
    expect(foldProgress([])).toBeNull();
  });

  it('folds the accepted calls, and not a refused one or one without a result', () => {
    const entries = [
      call('a1', null, 't1', { items: list }),
      result('u1', 'a1', 't1'),
      call('a2', 'u1', 't2', { items: [] }),
      result('u2', 'a2', 't2', true),
      call('a3', 'u2', 't3', { items: list.map((item) => ({ ...item, state: 'done' })) }),
      result('u3', 'a3', 't3'),
      call('a4', 'u3', 't4', { items: [{ title: 'Unfinished', state: 'pending' }], new_list: true }),
    ];
    expect(foldProgress(entries)?.map((item) => item.state)).toEqual(['done', 'done', 'done']);
  });

  it('leaves out a subagent\'s calls and a branch a rewind left behind', () => {
    const entries = [
      call('a1', null, 't1', { items: list }),
      result('u1', 'a1', 't1'),
      call('s1', 'u1', 't2', { items: [{ title: 'Sub', state: 'pending' }], new_list: true }, { isSidechain: true }),
      result('s2', 's1', 't2'),
      // Abandoned: a prompt and its turn, which the rewind forked from u1 into b1.
      { type: 'user', uuid: 'p2', parentUuid: 'u1', message: { role: 'user', content: 'next task' } },
      call('a2', 'p2', 't3', { items: [{ title: 'Gone', state: 'pending' }], new_list: true }),
      result('u2', 'a2', 't3'),
      { type: 'user', uuid: 'b1', parentUuid: 'u1', message: { role: 'user', content: 'try again' } },
    ];
    expect(foldProgress(entries)).toEqual(list);
  });
});

/** A service over a transcript file, with a freeze and a rewind's cut that can be set. */
function makeService(entries: TranscriptEntry[] = []) {
  const dir = makeTmpDir('progress');
  const path = join(dir, 's.jsonl');
  const write = (all: TranscriptEntry[]) =>
    writeFileSync(path, all.map((e) => JSON.stringify(e)).join('\n') + (all.length ? '\n' : ''));
  write(entries);
  const state = { enabled: true, frozenAt: null as number | null, cut: null as string | null, changes: [] as string[] };
  const service = new ProgressService({
    isEnabled: () => state.enabled,
    frozenAt: () => state.frozenAt,
    transcriptPathOf: () => path,
    rewindCut: () => state.cut,
    onChange: (id) => state.changes.push(id),
  });
  return { service, state, write };
}

const row = { id: 's', progress_list: true, progress_frozen_at: null };

describe('ProgressService', () => {
  it('reads the list from the transcript, and carries it as a figure', () => {
    const { service } = makeService([call('a1', null, 't1', { items: list }), result('u1', 'a1', 't1')]);
    expect(service.figureOf(row)).toEqual({ done: 1, total: 3, frozen: false, frozenAt: null });
    expect(service.figureOf({ ...row, progress_list: false })).toBeNull();
    expect(service.figureOf({ ...row, progress_frozen_at: 5 })).toEqual({ done: 1, total: 3, frozen: true, frozenAt: 5 });
  });

  it('carries no figure while the Labs switch is off', () => {
    const { service, state } = makeService([call('a1', null, 't1', { items: list }), result('u1', 'a1', 't1')]);
    state.enabled = false;
    expect(service.figureOf(row)).toBeNull();
  });

  it('follows a rewind: a pending cut takes its calls back, and so does the new branch once it lands', () => {
    const second = { items: [{ title: 'Other task', state: 'pending' }], new_list: true, reason: 'New task.' };
    const before = [
      call('a1', null, 't1', { items: list }),
      result('u1', 'a1', 't1'),
      { type: 'user', uuid: 'p2', parentUuid: 'u1', message: { role: 'user', content: 'next task' } } as TranscriptEntry,
      call('a2', 'p2', 't2', second),
      result('u2', 'a2', 't2'),
    ];
    const { service, state, write } = makeService(before);
    expect(service.figureOf(row)).toMatchObject({ done: 0, total: 1 });

    // Picked: the branch is cut before p2, and the list with it.
    state.cut = 'p2';
    service.forget('s');
    expect(service.figureOf(row)).toMatchObject({ done: 1, total: 3 });

    // Sent: read before the new branch is written, the cut still holds.
    service.sessionTools('s', true);
    service.rewindSent('s');
    expect(service.figureOf(row)).toMatchObject({ done: 1, total: 3 });

    // The new branch lands: the old prompt is off the live branch, and a
    // write of another session leaves this one's list alone.
    write([...before, { type: 'user', uuid: 'b1', parentUuid: 'u1', message: { role: 'user', content: 'try again' } }]);
    state.cut = null;
    service.transcriptsWritten(['other']);
    expect(state.changes).toEqual([]);
    service.transcriptsWritten(['s']);
    expect(state.changes).toEqual(['s']);
    expect(service.figureOf(row)).toMatchObject({ done: 1, total: 3 });
    // Read once: a later write is not folded again.
    service.transcriptsWritten(['s']);
    expect(state.changes).toEqual(['s']);
  });

  it('is null before the first list', () => {
    expect(makeService().service.figureOf(row)).toBeNull();
  });

  it('writes an accepted call and publishes it, and refuses one against the current list', () => {
    const { service, state } = makeService();
    expect(service.write('s', { items: list })).toEqual({ ok: true, text: 'Written: 1 of 3 done.' });
    expect(state.changes).toEqual(['s']);
    expect(service.write('s', { items: [list[0]] }).ok).toBe(false);
    expect(service.figureOf(row)).toEqual({ done: 1, total: 3, frozen: false, frozenAt: null });
    state.frozenAt = 5;
    expect(service.write('s', { items: list })).toEqual({ ok: false, text: FROZEN_REFUSAL });
    expect(state.changes).toEqual(['s']);
  });

  it('gives the tool only to a session started with a list, while Labs is on and no harness froze it', () => {
    const { service, state } = makeService();
    expect(service.sessionTools('s', false)).toBeUndefined();
    const tools = service.sessionTools('s', true)!;
    expect(tools.tools).toHaveLength(1);
    expect(tools.allowedTools).toEqual([PROGRESS_TOOL]);
    expect(tools.disallowedTools).toEqual([...CLI_TASK_TOOLS]);
    expect(service.instructs('s', true)).toBe(true);
    state.frozenAt = 5;
    expect(service.sessionTools('s', true)).toEqual({ tools: [], allowedTools: [], disallowedTools: [...CLI_TASK_TOOLS] });
    expect(service.instructs('s', true)).toBe(false);
    state.enabled = false;
    expect(service.sessionTools('s', true)).toBeUndefined();
    expect(service.instructs('s', true)).toBe(false);
  });

  it('refuses the tool to a subagent, and lets the main session through', async () => {
    const hook = makeService().service.sessionTools('s', true)!.preToolUse![0];
    expect(hook.matcher).toBe(PROGRESS_TOOL);
    const base = {
      hook_event_name: 'PreToolUse' as const, session_id: 's', transcript_path: '', cwd: '/',
      tool_name: PROGRESS_TOOL, tool_input: { items: list }, tool_use_id: 't',
    };
    const signal = new AbortController().signal;
    expect(await hook.hooks[0]({ ...base }, 't', { signal })).toEqual({});
    expect(await hook.hooks[0]({ ...base, agent_id: 'agent-1' }, 't', { signal })).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: SUBAGENT_REFUSAL },
    });
  });
});
