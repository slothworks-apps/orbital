import { describe, it, expect } from 'vitest';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createImageStore } from '../src/images/store.js';
import { locateOnDisk, mediaItems } from '../src/media/items.js';
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
  it('lists the three sources oldest first, with stable ids', () => {
    const { items } = world();
    expect(items.map((i) => [i.id, i.source, i.kind])).toEqual([
      ['u1:1:0', 'you', 'image'],
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
    expect(items[1]).toMatchObject({ toolRun: 'toolu_1', w: 8, h: 6 });
    expect(items[2].toolRun).toBe('toolu_1');
    expect(items[1].ref).not.toBe(items[2].ref);
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
