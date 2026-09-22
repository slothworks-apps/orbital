import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTranscript, extractMeta, entriesToMessages, cleanTitle, splitUserText, truncateTitle, TITLE_MAX_CHARS } from '../src/transcript/parser.js';

const text = readFileSync(join(import.meta.dirname, 'fixtures/transcript-basic.jsonl'), 'utf8');

describe('parseTranscript', () => {
  it('skips corrupt lines without throwing', () => {
    expect(parseTranscript(text)).toHaveLength(3);
  });
});

describe('extractMeta', () => {
  it('derives cwd, title, timestamps, count', () => {
    const meta = extractMeta(parseTranscript(text));
    expect(meta.cwd).toBe('/Users/tomin/Projects/slothworks/ergaily');
    expect(meta.title).toBe('Fix the login bug in the auth service please');
    expect(meta.firstAt).toBe(Date.parse('2026-09-01T10:00:00.000Z'));
    expect(meta.lastAt).toBe(Date.parse('2026-09-01T10:01:00.000Z'));
    expect(meta.messageCount).toBe(3);
  });
});

describe('truncateTitle', () => {
  it('passes a short title through untouched', () => {
    expect(truncateTitle('Fix the login bug')).toBe('Fix the login bug');
  });

  it('passes a title exactly at the cap through untouched', () => {
    const exact = 'a'.repeat(TITLE_MAX_CHARS);
    expect(truncateTitle(exact)).toBe(exact);
  });

  it('breaks a long title at a word boundary and appends an ellipsis', () => {
    const long = 'slovo '.repeat(40).trim();
    const out = truncateTitle(long);
    expect(out.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
    const body = out.slice(0, -1);
    expect(long.startsWith(body)).toBe(true);
    // The cut lands between words, never inside one.
    expect(long[body.length]).toBe(' ');
  });

  it('hard-cuts a single unbroken word at the cap', () => {
    const wall = 'x'.repeat(300);
    const out = truncateTitle(wall);
    expect(out.length).toBe(TITLE_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });

  it('hard-cuts rather than keeping a stub when the only boundary is early', () => {
    const long = `Look at ${'y'.repeat(300)}`;
    const out = truncateTitle(long);
    expect(out.length).toBe(TITLE_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('extractMeta long titles', () => {
  it('word-breaks the derived title and marks the cut with an ellipsis', () => {
    const long = 'Pojďme důkladně projít celý backlog nápadů, které se nashromáždily v dokumentaci projektu, a naplánovat jejich postupné odbavení v rozumném pořadí';
    const entries = [
      { type: 'user', message: { content: long }, timestamp: '2026-09-18T10:00:00.000Z' },
    ];
    const title = extractMeta(entries as any).title;
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(title.endsWith('…')).toBe(true);
    expect(long[title.length - 1]).toBe(' ');
  });
});

/** Deterministic stand-in for the fs-backed store — refs are countable. */
function fakeImageStore() {
  const calls: Array<{ mediaType: string; base64: string }> = [];
  return {
    calls,
    put(mediaType: string, base64: string) {
      calls.push({ mediaType, base64 });
      return { ref: `${String(calls.length).padStart(64, '0')}.png`, w: 100, h: 50, bytes: 42 };
    },
  };
}

describe('entriesToMessages images', () => {
  const imageBlock = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'BASE64PAYLOAD' },
  };

  it('turns a pasted user image into an images message, never base64 on the wire', () => {
    const store = fakeImageStore();
    const entries = [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'look' }, imageBlock] } },
    ];
    const msgs = entriesToMessages(entries, store);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: 'user', text: 'look' });
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].images).toHaveLength(1);
    expect(msgs[1].images![0]).toMatchObject({ w: 100, h: 50, bytes: 42 });
    expect(msgs[1].text).toBeUndefined();
    expect(JSON.stringify(msgs)).not.toContain('BASE64PAYLOAD');
    expect(store.calls[0]).toEqual({ mediaType: 'image/png', base64: 'BASE64PAYLOAD' });
  });

  it('splits a tool_result array into joined text plus image refs — no stringified base64', () => {
    const store = fakeImageStore();
    const entries = [
      {
        type: 'user', uuid: 'u2',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result', tool_use_id: 't1',
            content: [{ type: 'text', text: 'took screenshot' }, imageBlock],
          }],
        },
      },
    ];
    const msgs = entriesToMessages(entries, store);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ role: 'tool_result', text: 'took screenshot' });
    expect(msgs[0].images).toHaveLength(1);
    expect(JSON.stringify(msgs)).not.toContain('BASE64PAYLOAD');
  });

  it('keeps the stringify fallback for arrays with neither text nor image blocks', () => {
    const entries = [
      {
        type: 'user', uuid: 'u3',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'document', foo: 1 }] }],
        },
      },
    ];
    const msgs = entriesToMessages(entries, fakeImageStore());
    expect(msgs[0].text).toBe(JSON.stringify([{ type: 'document', foo: 1 }]));
  });

  it('without a store, image blocks drop but tool_result text still joins clean', () => {
    const entries = [
      { type: 'user', uuid: 'u4', message: { role: 'user', content: [imageBlock] } },
      {
        type: 'user', uuid: 'u5',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result', tool_use_id: 't1',
            content: [{ type: 'text', text: 'ok' }, imageBlock],
          }],
        },
      },
    ];
    const msgs = entriesToMessages(entries);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ role: 'tool_result', text: 'ok' });
    expect(msgs[0].images).toBeUndefined();
    expect(JSON.stringify(msgs)).not.toContain('BASE64PAYLOAD');
  });
});

