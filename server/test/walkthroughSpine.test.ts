import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '../src/types.js';
import { buildWalkthrough } from '../src/walkthrough/spine.js';

let seq = 0;
const ts = (s: number) => new Date(Date.UTC(2026, 8, 9, 14, 0, s)).toISOString();
const user = (text: string, s = seq++): ChatMessage => ({ id: `u${s}:0`, role: 'user', text, timestamp: ts(s) });
const say = (text: string, s = seq++): ChatMessage => ({ id: `a${s}:0`, role: 'assistant', text, timestamp: ts(s) });
const call = (toolName: string, toolInput: unknown, id: string, s = seq++): ChatMessage =>
  ({ id: `a${s}:1`, role: 'tool_use', toolName, toolInput, toolUseId: id, timestamp: ts(s) });
const result = (id: string, text = 'ok', isError = false, s = seq++): ChatMessage =>
  ({ id: `r${s}:0`, role: 'tool_result', toolUseId: id, text, timestamp: ts(s), ...(isError ? { isError: true } : {}) });
const edit = (path: string, from: string, to: string, id: string) =>
  [call('Edit', { file_path: path, old_string: from, new_string: to }, id), result(id)];
const read = (path: string, id: string) => [call('Read', { file_path: path }, id), result(id, 'contents')];

const none = new Map<string, ChatMessage[]>();

describe('buildWalkthrough — steps and gaps', () => {
  it('a run with a write is a step whose narration is the text before it', () => {
    const w = buildWalkthrough([
      user('fix it'), say('Reading first.'), ...read('a.ts', 'r1'),
      say('Adding the margin.'), ...edit('a.ts', 'x', 'y', 'e1'),
    ], none);
    expect(w.steps).toHaveLength(1);
    expect(w.steps[0]).toMatchObject({ id: 'e1', ordinal: 1, narration: 'Adding the margin.' });
    expect(w.steps[0].calls).toHaveLength(1);
    expect(w.steps[0].calls[0].result?.toolUseId).toBe('e1');
  });

  it('reads and searches before the step become a gap; the step\'s own reads fold into it', () => {
    const w = buildWalkthrough([
      user('go'), say('Looking.'), ...read('a.ts', 'r1'), ...read('b.ts', 'r2'),
      say('Now the change.'), ...read('c.ts', 'r3'), ...edit('a.ts', 'x', 'y', 'e1'),
    ], none);
    expect(w.timeline[0]).toMatchObject({ kind: 'gap', folded: { Read: 2 }, said: 'Looking.' });
    expect(w.timeline[1]).toEqual({ kind: 'step', id: 'e1' });
    expect(w.steps[0].folded).toEqual({ Read: 1 });
  });

  it('a run straight after the user turn has empty narration', () => {
    const w = buildWalkthrough([user('edit a.ts'), ...edit('a.ts', 'x', 'y', 'e1')], none);
    expect(w.steps[0].narration).toBe('');
  });

  it('two writes in one run are one step with two calls', () => {
    const w = buildWalkthrough([
      user('go'), say('Both files.'), ...edit('a.ts', 'x', 'y', 'e1'), ...edit('b.ts', 'p', 'q', 'e2'),
    ], none);
    expect(w.steps).toHaveLength(1);
    expect(w.steps[0].calls.map((c) => c.call.toolUseId)).toEqual(['e1', 'e2']);
  });

  it('step ids are stable when messages are appended', () => {
    const base = [user('go'), say('One.'), ...edit('a.ts', 'x', 'y', 'e1')];
    const before = buildWalkthrough(base, none);
    const after = buildWalkthrough([...base, say('Two.'), ...edit('b.ts', 'p', 'q', 'e2')], none);
    expect(after.steps[0].id).toBe(before.steps[0].id);
    expect(after.steps[1]).toMatchObject({ id: 'e2', ordinal: 2 });
  });

  it('a session with no writes has no steps and one gap', () => {
    const w = buildWalkthrough([user('look'), say('Reading.'), ...read('a.ts', 'r1')], none);
    expect(w.steps).toEqual([]);
    expect(w.timeline).toHaveLength(1);
    expect(w.files).toEqual([]);
  });

  it('durations come from timestamps and are null without them', () => {
    const w = buildWalkthrough([
      user('go'), say('x'), call('Edit', { file_path: 'a', old_string: 'x', new_string: 'y' }, 'e1', 10), result('e1', 'ok', false, 14),
    ], none);
    expect(w.steps[0].durationMs).toBe(4000);
    const bare: ChatMessage[] = [
      { id: 'u:0', role: 'user', text: 'go' },
      { id: 'a:1', role: 'tool_use', toolName: 'Edit', toolInput: { file_path: 'a', old_string: 'x', new_string: 'y' }, toolUseId: 'e1' },
      { id: 'r:0', role: 'tool_result', toolUseId: 'e1', text: 'ok' },
    ];
    expect(buildWalkthrough(bare, none).steps[0].durationMs).toBeNull();
  });

  it('lastMessageId is the last message seen', () => {
    const msgs = [user('go'), ...edit('a.ts', 'x', 'y', 'e1')];
    expect(buildWalkthrough(msgs, none).lastMessageId).toBe(msgs[msgs.length - 1].id);
    expect(buildWalkthrough([], none).lastMessageId).toBeNull();
  });
});

