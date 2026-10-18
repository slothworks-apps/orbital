import { describe, it, expect } from 'vitest';
import {
  AnswerMessage, AskMessage, BLOB_CHUNK_BYTES, FILE_PATH_MAX_CHARS, HELLO_CAPABILITIES_MAX, HELLO_CAPABILITY_MAX_CHARS,
  HELLO_KIND_MAX_CHARS, HelloMessage, PROTOCOL_VERSION, chunkBlob,
  decodeInner, encodeInner, parseChannelMessage, peerServes,
} from '../src/remote/messages.js';
import { PAIR_NAME_MAX_CHARS } from '../src/remote/relayApi.js';
import { ROSTER_MAX_ENTRIES } from '../src/remote/roster.js';

describe('inner codec', () => {
  it('round-trips a json message', () => {
    const m = { kind: 'json' as const, value: { t: 'hello', protocol: 1, app: 'orbital-mobile/0.1.0' } };
    expect(decodeInner(encodeInner(m))).toEqual(m);
  });
  it('round-trips a blob chunk', () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const m = { kind: 'blob' as const, id: 42, seq: 3, last: true, bytes };
    expect(decodeInner(encodeInner(m))).toEqual(m);
  });
  it('rejects an unknown kind, malformed json and a short blob header', () => {
    expect(decodeInner(new Uint8Array([2, 0]))).toBeNull();
    expect(decodeInner(new Uint8Array([0, 123]))).toBeNull();
    expect(decodeInner(new Uint8Array([1, 0, 0]))).toBeNull();
    expect(decodeInner(new Uint8Array(0))).toBeNull();
  });
  it('chunks a blob at BLOB_CHUNK_BYTES and marks the last one', () => {
    const bytes = new Uint8Array(BLOB_CHUNK_BYTES * 2 + 1).fill(1);
    const chunks = chunkBlob(7, bytes);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.kind === 'blob' && c.seq)).toEqual([0, 1, 2]);
    expect(chunks.map((c) => c.kind === 'blob' && c.last)).toEqual([false, false, true]);
    expect(chunks[2].kind === 'blob' && chunks[2].bytes.length).toBe(1);
    expect(chunkBlob(1, new Uint8Array(0))).toEqual([
      { kind: 'blob', id: 1, seq: 0, last: true, bytes: new Uint8Array(0) },
    ]);
  });
});