describe('entriesToMessages', () => {
  it('flattens content blocks to chat messages', () => {
    const msgs = entriesToMessages(parseTranscript(text));
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool_use', 'tool_result']);
    expect(msgs[2]).toMatchObject({ toolName: 'Bash', toolUseId: 't1' });
    expect(msgs[3]).toMatchObject({ toolUseId: 't1', text: '3 passing' });
  });

  it('handles malformed content without throwing', () => {
    const malformed = [
      { type: 'assistant', uuid: 'a9', message: { role: 'assistant', content: null } },
      { type: 'assistant', uuid: 'a10', message: { role: 'assistant' } },
      { type: 'assistant', uuid: 'a11', message: { role: 'assistant', content: 42 } },
    ];
    expect(() => entriesToMessages(malformed as any)).not.toThrow();
    expect(entriesToMessages(malformed as any)).toEqual([]);
  });
});

describe('extractMeta: bare slash commands', () => {
  const userTurn = (uuid: string, at: string, text: string) => ({
    type: 'user',
    uuid,
    timestamp: at,
    cwd: '/Users/tomin/Projects/demo',
    message: { role: 'user', content: text },
  });

  it('skips a leading bare command and titles from the next real turn', () => {
    const meta = extractMeta([
      userTurn('u1', '2026-09-01T10:00:00.000Z', '/clear'),
      userTurn('u2', '2026-09-01T10:00:30.000Z', 'Refactor the billing importer'),
    ]);
    expect(meta.title).toBe('Refactor the billing importer');
    // The skipped turn still counts toward the session's message tally/timestamps.
    expect(meta.messageCount).toBe(2);
    expect(meta.firstAt).toBe(Date.parse('2026-09-01T10:00:00.000Z'));
  });

  it('skips a run of bare commands, whatever they are', () => {
    const meta = extractMeta([
      userTurn('u1', '2026-09-01T10:00:00.000Z', '/clear'),
      userTurn('u2', '2026-09-01T10:00:10.000Z', '/login'),
      userTurn('u3', '2026-09-01T10:00:20.000Z', '/superpowers:brainstorming'),
      userTurn('u4', '2026-09-01T10:00:30.000Z', 'Design the tag rules panel'),
    ]);
    expect(meta.title).toBe('Design the tag rules panel');
  });

  it('keeps a command that carries arguments — those describe the work', () => {
    const meta = extractMeta([
      userTurn('u1', '2026-09-01T10:00:00.000Z', '/clickup-branch CU-8180'),
      userTurn('u2', '2026-09-01T10:00:30.000Z', 'now write the migration'),
    ]);
    expect(meta.title).toBe('/clickup-branch CU-8180');
  });

  it('falls back to the bare command when the session never says anything else', () => {
    const meta = extractMeta([userTurn('u1', '2026-09-01T10:00:00.000Z', '/clear')]);
    expect(meta.title).toBe('/clear');
  });
});