describe('buildWalkthrough — fate', () => {
  it('a later edit whose old_string contains this new_string marks revised, both ways', () => {
    const w = buildWalkthrough([
      user('go'), say('1'), ...edit('a.ts', 'const skew = 0;', 'const skew = 30_000;', 'e1'),
      say('2'), ...edit('a.ts', 'const skew = 30_000;', 'const skew = config.skew;', 'e2'),
    ], none);
    expect(w.steps[0].fate).toEqual([{ kind: 'revised', byStep: 'e2', path: 'a.ts' }]);
    expect(w.steps[1].fate).toEqual([]);
  });

  it('a later edit whose new_string equals this old_string marks reverted', () => {
    const w = buildWalkthrough([
      user('go'), say('1'), ...edit('a.ts', 'A', 'B', 'e1'),
      say('2'), ...edit('a.ts', 'B', 'A', 'e2'),
    ], none);
    expect(w.steps[0].fate).toEqual([{ kind: 'reverted', byStep: 'e2', path: 'a.ts' }]);
  });

  it('a Write over a path an earlier step wrote is revised; identical content to the replaced text is reverted', () => {
    const w = buildWalkthrough([
      user('go'), say('1'), ...edit('a.ts', 'A', 'B', 'e1'),
      say('2'), call('Write', { file_path: 'a.ts', content: 'A' }, 'w1'), result('w1', 'The file a.ts has been updated.'),
      say('3'), ...edit('b.ts', 'p', 'q', 'e3'),
      say('4'), call('Write', { file_path: 'b.ts', content: 'zzz' }, 'w2'), result('w2', 'The file b.ts has been updated.'),
    ], none);
    expect(w.steps[0].fate).toEqual([{ kind: 'reverted', byStep: 'w1', path: 'a.ts' }]);
    expect(w.steps[2].fate).toEqual([{ kind: 'revised', byStep: 'w2', path: 'b.ts' }]);
  });

  it('does not compare a step with itself or with an edit on another path', () => {
    const w = buildWalkthrough([
      user('go'), say('1'), ...edit('a.ts', 'A', 'A', 'e1'), ...edit('a.ts', 'A', 'A', 'e2'),
      say('2'), ...edit('b.ts', 'A', 'B', 'e3'),
    ], none);
    expect(w.steps[0].fate).toEqual([]);
    expect(w.steps[1].fate).toEqual([]);
  });

  it('records a later step once per path even when it matches several of this step\'s calls', () => {
    const w = buildWalkthrough([
      user('go'), say('1'), ...edit('a.ts', 'p', 'B1', 'e1'), ...edit('a.ts', 'q', 'B2', 'e2'),
      say('2'), ...edit('a.ts', 'B1 B2', 'z', 'e3'),
    ], none);
    expect(w.steps[0].fate).toEqual([{ kind: 'revised', byStep: 'e3', path: 'a.ts' }]);
  });

  it('a failed call takes no part in fate', () => {
    const w = buildWalkthrough([
      user('go'), say('1'), ...edit('a.ts', 'A', 'B', 'e1'),
      say('2'), call('Edit', { file_path: 'a.ts', old_string: 'B', new_string: 'A' }, 'e2'), result('e2', 'old_string not found', true),
    ], none);
    expect(w.steps[0].fate).toEqual([]);
  });
});

