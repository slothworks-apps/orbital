import { describe, it, expect } from 'vitest';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createImageStore } from '../src/images/store.js';
import { locateOnDisk, mediaItems } from '../src/media/items.js';
import { sessionMedia } from '../src/media/sessionMedia.js';
import type { MediaItem } from '@orbital/shared/media';
import type { ChatMessage, SessionRow } from '../src/types.js';
import { entriesToMessages, type TranscriptEntry } from '../src/transcript/parser.js';
import { makeTmpDir } from './tmp.js';

function pngOf(w: number, h: number, fill: number): Buffer {
  const b = Buffer.alloc(40, fill);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

const image = (w: number, h: number, fill: number) => ({
  type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngOf(w, h, fill).toString('base64') },
});

const T1 = '2026-10-09T10:00:00.000Z';
const T2 = '2026-10-09T10:05:00.000Z';
const T3 = '2026-10-09T10:10:00.000Z';

/**
 * A session in `home` that later works in `other`: the user attaches an
 * image, two tool calls return screenshots, a tool input names a path the
 * agent never mentions, and two replies name files.
 */
function world() {
  const home = makeTmpDir('media-home');
  const other = makeTmpDir('media-other');
  const outside = makeTmpDir('media-outside');
  mkdirSync(join(home, 'out'));
  writeFileSync(join(home, 'out', 'shot.png'), 'png');
  utimesSync(join(home, 'out', 'shot.png'), new Date(T1), new Date(T1));
  writeFileSync(join(home, 'out', 'report.pdf'), '%PDF');
  // Written after the reply named it.
  utimesSync(join(home, 'out', 'report.pdf'), new Date(T3), new Date(T3));
  writeFileSync(join(outside, 'secret.png'), 'png');
  writeFileSync(join(home, 'out', 'written.png'), 'png');

  const reply = [
    'Saved `out/shot.png` and out/report.pdf; out/shot.png again.',
    '```',
    'convert out/fenced.png',
    '```',
    `Also out/ghost.png and ${join(outside, 'secret.png')}, but \`open out/cmd.png\` is a command.`,
  ].join('\n');
  const entries: TranscriptEntry[] = [
    { type: 'user', uuid: 'u1', cwd: home, timestamp: T1, message: { role: 'user', content: [{ type: 'text', text: 'look' }, image(4, 3, 1)] } },
    {
      type: 'assistant', uuid: 'a1', cwd: home, timestamp: T1,
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'mcp__playwright__browser_take_screenshot', input: {} },
          { type: 'tool_use', id: 'toolu_2', name: 'Write', input: { file_path: 'out/written.png' } },
        ],
      },
    },
    {
      type: 'user', uuid: 'u2', cwd: home, timestamp: T1,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [image(8, 6, 2), image(8, 6, 3)] }] },
    },
    {
      type: 'user', uuid: 'u3', cwd: home, timestamp: T1,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' }] },
    },
    { type: 'assistant', uuid: 'a2', cwd: home, timestamp: T2, message: { role: 'assistant', content: [{ type: 'text', text: reply }] } },
    { type: 'assistant', uuid: 'a3', cwd: other, timestamp: T3, message: { role: 'assistant', content: [{ type: 'text', text: 'Again out/shot.png' }] } },
  ];
  const messages = entriesToMessages(entries, createImageStore(makeTmpDir('media-images')));
  // Each message's own cwd confines it; the cwd alone, nothing named outside it.
  const locate = locateOnDisk((cwd) => [cwd ?? home], () => false);
  return { home, other, items: mediaItems(messages, locate) };
}