describe('extractMeta', () => {
  it('handles malformed content without throwing', () => {
    const malformed = [
      { type: 'user', uuid: 'u1', timestamp: '2026-09-01T10:00:00.000Z', message: { role: 'user', content: null } },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-09-01T10:00:05.000Z', message: { role: 'assistant' } },
    ];
    expect(() => extractMeta(malformed as any)).not.toThrow();
    const meta = extractMeta(malformed as any);
    expect(meta.title).toBe('');
    expect(meta.messageCount).toBe(2);
  });
});

describe('cleanTitle', () => {
  it('passes plain prompts through', () => {
    expect(cleanTitle('Fix the login bug')).toBe('Fix the login bug');
  });

  it('strips caveat blocks, including unclosed ones', () => {
    expect(cleanTitle('<local-command-caveat>Caveat: generated by the user. DO NOT respond</local-command-caveat>')).toBe('');
    expect(cleanTitle('<local-command-caveat>Caveat: truncated, no closing tag')).toBe('');
  });

  it('keeps real text surrounding a noise block', () => {
    expect(cleanTitle('<system-reminder>context stuff</system-reminder>Fix the login bug')).toBe('Fix the login bug');
  });

  it('falls back to the command name and args for slash-command turns', () => {
    const text = '<command-message>clickup-branch</command-message> <command-name>/clickup-branch</command-name> <command-args>https://app.clickup.com/t/1</command-args>';
    expect(cleanTitle(text)).toBe('/clickup-branch https://app.clickup.com/t/1');
    expect(cleanTitle('<command-name>/compact</command-name>')).toBe('/compact');
  });
});

describe('extractMeta noise titles', () => {
  it('skips noise-only first messages and uses the next real prompt', () => {
    const entries = [
      { type: 'user', uuid: 'u1', timestamp: '2026-09-01T10:00:00.000Z', message: { role: 'user', content: '<local-command-caveat>Caveat: generated</local-command-caveat>' } },
      { type: 'user', uuid: 'u2', timestamp: '2026-09-01T10:00:10.000Z', message: { role: 'user', content: 'Real prompt here' } },
    ];
    expect(extractMeta(entries as any).title).toBe('Real prompt here');
  });
});

describe('model extraction', () => {
  const line = (obj: unknown) => JSON.stringify(obj);

  it('extractMeta reports the last assistant model', () => {
    const text = [
      line({ type: 'user', timestamp: '2026-09-16T10:00:00Z', cwd: '/w', message: { role: 'user', content: 'hi' } }),
      line({ type: 'assistant', timestamp: '2026-09-16T10:00:01Z', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'a' }] } }),
      line({ type: 'assistant', timestamp: '2026-09-16T10:00:02Z', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'b' }] } }),
    ].join('\n');
    expect(extractMeta(parseTranscript(text)).model).toBe('claude-opus-5');
  });

  it('extractMeta ignores sidechain models', () => {
    const text = [
      line({ type: 'assistant', timestamp: '2026-09-16T10:00:01Z', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'a' }] } }),
      line({ type: 'assistant', isSidechain: true, timestamp: '2026-09-16T10:00:02Z', message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'sub' }] } }),
    ].join('\n');
    expect(extractMeta(parseTranscript(text)).model).toBe('claude-sonnet-5');
  });

  it('extractMeta reports null when no assistant entry names a model', () => {
    const text = line({ type: 'user', timestamp: '2026-09-16T10:00:00Z', message: { role: 'user', content: 'hi' } });
    expect(extractMeta(parseTranscript(text)).model).toBeNull();
  });

  it('entriesToMessages carries the model on assistant messages only', () => {
    const entries = parseTranscript([
      line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }),
      line({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'yo' }] } }),
    ].join('\n'));
    const messages = entriesToMessages(entries);
    expect(messages[0].model).toBeUndefined();
    expect(messages[1].model).toBe('claude-opus-5');
  });
});