describe('buildWalkthrough — files', () => {
  it('lists every path with its steps, creation, fate and failure', () => {
    const w = buildWalkthrough([
      user('go'), say('1'), call('Write', { file_path: 'new.ts', content: 'x' }, 'w1'), result('w1', 'File created successfully at: new.ts'),
      say('2'), ...edit('a.ts', 'A', 'B', 'e1'),
      say('3'), ...edit('a.ts', 'B', 'A', 'e2'),
      say('4'), call('Edit', { file_path: 'cfg.json', old_string: 'q', new_string: 'r' }, 'e3'), result('e3', 'old_string not found', true),
    ], none);
    expect(w.files).toEqual([
      { path: 'new.ts', steps: ['w1'], created: true, fate: null, notApplied: false },
      { path: 'a.ts', steps: ['e1', 'e2'], created: false, fate: 'reverted', notApplied: false },
      { path: 'cfg.json', steps: ['e3'], created: false, fate: null, notApplied: true },
    ]);
  });
});

describe('buildWalkthrough — subagents', () => {
  const agentMsgs = (id: string): ChatMessage[] => [
    { id: `${id}-u:0`, role: 'user', text: 'do it', timestamp: ts(1) },
    { id: `${id}-a:0`, role: 'assistant', text: 'Fixing restore().', timestamp: ts(2) },
    { id: `${id}-a:1`, role: 'tool_use', toolName: 'Edit', toolInput: { file_path: 's.ts', old_string: 'x', new_string: 'y' }, toolUseId: `${id}-e1`, timestamp: ts(3) },
    { id: `${id}-r:0`, role: 'tool_result', toolUseId: `${id}-e1`, text: 'ok', timestamp: ts(4) },
  ];

  it('a dispatch whose transcript wrote is a step with sub-steps', () => {
    const subs = new Map([['ag1', agentMsgs('ag1')]]);
    const w = buildWalkthrough([
      user('go'), say('Dispatching.'),
      call('Agent', { description: 'callers', prompt: 'Update every caller', subagent_type: 'general-purpose' }, 'ag1'),
      result('ag1', 'done'),
    ], subs);
    expect(w.steps).toHaveLength(1);
    expect(w.steps[0].id).toBe('ag1');
    expect(w.steps[0].subagent).toMatchObject({ name: 'callers', prompt: 'Update every caller' });
    expect(w.steps[0].subagent?.steps[0]).toMatchObject({ id: 'ag1-e1', narration: 'Fixing restore().' });
    expect(w.files).toEqual([{ path: 's.ts', steps: ['ag1'], created: false, fate: null, notApplied: false }]);
  });

  it('each writing dispatch in a run is its own step, in run order', () => {
    const subs = new Map([['ag1', agentMsgs('ag1')], ['ag2', agentMsgs('ag2').map((m) =>
      m.role === 'tool_use' ? { ...m, toolInput: { file_path: 't.ts', old_string: 'x', new_string: 'y' } } : m)]]);
    const w = buildWalkthrough([
      user('go'), say('All of it.'), ...read('a.ts', 'r1'), ...edit('a.ts', 'x', 'y', 'e1'),
      call('Agent', { description: 'one', prompt: 'p1' }, 'ag1'), result('ag1', 'done'),
      call('Agent', { description: 'two', prompt: 'p2' }, 'ag2'), result('ag2', 'done'),
    ], subs);
    expect(w.steps.map((s) => s.id)).toEqual(['e1', 'ag1', 'ag2']);
    expect(w.steps.map((s) => s.narration)).toEqual(['All of it.', 'All of it.', 'All of it.']);
    expect(w.timeline).toEqual([{ kind: 'step', id: 'e1' }, { kind: 'step', id: 'ag1' }, { kind: 'step', id: 'ag2' }]);
    expect(w.steps[0]).toMatchObject({ subagent: null, folded: { Read: 1 } });
    expect(w.steps[1].folded).toEqual({});
    expect(w.steps[2].folded).toEqual({});
    expect(w.files.map((f) => [f.path, f.steps])).toEqual([['a.ts', ['e1']], ['s.ts', ['ag1']], ['t.ts', ['ag2']]]);
  });

  it('a dispatch that wrote nothing is a gap fact, by description', () => {
    const subs = new Map([['ag1', agentMsgs('ag1').slice(0, 2)]]);
    const w = buildWalkthrough([
      user('go'), say('Surveying.'),
      call('Agent', { description: 'survey callers', prompt: 'p', subagent_type: 'x' }, 'ag1'), result('ag1', 'done'),
      say('Now.'), ...edit('a.ts', 'x', 'y', 'e1'),
    ], subs);
    expect(w.steps).toHaveLength(1);
    expect(w.timeline[0]).toMatchObject({ kind: 'gap', subagents: ['survey callers'], folded: {} });
  });

  it('a dispatch with no transcript on disk is a gap fact too', () => {
    const w = buildWalkthrough([
      user('go'), call('Agent', { description: 'd', prompt: 'p' }, 'ag1'), result('ag1', 'done'),
    ], none);
    expect(w.steps).toEqual([]);
    expect(w.timeline[0]).toMatchObject({ kind: 'gap', subagents: ['d'] });
  });
});