describe('mediaItems', () => {
  it('lists the four sources oldest first, with stable ids', () => {
    const { items } = world();
    expect(items.map((i) => [i.id, i.source, i.kind])).toEqual([
      ['u1:1:0', 'you', 'image'],
      ['a1:1:0', 'written', 'image'],
      ['u2:0:0', 'tool', 'image'],
      ['u2:0:1', 'tool', 'image'],
      ['a2:0:0', 'agent', 'image'],
      ['a2:0:1', 'agent', 'pdf'],
      ['a2:0:2', 'agent', 'image'],
      ['a3:0:0', 'agent', 'image'],
    ]);
  });

  it('carries the image store ref and size for attached and tool images, and the tool_use id for a run', () => {
    const { items } = world();
    expect(items[0]).toMatchObject({ messageId: 'u1:1', ts: T1, w: 4, h: 3 });
    expect(items[0].ref).toMatch(/\.png$/);
    expect(items[0].toolRun).toBeUndefined();
    const tool = items.filter((i) => i.source === 'tool');
    expect(tool[0]).toMatchObject({ toolRun: 'toolu_1', tool: 'mcp__playwright__browser_take_screenshot', w: 8, h: 6 });
    expect(tool[1].toolRun).toBe('toolu_1');
    expect(tool[0].ref).not.toBe(tool[1].ref);
  });

  it('takes agent items only from reply text, never from a tool input or a code block', () => {
    const paths = world().items.filter((i) => i.source === 'agent').map((i) => i.path);
    expect(paths).not.toContain('out/written.png');
    expect(paths).not.toContain('out/fenced.png');
    expect(paths).not.toContain('out/cmd.png');
    expect(paths).toEqual(['out/shot.png', 'out/report.pdf', 'out/ghost.png', 'out/shot.png']);
  });

  it('carries the cwd each reply was written in, and reads disk state against it', () => {
    const { items, home, other } = world();
    const agent = items.filter((i) => i.source === 'agent');
    expect(agent.map((i) => [i.path, i.cwd, i.disk])).toEqual([
      ['out/shot.png', home, 'present'],
      ['out/report.pdf', home, 'changed'],
      ['out/ghost.png', home, 'missing'],
      // Named again from another tree, where it is not.
      ['out/shot.png', other, 'missing'],
    ]);
    expect(agent[0]).toMatchObject({ messageId: 'a2:0', ts: T2 });
  });

  it('leaves out a path the session may not show', () => {
    const { items } = world();
    expect(items.some((i) => i.path?.endsWith('secret.png'))).toBe(false);
  });
});

