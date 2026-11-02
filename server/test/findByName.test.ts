import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findByName, FIND_LISTING_TTL_MS, ListingCache, walkFiles } from '../src/files/findByName.js';
import { makeTmpDir } from './tmp.js';

const namesNothing = () => false;

describe('findByName', () => {
  it('answers from the first sandbox with a match, and does not list the ones after it', async () => {
    const first = makeTmpDir('find-first');
    const second = makeTmpDir('find-second');
    writeFileSync(join(second, 'a.ts'), 'x');
    const third = makeTmpDir('find-third');
    writeFileSync(join(third, 'a.ts'), 'x');
    const listed: string[] = [];
    const listings = new ListingCache(async (dir) => {
      listed.push(dir);
      return walkFiles(dir);
    });
    const result = await findByName([first, second, third], 'a.ts', namesNothing, listings, '/nonexistent-home');
    expect(result).toEqual({ matches: [{ path: join(second, 'a.ts'), relative: 'a.ts', touched: false }], more: 0 });
    expect(listed).toEqual([first, second]);
  });

  it('skips a sandbox that is the home directory, however it is spelled', async () => {
    const home = makeTmpDir('find-home');
    writeFileSync(join(home, 'a.ts'), 'x');
    const listings = new ListingCache(async (dir) => walkFiles(dir));
    expect(await findByName([home + '/', home], 'a.ts', namesNothing, listings, home)).toEqual({ matches: [], more: 0 });
  });

  it('matches the basename exactly, never a suffix of it', async () => {
    const dir = makeTmpDir('find-exact');
    writeFileSync(join(dir, 'xa.ts'), 'x');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'a.ts'), 'x');
    const listings = new ListingCache(async (d) => walkFiles(d));
    const result = await findByName([dir], 'a.ts', namesNothing, listings, '/nonexistent-home');
    expect(result.matches.map((m) => m.relative)).toEqual(['sub/a.ts']);
  });
});

describe('walkFiles', () => {
  it('stops at its cap', () => {
    const dir = makeTmpDir('find-cap');
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `f${i}.ts`), 'x');
    expect(walkFiles(dir, 3)).toHaveLength(3);
  });
});

describe('ListingCache', () => {
  it('lists a directory once within the TTL, and again after it', async () => {
    let now = 0;
    let calls = 0;
    const cache = new ListingCache(async () => {
      calls++;
      return ['a.ts'];
    }, FIND_LISTING_TTL_MS, () => now);
    await cache.files('/d');
    await cache.files('/d');
    expect(calls).toBe(1);
    now += FIND_LISTING_TTL_MS;
    await cache.files('/d');
    expect(calls).toBe(2);
  });

  it('lists nothing for a lister that fails', async () => {
    const cache = new ListingCache(async () => {
      throw new Error('boom');
    });
    expect(await cache.files('/d')).toEqual([]);
  });
});