// ---------------------------------------------------------------------------
// splitUserText — the command-expansion fold (spec:
// 2026-09-18-transcript-folding-design)
// ---------------------------------------------------------------------------

describe('splitUserText', () => {
  it('returns plain text untouched, with no command', () => {
    expect(splitUserText('just a question')).toEqual({ text: 'just a question' });
  });

  it('splits a named command expansion from the human remainder', () => {
    const raw =
      'look at this <command-name>/code-review</command-name>' +
      '<command-contents>You are performing a review.\nRead the diff.</command-contents>';
    const split = splitUserText(raw);
    expect(split.text).toBe('look at this');
    expect(split.command).toMatchObject({ name: '/code-review', blocks: 2 });
    expect(split.command?.body).toContain('You are performing a review.');
    expect(split.command?.body).toContain('<command-name>/code-review</command-name>');
  });

  it('labels an unnamed injection (system-reminder) with a null name', () => {
    const split = splitUserText(
      'try again <system-reminder>context here</system-reminder>'
    );
    expect(split.text).toBe('try again');
    expect(split.command).toMatchObject({ name: null, blocks: 1 });
  });

  it('yields empty text when the human typed nothing', () => {
    const split = splitUserText(
      '<command-name>/commit</command-name><command-contents>body</command-contents>'
    );
    expect(split.text).toBe('');
    expect(split.command?.name).toBe('/commit');
  });

  it('counts multiple blocks and keeps them in order in the body', () => {
    const split = splitUserText(
      '<system-reminder>one</system-reminder> hi <system-reminder>two</system-reminder>'
    );
    expect(split.text).toBe('hi');
    expect(split.command?.blocks).toBe(2);
    expect(split.command?.body.indexOf('one')).toBeLessThan(split.command!.body.indexOf('two'));
  });

  it('handles an unclosed tag running to the end of the message', () => {
    const split = splitUserText('<local-command-stdout>partial output');
    expect(split.text).toBe('');
    expect(split.command).toMatchObject({ name: null, blocks: 1 });
  });
});

describe('entriesToMessages: command split and isError', () => {
  it('splits a user turn carrying an expansion and marks a failed tool_result', () => {
    const entries = [
      {
        type: 'user', uuid: 'u1', timestamp: '2026-09-18T10:00:00.000Z',
        message: {
          role: 'user',
          content: 'ship it <command-name>/commit</command-name><command-contents>long body</command-contents>',
        },
      },
      {
        type: 'user', uuid: 'u2', timestamp: '2026-09-18T10:00:05.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }],
        },
      },
    ];
    const msgs = entriesToMessages(entries);
    expect(msgs[0]).toMatchObject({ role: 'user', text: 'ship it' });
    expect(msgs[0].command).toMatchObject({ name: '/commit' });
    expect(msgs[1]).toMatchObject({ role: 'tool_result', isError: true });
  });

  it('leaves isError absent on a successful tool_result', () => {
    const entries = [
      {
        type: 'user', uuid: 'u3',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] },
      },
    ];
    expect(entriesToMessages(entries as any)[0].isError).toBeUndefined();
  });
});

describe('task notifications fold with the rest of the machine wrapping', () => {
  const notification =
    '<task-notification>\n<task-id>a0bf872f53a08fd4d</task-id>\n' +
    '<status>stopped</status>\n<summary>Background agent didn\'t finish</summary>\n' +
    '</task-notification>';

  it('folds a resumed session\'s notification out of the visible turn', () => {
    // Every autoheal resume re-emits one of these (spec
    // 2026-09-21-session-autoheal-design), so a dev-loop session accumulates
    // them faster than anything the human typed.
    const split = splitUserText(`carry on\n${notification}`);
    expect(split.text).toBe('carry on');
    expect(split.command?.blocks).toBe(1);
    expect(split.command?.body).toContain('a0bf872f53a08fd4d');
  });

  it('keeps a turn that is nothing but a notification out of the title', () => {
    expect(cleanTitle(notification)).toBe('');
  });

  it('counts a notification alongside the other machine blocks', () => {
    const split = splitUserText(`${notification}\n<system-reminder>x</system-reminder>`);
    expect(split.text).toBe('');
    expect(split.command?.blocks).toBe(2);
  });
});