describe('written images', () => {
  const tu = (uuid: string, ts: string, cwd: string, name: string, input: object, id = `toolu_${uuid}`): TranscriptEntry => ({
    type: 'assistant', uuid, cwd, timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
  const result = (uuid: string, ts: string, cwd: string, id: string, content: unknown): TranscriptEntry => ({
    type: 'user', uuid, cwd, timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  });
  const say = (uuid: string, ts: string, cwd: string, text: string): TranscriptEntry => ({
    type: 'assistant', uuid, cwd, timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
  const ask = (uuid: string, ts: string, cwd: string): TranscriptEntry => ({
    type: 'user', uuid, cwd, timestamp: ts, message: { role: 'user', content: 'next' },
  });

  function itemsOf(build: (cwd: string) => TranscriptEntry[], files: string[]) {
    const cwd = makeTmpDir('media-written');
    mkdirSync(join(cwd, 'out'));
    for (const f of files) writeFileSync(join(cwd, f), 'png');
    const messages = entriesToMessages(build(cwd), createImageStore(makeTmpDir('media-written-images')));
    return { cwd, items: mediaItems(messages, locateOnDisk((c) => [c ?? cwd], () => false)) };
  }

  it('counts Write, a screenshot tool and a Bash command, only while the file is on disk', () => {
    const { items, cwd } = itemsOf((cwd) => [
      tu('w', T1, cwd, 'Write', { file_path: join(cwd, 'out/a.png'), content: '' }),
      tu('p', T1, cwd, 'mcp__plugin_playwright_playwright__browser_take_screenshot', { filename: 'out/b.png' }),
      tu('b', T1, cwd, 'Bash', { command: 'magick in.svg out/c.png && rm out/gone.png' }),
      tu('t', T1, cwd, 'Write', { file_path: join(cwd, 'out/notes.md'), content: '' }),
    ], ['out/a.png', 'out/b.png', 'out/c.png']);
    expect(items.map((i) => [i.source, i.path, i.tool, i.disk])).toEqual([
      ['written', join(cwd, 'out/a.png'), 'Write', undefined],
      ['written', 'out/b.png', 'mcp__plugin_playwright_playwright__browser_take_screenshot', undefined],
      ['written', 'out/c.png', 'Bash', undefined],
    ]);
  });

  it('gives way to a reply naming the file, whatever came between, and is one item however often written', () => {
    const { items } = itemsOf((cwd) => [
      tu('w1', T1, cwd, 'Write', { file_path: join(cwd, 'out/a.png'), content: '' }),
      // A message sent while the turn runs is a user row between the write and the reply.
      ask('u1', T1, cwd),
      say('r1', T2, cwd, 'Saved out/a.png'),
      tu('b1', T2, cwd, 'Bash', { command: 'magick in.svg out/b.png' }),
      ask('u2', T2, cwd),
      tu('w2', T3, cwd, 'Write', { file_path: join(cwd, 'out/b.png'), content: '' }),
      tu('w3', T3, cwd, 'Write', { file_path: join(cwd, 'out/a.png'), content: '' }),
    ], ['out/a.png', 'out/b.png']);
    expect(items.map((i) => [i.source, i.messageId])).toEqual([
      ['agent', 'r1:0'],
      ['written', 'b1:0'],
    ]);
  });

  it('leaves a screenshot to its result image, and takes a path its result text names when there is none', () => {
    const { items, cwd } = itemsOf((cwd) => [
      tu('p1', T1, cwd, 'mcp__playwright__browser_take_screenshot', { filename: 'out/a.png' }, 'toolu_p1'),
      result('r1', T1, cwd, 'toolu_p1', [image(4, 4, 1)]),
      tu('p2', T2, cwd, 'mcp__playwright__browser_take_screenshot', {}, 'toolu_p2'),
      result('r2', T2, cwd, 'toolu_p2', `Saved it as ${cwd}/out/b.png`),
    ], ['out/a.png', 'out/b.png']);
    expect(items.map((i) => [i.source, i.path])).toEqual([
      ['tool', undefined],
      ['written', `${cwd}/out/b.png`],
    ]);
  });
});

describe('sessionMedia', () => {
  const row = { id: 's', cwd: '/w' } as SessionRow;
  const msg = (m: Partial<ChatMessage> & { id: string; role: ChatMessage['role'] }): ChatMessage => m;
  const parent: ChatMessage[] = [
    msg({ id: 'u1:1', role: 'user', timestamp: T1, images: [{ ref: 'r1.png', w: 1, h: 1, bytes: 1 }] }),
    msg({ id: 'a1:0', role: 'tool_use', toolName: 'Agent', toolUseId: 'toolu_a', toolInput: { subagent_type: 'Explore' }, timestamp: T1 }),
    msg({ id: 'u2:1', role: 'user', timestamp: T3, images: [{ ref: 'r3.png', w: 1, h: 1, bytes: 1 }] }),
  ];
  const sub = (ref: string, ts: string): MediaItem => ({ id: `${ref}:0`, kind: 'image', source: 'tool', messageId: ref, ts, ref, toolRun: 'toolu_s' });

  it("puts a subagent's items between the parent's by time, marked with the subagent and its Agent call", () => {
    const items = sessionMedia({
      row: () => row,
      presentTranscript: () => parent,
      locate: () => () => ({ kind: 'not_found' }),
      subagents: () => new Map([
        ['toolu_a', [sub('s1', T2)]],
        // An agent whose call is not on the presented branch.
        ['toolu_gone', [sub('s2', T2)]],
      ]),
    }, 's');
    expect(items?.map((i) => [i.id, i.messageId, i.subagent?.name])).toEqual([
      ['u1:1:0', 'u1:1', undefined],
      ['toolu_a/s1:0', 'a1:0', 'Explore'],
      ['u2:1:0', 'u2:1', undefined],
    ]);
    expect(items?.[1].subagent).toEqual({ toolUseId: 'toolu_a', name: 'Explore' });
  });

  it("folds a file a subagent saved into the parent's reply naming it", () => {
    const saved: MediaItem = { id: 'w:0', kind: 'image', source: 'written', messageId: 'w', ts: T2, path: 'out/shot.png', cwd: '/w', tool: 'Write' };
    const items = sessionMedia({
      row: () => row,
      presentTranscript: () => [
        ...parent.slice(0, 2),
        msg({ id: 'r:0', role: 'assistant', text: 'See /w/out/shot.png', cwd: '/w', timestamp: T3 }),
      ],
      locate: () => () => ({ kind: 'ok', mtimeMs: 0 }),
      subagents: () => new Map([['toolu_a', [saved]]]),
    }, 's');
    expect(items?.map((i) => [i.source, i.subagent?.name])).toEqual([
      ['you', undefined],
      ['agent', undefined],
    ]);
  });

  it('is null for an unknown session', () => {
    expect(sessionMedia({
      row: () => undefined, presentTranscript: () => null, locate: () => () => ({ kind: 'not_found' }), subagents: () => new Map(),
    }, 'nope')).toBeNull();
  });
});
