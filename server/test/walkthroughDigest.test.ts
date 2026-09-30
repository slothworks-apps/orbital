import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '../src/types.js';
import { buildWalkthrough } from '../src/walkthrough/spine.js';
import { buildNarrateDigest, NARRATE_CALL_INPUT_MIN_CHARS } from '../src/walkthrough/digest.js';

let seq = 0;
const user = (text: string): ChatMessage => ({ id: `u${seq++}`, role: 'user', text });
const say = (text: string): ChatMessage => ({ id: `a${seq++}`, role: 'assistant', text });
const think = (text: string): ChatMessage => ({ id: `t${seq++}`, role: 'thinking', text });
const edit = (path: string, from: string, to: string, id: string): ChatMessage[] => [
  { id: `c${seq++}`, role: 'tool_use', toolName: 'Edit', toolInput: { file_path: path, old_string: from, new_string: to }, toolUseId: id },
  { id: `r${seq++}`, role: 'tool_result', toolUseId: id, text: 'ok' },
];
const none = new Map<string, ChatMessage[]>();

function digest(messages: ChatMessage[], max?: number): string {
  return buildNarrateDigest(buildWalkthrough(messages, none), messages, none, max);
}

describe('buildNarrateDigest', () => {
  it('holds the typed messages, the visible text and every step with its calls, in order', () => {
    const out = digest([user('add a margin'), say('Adding it.'), ...edit('src/a.ts', 'x', 'y', 'e1')]);
    expect(out).toContain('USER:\nadd a margin');
    expect(out).toContain('ASSISTANT:\nAdding it.');
    expect(out).toContain('STEP 1 · id e1 · src/a.ts');
    expect(out).toContain('"old_string":"x"');
    expect(out.indexOf('add a margin')).toBeLessThan(out.indexOf('Adding it.'));
    expect(out.indexOf('Adding it.')).toBeLessThan(out.indexOf('STEP 1'));
    expect(out).not.toContain('NOTE:');
  });

  it('never carries thinking', () => {
    const out = digest([user('go'), think('SECRET-REASONING'), say('Doing it.'), ...edit('a.ts', 'x', 'y', 'e1')]);
    expect(out).not.toContain('SECRET-REASONING');
  });

  it("leaves out Orbital's injected turns: a task notification, a command's expansion, an old walkthrough turn and its answer", () => {
    const notification: ChatMessage = {
      id: 'n1', role: 'user', text: '',
      command: { name: null, body: '<task-notification>agent done</task-notification>', blocks: 1 },
    };
    const slash: ChatMessage = {
      id: 's1', role: 'user', text: 'now',
      command: { name: '/commit', body: '<command-name>/commit</command-name><command-contents>EXPANSION-BODY</command-contents>', blocks: 2 },
    };
    const narrate: ChatMessage = {
      id: 'w1', role: 'user', text: '',
      command: { name: 'walkthrough · narrate', body: '<orbital-walkthrough kind="narrate">OLD-PROMPT</orbital-walkthrough>', blocks: 1, walkthrough: { kind: 'narrate' } },
    };
    const out = digest([
      user('go'), say('1'), ...edit('a.ts', 'x', 'y', 'e1'),
      notification, narrate, say('OLD-ANSWER'), slash,
    ]);
    expect(out).not.toContain('agent done');
    expect(out).not.toContain('OLD-PROMPT');
    expect(out).not.toContain('OLD-ANSWER');
    expect(out).not.toContain('EXPANSION-BODY');
    // The command itself was typed, so it stays — by name, with what was typed after it.
    expect(out).toContain('USER:\n/commit now');
  });

  it('shortens in order: call inputs first, then the oldest assistant text, then the oldest user messages', () => {
    const big = 'z'.repeat(5_000);
    const pad = '.'.repeat(300);
    const messages = [
      user(`USER-OLD${pad}`), say(`SAID-OLD${pad}`), ...edit('a.ts', big, big, 'e1'),
      user(`USER-NEW${pad}`), say(`SAID-NEW${pad}`), ...edit('b.ts', big, big, 'e2'),
    ];
    const kept = (max: number) => {
      const out = digest(messages, max);
      expect(out.length).toBeLessThanOrEqual(max);
      return ['USER-OLD', 'SAID-OLD', 'USER-NEW', 'SAID-NEW'].filter((t) => out.includes(t));
    };
    const full = digest(messages);

    // Just under the full length: cutting the inputs is enough, no message goes.
    const cut = digest(messages, full.length - 1_000);
    expect(cut).toMatch(/^NOTE: /);
    expect(cut).toContain('… (cut)');
    expect(kept(full.length - 1_000)).toEqual(['USER-OLD', 'SAID-OLD', 'USER-NEW', 'SAID-NEW']);

    // Inputs at their floor and still over: the oldest assistant text goes first,
    // then the rest of the assistant text, and only then the oldest user message.
    const floor = `{"file_path":"a.ts","old_string":"${big}`.slice(0, NARRATE_CALL_INPUT_MIN_CHARS);
    expect(digest(messages, 2_100)).toContain(`${floor}… (cut)`);
    expect(kept(2_100)).toEqual(['USER-OLD', 'USER-NEW', 'SAID-NEW']);
    expect(kept(1_800)).toEqual(['USER-OLD', 'USER-NEW']);
    expect(kept(1_500)).toEqual(['USER-NEW']);
  });

  it('keeps every step line under any cap', () => {
    const messages = [user('go'), say('1'), ...edit('a.ts', 'x', 'y', 'e1'), user('more'), say('2'), ...edit('b.ts', 'p', 'q', 'e2')];
    const out = digest(messages, 10);
    expect(out).toContain('STEP 1 · id e1 · a.ts');
    expect(out).toContain('STEP 2 · id e2 · b.ts');
    expect(out).not.toContain('USER:');
    expect(out).not.toContain('ASSISTANT:');
    expect(out).toMatch(/^NOTE: .*4 of its earliest messages are left out/);
  });
});
