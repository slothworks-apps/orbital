import { describe, it, expect } from 'vitest';
import type { AllMediaItem, MediaItem } from '@orbital/shared/media';
import {
  allMediaPage, decodeCursor, encodeCursor, parseTagFilter,
  type AllMediaSource, type WalkSession,
} from '../src/media/allMedia.js';

const item = (session: string, n: number): MediaItem => ({
  id: `${session}-m${n}:0`, kind: 'image', source: 'you', messageId: `${session}-m${n}`, ts: `2026-10-13T10:${String(n).padStart(2, '0')}:00.000Z`, ref: `${session}${n}`,
});

/** Sessions with `counts[i]` items each, the first the most recent; tags by index. */
function world(counts: number[], tagsOf: (i: number) => number[] = () => [1]) {
  const sessions: WalkSession[] = counts.map((_, i) => ({ id: `s${i}`, at: 1000 - i, title: `S${i}`, tagIds: tagsOf(i) }));
  const lists = new Map(counts.map((n, i) => [`s${i}`, Array.from({ length: n }, (_, k) => item(`s${i}`, k))]));
  const reads: string[] = [];
  const source: AllMediaSource = {
    sessionsAfter: (after, limit) =>
      sessions
        .filter((s) => !after || s.at < after.at || (s.at === after.at && s.id < after.id))
        .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))
        .slice(0, limit),
    session: (id) => sessions.find((s) => s.id === id),
    media: (id) => {
      reads.push(id);
      return lists.get(id) ?? null;
    },
  };
  return { source, lists, reads, sessions };
}

function walk(source: AllMediaSource, opts: { limit: number; tags?: Set<number> | null; scanMax?: number }) {
  const pages: AllMediaItem[][] = [];
  let cursor = null;
  for (let guard = 0; guard < 100; guard++) {
    const page = allMediaPage(source, { cursor, limit: opts.limit, tags: opts.tags ?? null, scanMax: opts.scanMax ?? 100 });
    pages.push(page.items);
    if (!page.next) return pages;
    cursor = decodeCursor(page.next);
  }
  throw new Error('walk did not end');
}

const keys = (items: AllMediaItem[]) => items.map((i) => `${i.sessionId}/${i.id}`);

describe('allMediaPage', () => {
  it('lists sessions by recency and each session newest first, with its session on every item', () => {
    const { source } = world([2, 1]);
    const page = allMediaPage(source, { cursor: null, limit: 10, tags: null, scanMax: 100 });
    expect(keys(page.items)).toEqual(['s0/s0-m1:0', 's0/s0-m0:0', 's1/s1-m0:0']);
    expect(page.items[0]).toMatchObject({ sessionId: 's0', sessionTitle: 'S0', tagIds: [1] });
    expect(page.next).toBeNull();
  });

  it('pages through every item exactly once, whatever the page size', () => {
    const counts = [3, 0, 5, 1, 0, 0, 4];
    const { source } = world(counts);
    const whole = keys(allMediaPage(source, { cursor: null, limit: 1000, tags: null, scanMax: 100 }).items);
    expect(whole).toHaveLength(13);
    for (const limit of [1, 2, 3, 4, 5, 7, 13]) {
      const pages = walk(source, { limit });
      expect(pages.flat().map((i) => `${i.sessionId}/${i.id}`)).toEqual(whole);
      expect(pages.every((p) => p.length <= limit)).toBe(true);
    }
  });

  it('skips sessions without media', () => {
    const { source } = world([0, 2, 0]);
    expect(keys(walk(source, { limit: 10 }).flat())).toEqual(['s1/s1-m1:0', 's1/s1-m0:0']);
  });

  it('stops reading transcripts once the page is full', () => {
    const { source, reads } = world([3, 3, 3, 3]);
    allMediaPage(source, { cursor: null, limit: 4, tags: null, scanMax: 100 });
    expect(reads).toEqual(['s0', 's1']);
  });

  it('answers short with a cursor once it has read scanMax sessions, and the walk goes on from there', () => {
    const { source } = world([0, 0, 0, 2]);
    const first = allMediaPage(source, { cursor: null, limit: 10, tags: null, scanMax: 2 });
    expect(first.items).toEqual([]);
    expect(first.next).not.toBeNull();
    expect(keys(walk(source, { limit: 10, scanMax: 2 }).flat())).toEqual(['s3/s3-m1:0', 's3/s3-m0:0']);
  });

  it('keeps the sessions carrying any of the tags', () => {
    const { source, reads } = world([1, 1, 1], (i) => [[1], [2], [3]][i]);
    const items = walk(source, { limit: 10, tags: new Set([1, 3]) }).flat();
    expect(items.map((i) => i.sessionId)).toEqual(['s0', 's2']);
    expect(reads).not.toContain('s1');
  });

  it('a session gaining items between pages neither repeats nor loses one', () => {
    const { source, lists } = world([4, 1]);
    const first = allMediaPage(source, { cursor: null, limit: 2, tags: null, scanMax: 100 });
    expect(keys(first.items)).toEqual(['s0/s0-m3:0', 's0/s0-m2:0']);
    lists.get('s0')!.push(item('s0', 9));
    const second = allMediaPage(source, { cursor: decodeCursor(first.next!), limit: 10, tags: null, scanMax: 100 });
    expect(keys(second.items)).toEqual(['s0/s0-m1:0', 's0/s0-m0:0', 's1/s1-m0:0']);
  });

  it('continues from the cursor\'s place when its session has moved to the top since', () => {
    const { source, sessions } = world([3, 1]);
    const first = allMediaPage(source, { cursor: null, limit: 2, tags: null, scanMax: 100 });
    sessions[0].at = 5000;
    const second = allMediaPage(source, { cursor: decodeCursor(first.next!), limit: 10, tags: null, scanMax: 100 });
    expect(keys(second.items)).toEqual(['s0/s0-m0:0', 's1/s1-m0:0']);
    expect(second.next).toBeNull();
  });
});

describe('media cursor', () => {
  it('round-trips and is URL-safe', () => {
    const raw = encodeCursor({ at: 1_760_000_000_000, id: 'ab-cd', rest: 3 });
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(raw)).toEqual({ at: 1_760_000_000_000, id: 'ab-cd', rest: 3 });
  });

  it('refuses what no page handed out', () => {
    for (const raw of ['', 'x', Buffer.from('[1,"a"]').toString('base64url'), Buffer.from('[1,"a",-1]').toString('base64url'), Buffer.from('{"at":1}').toString('base64url')]) {
      expect(decodeCursor(raw)).toBeNull();
    }
  });
});

describe('parseTagFilter', () => {
  it('reads a comma list of ids', () => {
    expect(parseTagFilter('1,3')).toEqual(new Set([1, 3]));
    expect(parseTagFilter('2,x,')).toEqual(new Set([2]));
    expect(parseTagFilter('')).toBeNull();
    expect(parseTagFilter(undefined)).toBeNull();
    expect(parseTagFilter('x')).toBeNull();
  });
});
