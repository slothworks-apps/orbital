import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findByName, FIND_LISTING_TTL_MS, ListingCache, walkFiles } from '../src/files/findByName.js';
import { makeTmpDir } from './tmp.js';

const noTranscripts = () => [];

/** A transcript file whose one tool call reads each of `paths`. */
function transcriptNaming(paths: string[]): string {
  const file = join(makeTmpDir('find-transcript'), 's.jsonl');
  writeFileSync(file, paths.map((path) => JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: path } }] },
  }) + '\n').join(''));
  return file;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('findByName', () => {
  it('answers from the first sandbox with a match, and does not list the ones after it', async () => {
    const first = makeTmpDir('find-first');
    const second = makeTmpDir('find-second');
    writeFileSync(join(second, 'a.ts'), 'x');
    const third = makeTmpDir('find-third');
    writeFileSync(join(third, 'a.ts'), 'x');
    const listed: string[] = [];
    const listings = new ListingCache({
      list: async (dir) => {
        listed.push(dir);
        return walkFiles(dir);
      },
    });
    const result = await findByName([first, second, third], 'a.ts', noTranscripts, listings, '/nonexistent-home');
    expect(result).toEqual({ matches: [{ path: join(second, 'a.ts'), relative: 'a.ts', touched: false }], more: 0 });
    expect(listed).toEqual([first, second]);
  });

  it('skips a sandbox that is the home directory, however it is spelled', async () => {
    const home = makeTmpDir('find-home');
    writeFileSync(join(home, 'a.ts'), 'x');
    const listings = new ListingCache({ list: walkFiles });
    expect(await findByName([home + '/', home], 'a.ts', noTranscripts, listings, home)).toEqual({ matches: [], more: 0 });
  });

  it('matches the basename exactly, never a suffix of it', async () => {
    const dir = makeTmpDir('find-exact');
    writeFileSync(join(dir, 'xa.ts'), 'x');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'a.ts'), 'x');
    const listings = new ListingCache({ list: walkFiles });
    const result = await findByName([dir], 'a.ts', noTranscripts, listings, '/nonexistent-home');
    expect(result.matches.map((m) => m.relative)).toEqual(['sub/a.ts']);
  });

  it('reads the transcripts once for every match, and puts the ones they name first', async () => {
    const dir = makeTmpDir('find-touched');
    for (const sub of ['a', 'bb', 'ccc']) {
      mkdirSync(join(dir, sub));
      writeFileSync(join(dir, sub, 'x.ts'), 'x');
    }
    const transcript = transcriptNaming([join(dir, 'ccc/x.ts'), join(dir, 'bb/x.tsx')]);
    let asked = 0;
    const transcripts = () => {
      asked++;
      return [transcript];
    };
    const result = await findByName([dir], 'x.ts', transcripts, new ListingCache({ list: walkFiles }), '/nonexistent-home');
    expect(result.matches).toEqual([
      { path: join(dir, 'ccc/x.ts'), relative: 'ccc/x.ts', touched: true },
      { path: join(dir, 'a/x.ts'), relative: 'a/x.ts', touched: false },
      { path: join(dir, 'bb/x.ts'), relative: 'bb/x.ts', touched: false },
    ]);
    expect(asked).toBe(1);
  });

  it('keeps a symlink out of the sandbox only when the transcripts name it', async () => {
    const dir = makeTmpDir('find-link');
    const outside = makeTmpDir('find-link-outside');
    writeFileSync(join(outside, 'secret.ts'), 'x');
    mkdirSync(join(dir, 'named'));
    symlinkSync(join(outside, 'secret.ts'), join(dir, 'secret.ts'));
    symlinkSync(join(outside, 'secret.ts'), join(dir, 'named', 'secret.ts'));
    const transcript = transcriptNaming([join(dir, 'named/secret.ts')]);
    const result = await findByName(
      [dir], 'secret.ts', () => [transcript], new ListingCache({ list: walkFiles }), '/nonexistent-home',
    );
    expect(result.matches).toEqual([{ path: join(dir, 'named/secret.ts'), relative: 'named/secret.ts', touched: true }]);
  });

  it('lists a held sandbox afresh before answering that nothing matches', async () => {
    const dir = makeTmpDir('find-fresh');
    let calls = 0;
    const listings = new ListingCache({
      list: async (d) => {
        calls++;
        return walkFiles(d);
      },
    });
    expect((await findByName([dir], 'new.ts', noTranscripts, listings, '/nonexistent-home')).matches).toEqual([]);
    expect(calls).toBe(1);
    // The agent writes the file inside the listing's TTL.
    writeFileSync(join(dir, 'new.ts'), 'x');
    const result = await findByName([dir], 'new.ts', noTranscripts, listings, '/nonexistent-home');
    expect(result.matches.map((m) => m.relative)).toEqual(['new.ts']);
    expect(calls).toBe(2);
  });

  it('lists up to its cap and counts the rest', async () => {
    const dir = makeTmpDir('find-max');
    for (let i = 0; i < 5; i++) {
      mkdirSync(join(dir, `d${i}`));
      writeFileSync(join(dir, `d${i}`, 'x.ts'), 'x');
    }
    const result = await findByName(
      [dir], 'x.ts', noTranscripts, new ListingCache({ list: walkFiles }), '/nonexistent-home', 3,
    );
    expect(result.matches.map((m) => m.relative)).toEqual(['d0/x.ts', 'd1/x.ts', 'd2/x.ts']);
    expect(result.more).toBe(2);
  });
});

describe('walkFiles', () => {
  it('stops at its cap', async () => {
    const dir = makeTmpDir('find-cap');
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `f${i}.ts`), 'x');
    expect(await walkFiles(dir, 3)).toHaveLength(3);
  });
});

describe('ListingCache', () => {
  it('lists a directory once within the TTL, and drops the listing when it ends', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const cache = new ListingCache({
      list: async () => {
        calls++;
        return ['a.ts'];
      },
    });
    await cache.files('/d');
    await cache.files('/d');
    expect(calls).toBe(1);
    vi.advanceTimersByTime(FIND_LISTING_TTL_MS);
    expect(cache.has('/d')).toBe(false);
    await cache.files('/d');
    expect(calls).toBe(2);
  });

  it('lists nothing for a lister that fails, reports it, and does not keep the failure', async () => {
    let calls = 0;
    const failures: Array<[string, string]> = [];
    const cache = new ListingCache({
      list: async () => {
        calls++;
        throw new Error('boom');
      },
      onFailure: (dir, during) => failures.push([dir, during]),
    });
    expect(await cache.files('/d')).toEqual([]);
    expect(cache.has('/d')).toBe(false);
    expect(failures).toEqual([['/d', 'list']]);
    await cache.files('/d');
    expect(calls).toBe(2);
  });
});