describe('message schemas', () => {
  it('accepts every ask and rejects an unknown one', () => {
    for (const m of [
      { t: 'ws', type: 'subscribe', topic: 'sessions' },
      { t: 'http', id: 1, method: 'GET', path: '/api/sessions' },
      { t: 'http', id: 2, method: 'POST', path: '/api/sessions/a/messages', body: { text: 'hi' } },
      { t: 'blob_get', id: 3, ref: 'a'.repeat(64) + '.png' },
      { t: 'blob_put', id: 4, mediaType: 'image/png', bytes: 10 },
      { t: 'notifications_get' },
      { t: 'notifications_set', settings: { needsInput: true, sessionEnded: false, sessionFailed: true, onlyWhenBackground: true, sound: false } },
      { t: 'seen', sessionId: 's1' },
    ]) expect(AskMessage.safeParse(m).success, JSON.stringify(m)).toBe(true);
    expect(AskMessage.safeParse({ t: 'nope' }).success).toBe(false);
    expect(AskMessage.safeParse({ t: 'file_get', id: 5, session: 's1', path: '/tmp/a b/shot.png', as: 'image' }).success).toBe(true);
    expect(AskMessage.safeParse({ t: 'file_get', id: 5, session: 's1', path: 'ünï/código.md', as: 'text' }).success).toBe(true);
    expect(HelloMessage.safeParse({ t: 'hello', protocol: 1, app: 'x' }).success).toBe(true);
  });
  it('refuses a file_get with a control character, an over-long or empty path, or no kind', () => {
    const ok = { t: 'file_get', id: 5, session: 's1', path: '/tmp/a.md', as: 'text' };
    for (const bad of [
      { ...ok, path: '/tmp/a\n.md' },
      { ...ok, path: '/tmp/a\u0000.md' },
      { ...ok, path: '/tmp/a\u007f.md' },
      { ...ok, path: '/' + 'a'.repeat(FILE_PATH_MAX_CHARS) },
      { ...ok, path: '' },
      { ...ok, session: '' },
      { ...ok, session: 's\r1' },
      { ...ok, as: undefined },
      { ...ok, as: 'video' },
    ]) expect(AskMessage.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(AskMessage.safeParse({ ...ok, path: '/' + 'a'.repeat(FILE_PATH_MAX_CHARS - 1) }).success).toBe(true);
    expect(AskMessage.safeParse({ ...ok, as: 'pdf' }).success).toBe(true);
    expect(AskMessage.safeParse({ t: 'http', id: 1, method: 'TRACE', path: '/' }).success).toBe(false);
  });
  it('accepts every answer', () => {
    for (const m of [
      { t: 'bye', reason: 'protocol' },
      { t: 'ws', frame: { topic: 'sessions', event: 'status' } },
      { t: 'http_res', id: 1, status: 200, body: [] },
      { t: 'blob_meta', id: 3, status: 404 },
      { t: 'blob_meta', id: 3, status: 200, bytes: 12, mediaType: 'image/png' },
      { t: 'blob_meta', id: 3, status: 200, bytes: 12, mediaType: 'image/png', size: 12, w: 3, h: 2 },
      { t: 'blob_meta', id: 3, status: 413, size: 9_000_000 },
      { t: 'blob_put_done', id: 4, entry: { ref: 'a'.repeat(64) + '.png', w: 1, h: 1, bytes: 10 } },
      { t: 'blob_put_done', id: 4, error: 'not_image' },
      { t: 'notifications', settings: { needsInput: true, sessionEnded: true, sessionFailed: true, onlyWhenBackground: true, sound: true } },
    ]) expect(AnswerMessage.safeParse(m).success, JSON.stringify(m)).toBe(true);
    expect(HelloMessage.safeParse({ t: 'hello', protocol: 1, server: '0.15.0', macName: 'studio' }).success).toBe(true);
  });
});

describe('parseChannelMessage', () => {
  it('reads a shipped phone hello and a shipped Mac hello', () => {
    expect(parseChannelMessage({ t: 'hello', protocol: 1, app: 'orbital-mobile/0.9.0' })?.kind).toBe('hello');
    expect(parseChannelMessage({ t: 'hello', protocol: 1, server: '0.30.0', macName: 'studio' })?.kind).toBe('hello');
  });
  it('keeps a kind and capabilities it does not know', () => {
    const parsed = parseChannelMessage({ t: 'hello', protocol: 1, app: 'x/1', kind: 'tablet', capabilities: ['sessions', 'teleport'] });
    expect(parsed).toEqual({ kind: 'hello', msg: expect.objectContaining({ kind: 'tablet', capabilities: ['sessions', 'teleport'] }) });
  });
  it('reads a shipped phone hello and a shipped Mac hello exactly, adding nothing', () => {
    expect(parseChannelMessage({ t: 'hello', protocol: 1, app: 'orbital-mobile/0.9.0' }))
      .toStrictEqual({ kind: 'hello', msg: { t: 'hello', protocol: 1, app: 'orbital-mobile/0.9.0' } });
    expect(parseChannelMessage({ t: 'hello', protocol: 1, server: '0.30.0', macName: 'studio' }))
      .toStrictEqual({ kind: 'hello', msg: { t: 'hello', protocol: 1, server: '0.30.0', macName: 'studio' } });
  });
  it('cuts an over-long name, macName, kind or os instead of refusing the hello', () => {
    const long = 'n'.repeat(PAIR_NAME_MAX_CHARS + 1);
    const tall = 'k'.repeat(HELLO_KIND_MAX_CHARS + 5);
    const parsed = parseChannelMessage({ t: 'hello', protocol: 1, server: '1', macName: long, name: long, kind: tall, os: tall });
    expect(parsed?.kind).toBe('hello');
    expect(parsed?.msg).toMatchObject({
      server: '1', macName: long.slice(0, PAIR_NAME_MAX_CHARS), name: long.slice(0, PAIR_NAME_MAX_CHARS),
      kind: tall.slice(0, HELLO_KIND_MAX_CHARS), os: tall.slice(0, HELLO_KIND_MAX_CHARS),
    });
  });
  it('cuts an over-long capabilities list and drops a capability that is over long or not a string', () => {
    const many = Array.from({ length: HELLO_CAPABILITIES_MAX + 3 }, (_, i) => `c${i}`);
    const parsed = HelloMessage.parse({ t: 'hello', protocol: 1, capabilities: many });
    expect(parsed.capabilities).toEqual(many.slice(0, HELLO_CAPABILITIES_MAX));
    const mixed = HelloMessage.parse({
      t: 'hello', protocol: 1, capabilities: ['sessions', 'x'.repeat(HELLO_CAPABILITY_MAX_CHARS + 1), 7, 'map'],
    });
    expect(mixed.capabilities).toEqual(['sessions', 'map']);
  });
  it('treats a cosmetic field of the wrong type as absent; only t and protocol refuse', () => {
    const parsed = HelloMessage.parse({
      t: 'hello', protocol: 1, app: 3, server: '1', macName: null, version: {}, kind: [], os: 9, name: true, capabilities: 'sessions',
    });
    expect(parsed).toStrictEqual({ t: 'hello', protocol: 1, server: '1' });
    expect(HelloMessage.safeParse({ t: 'hello', protocol: '1', app: 'a' }).success).toBe(false);
    expect(HelloMessage.safeParse({ t: 'hello', app: 'a' }).success).toBe(false);
  });
  it('tells a subscribe (ask) from a hub frame (answer)', () => {
    expect(parseChannelMessage({ t: 'ws', type: 'subscribe', topic: 'sessions' })?.kind).toBe('ask');
    expect(parseChannelMessage({ t: 'ws', frame: { topic: 'sessions' } })?.kind).toBe('answer');
  });
  it('reads every ask and answer kind once', () => {
    expect(parseChannelMessage({ t: 'http', id: 1, method: 'GET', path: '/api/health' })?.kind).toBe('ask');
    expect(parseChannelMessage({ t: 'http_res', id: 1, status: 200, body: {} })?.kind).toBe('answer');
    expect(parseChannelMessage({ t: 'bye', reason: 'revoked' })?.kind).toBe('answer');
    expect(parseChannelMessage({ t: 'nonsense' })).toBeNull();
  });
  it('reads group messages, and refuses a roster over its bound', () => {
    expect(parseChannelMessage({ t: 'roster_digest', digest: 'ab' })?.kind).toBe('group');
    expect(parseChannelMessage({ t: 'removed' })).toBeNull();
    const one = {
      id: 'A', kind: 'desktop', name: 'a', os: 'macos', links: true, epoch: 1, addedBy: 'B', addedAt: 1, addedSig: 's',
      describedAt: 1, describedBy: 'A', describedSig: 's',
    };
    expect(parseChannelMessage({ t: 'roster', entries: [one] })?.kind).toBe('group');
    expect(parseChannelMessage({ t: 'roster', entries: new Array(ROSTER_MAX_ENTRIES + 1).fill(one) })).toBeNull();
  });
});

describe('peerServes', () => {
  const hello = (extra: object) => HelloMessage.parse({ t: 'hello', protocol: PROTOCOL_VERSION, ...extra });
  it('a shipped Mac serves, a shipped phone does not', () => {
    expect(peerServes(hello({ server: '0.30.0', macName: 'studio' }))).toBe(true);
    expect(peerServes(hello({ app: 'orbital-mobile/0.9.0' }))).toBe(false);
  });
  it('a device that names its capabilities serves when it runs sessions', () => {
    expect(peerServes(hello({ app: 'a/1', server: '1', macName: 'm', capabilities: [] }))).toBe(false);
    expect(peerServes(hello({ app: 'a/1', capabilities: ['sessions'] }))).toBe(true);
  });
});