describe('buildWalkthrough — narration and questions', () => {
  const narrateTurn = (s = seq++): ChatMessage => ({
    id: `u${s}:0`, role: 'user', text: '', timestamp: ts(s),
    command: { name: 'walkthrough · narrate', body: '<orbital-walkthrough kind="narrate">x</orbital-walkthrough>', blocks: 1, walkthrough: { kind: 'narrate' } },
  });
  const askTurn = (step: string, q: string, s = seq++): ChatMessage => ({
    id: `u${s}:0`, role: 'user', text: q, timestamp: ts(s),
    command: { name: 'walkthrough · ask · step 1', body: `<orbital-walkthrough kind="ask" step="${step}" n="1">ctx</orbital-walkthrough>`, blocks: 1, walkthrough: { kind: 'ask', step, n: 1 } },
  });

  it('reads the last narration, counts steps added after it, and keeps its answer out of gaps and narrations', () => {
    const w = buildWalkthrough([
      user('go'), say('1'), ...edit('a.ts', 'x', 'y', 'e1'),
      narrateTurn(), say('```json\n{"intents":[{"title":"T","summary":"S","steps":["e1"]}]}\n```'),
      user('more'), say('2'), ...edit('b.ts', 'p', 'q', 'e2'),
    ], none);
    expect(w.narration).toEqual({ intents: [{ title: 'T', summary: 'S', steps: ['e1'], considered: [], abandoned: false }, { title: '', summary: '', steps: ['e2'], considered: [], abandoned: false }], staleSteps: 1 });
    expect(w.narrationFailed).toBe(false);
    expect(w.steps[1].narration).toBe('2');
    expect(w.timeline.some((t) => t.kind === 'gap' && t.said.includes('intents'))).toBe(false);
  });

  it('a narration whose answer has no json block is a visible failure', () => {
    const w = buildWalkthrough([
      user('go'), say('1'), ...edit('a.ts', 'x', 'y', 'e1'),
      narrateTurn(), say('I cannot do that right now.'),
    ], none);
    expect(w.narration).toBeNull();
    expect(w.narrationFailed).toBe(true);
  });

  it('a narrate turn with no answer yet is neither a narration nor a failure', () => {
    const w = buildWalkthrough([user('go'), say('1'), ...edit('a.ts', 'x', 'y', 'e1'), narrateTurn()], none);
    expect(w.narration).toBeNull();
    expect(w.narrationFailed).toBe(false);
  });

  it('attaches a question and its answer to the step the tag names', () => {
    const ask = askTurn('e1', 'Why?');
    const w = buildWalkthrough([
      user('go'), say('1'), ...edit('a.ts', 'x', 'y', 'e1'),
      ask, say('Because.'),
      askTurn('e1', 'Sure?'),
    ], none);
    expect(w.steps[0].questions).toEqual([
      { question: 'Why?', answer: 'Because.', messageId: ask.id },
      { question: 'Sure?', answer: null, messageId: expect.any(String) },
    ]);
  });

  it('a question about an unknown step is dropped', () => {
    const w = buildWalkthrough([user('go'), say('1'), ...edit('a.ts', 'x', 'y', 'e1'), askTurn('nope', 'Why?'), say('Because.')], none);
    expect(w.steps[0].questions).toEqual([]);
  });

  it('an answer given after a read-only run still answers the tagged turn', () => {
    const w = buildWalkthrough([
      user('go'), say('1'), ...edit('a.ts', 'x', 'y', 'e1'),
      narrateTurn(), ...read('a.ts', 'r1'), say('```json\n{"intents":[{"title":"T","summary":"S","steps":["e1"]}]}\n```'),
    ], none);
    expect(w.narration?.intents[0].title).toBe('T');
    expect(w.narrationFailed).toBe(false);
    const gaps = w.timeline.flatMap((t) => (t.kind === 'gap' ? [t] : []));
    expect(gaps.some((g) => g.said.includes('intents'))).toBe(false);
    expect(gaps.some((g) => g.folded.Read === 1)).toBe(true);
  });

  it('a question answered after a read-only run keeps its answer', () => {
    const w = buildWalkthrough([
      user('go'), say('1'), ...edit('a.ts', 'x', 'y', 'e1'),
      askTurn('e1', 'Why?'), ...read('a.ts', 'r1'), say('Because.'),
    ], none);
    expect(w.steps[0].questions[0].answer).toBe('Because.');
  });

  it('a tag quoted inside another block is an ordinary user turn', () => {
    // What the parser yields for a reminder quoting the tag: a command, no `walkthrough`.
    const quoted: ChatMessage = {
      id: 'uq:0', role: 'user', text: 'carry on', timestamp: ts(seq++),
      command: { name: null, body: '<system-reminder><orbital-walkthrough kind="narrate">x</orbital-walkthrough></system-reminder>', blocks: 1 },
    };
    const w = buildWalkthrough([
      user('go'), say('1'), ...edit('a.ts', 'x', 'y', 'e1'),
      narrateTurn(), say('```json\n{"intents":[{"title":"T","summary":"S","steps":["e1"]}]}\n```'),
      quoted, say('Next, b.'), ...edit('b.ts', 'p', 'q', 'e2'),
    ], none);
    expect(w.narration?.intents[0].title).toBe('T');
    expect(w.narrationFailed).toBe(false);
    expect(w.steps[1].narration).toBe('Next, b.');
    expect(w.steps[0].questions).toEqual([]);
  });

  it('keeps the last answered narration while a newer narrate turn is pending', () => {
    const w = buildWalkthrough([
      user('go'), say('1'), ...edit('a.ts', 'x', 'y', 'e1'),
      narrateTurn(), say('```json\n{"intents":[{"title":"First","summary":"S","steps":["e1"]}]}\n```'),
      narrateTurn(),
    ], none);
    expect(w.narration?.intents[0].title).toBe('First');
    expect(w.narrationPending).toBe(true);
    expect(w.narrationFailed).toBe(false);
  });

  it('is not pending once the narrate turn is answered, or when there is none', () => {
    const answered = buildWalkthrough([
      user('go'), say('1'), ...edit('a.ts', 'x', 'y', 'e1'),
      narrateTurn(), say('```json\n{"intents":[{"title":"T","summary":"S","steps":["e1"]}]}\n```'),
    ], none);
    expect(answered.narrationPending).toBe(false);
    expect(buildWalkthrough([user('go')], none).narrationPending).toBe(false);
  });

  it('a machine-only user turn does not close the answer window', () => {
    const note: ChatMessage = {
      id: 'un:0', role: 'user', text: '', timestamp: ts(seq++),
      command: { name: null, body: '<task-notification>agent done</task-notification>', blocks: 1 },
    };
    const w = buildWalkthrough([
      user('go'), say('1'), ...edit('a.ts', 'x', 'y', 'e1'),
      narrateTurn(), note, say('```json\n{"intents":[{"title":"T","summary":"S","steps":["e1"]}]}\n```'),
    ], none);
    expect(w.narration?.intents[0].title).toBe('T');
    expect(w.narrationPending).toBe(false);
  });

  it('a typed slash command does close the answer window', () => {
    const slash: ChatMessage = {
      id: 'us:0', role: 'user', text: '', timestamp: ts(seq++),
      command: { name: '/commit', body: '<command-name>/commit</command-name>', blocks: 1 },
    };
    const w = buildWalkthrough([
      user('go'), say('1'), ...edit('a.ts', 'x', 'y', 'e1'),
      narrateTurn(), slash, say('Committed.'),
    ], none);
    expect(w.narration).toBeNull();
    expect(w.narrationFailed).toBe(false);
    expect(w.narrationPending).toBe(false);
  });
});

describe('buildWalkthrough — a failed call retried', () => {
  it('a failed Edit followed by a successful Edit on the same path is applied', () => {
    const w = buildWalkthrough([
      user('go'), say('1'),
      call('Edit', { file_path: 'a.ts', old_string: 'q', new_string: 'r' }, 'e1'), result('e1', 'old_string not found', true),
      say('2'), ...edit('a.ts', 'Q', 'r', 'e2'),
    ], none);
    expect(w.files).toEqual([{ path: 'a.ts', steps: ['e1', 'e2'], created: false, fate: null, notApplied: false }]);
  });

  it('a failed Edit with no later success on its path stays not applied', () => {
    const w = buildWalkthrough([
      user('go'), say('1'), ...edit('a.ts', 'x', 'y', 'e0'),
      say('2'), call('Edit', { file_path: 'a.ts', old_string: 'q', new_string: 'r' }, 'e1'), result('e1', 'old_string not found', true),
      say('3'), ...edit('b.ts', 'x', 'y', 'e2'),
    ], none);
    expect(w.files.find((f) => f.path === 'a.ts')?.notApplied).toBe(true);
  });
});
