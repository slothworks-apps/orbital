import { describe, it, expect } from 'vitest';
import {
  appendFileSync, chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import {
  NamedPathCache, namedInTranscript, readFilePreview, resolveForSession, sessionTranscriptFiles,
  FILE_PREVIEW_MAX_BYTES,
} from '../src/files/preview.js';
import { subagentDirOf } from '../src/walkthrough/subagents.js';
import { makeTmpDir, makeHomeDir } from './tmp.js';

/** A fresh sandbox per test — realpath'd so macOS's /tmp → /private/tmp
 * symlink can't make an inside path look outside. */
function makeCwd() {
  return makeTmpDir('preview');
}


describe('readFilePreview', () => {
  it('resolves a relative path against cwd', () => {
    const cwd = makeCwd();
    writeFileSync(join(cwd, 'note.txt'), 'hello');
    const result = readFilePreview(cwd, 'note.txt');
    expect(result).toMatchObject({ kind: 'ok', content: 'hello', size: 5, lines: 1 });
    expect((result as any).mtimeMs).toBeTypeOf('number');
  });

  it('resolves a nested relative path', () => {
    const cwd = makeCwd();
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src', 'a.ts'), 'x');
    expect(readFilePreview(cwd, 'src/a.ts')).toMatchObject({ kind: 'ok', content: 'x' });
  });

  it('accepts an absolute path inside cwd', () => {
    const cwd = makeCwd();
    const file = join(cwd, 'abs.txt');
    writeFileSync(file, 'abs');
    expect(readFilePreview(cwd, file)).toMatchObject({ kind: 'ok', content: 'abs' });
  });

  it('expands a tilde path (the API-boundary rule)', () => {
    // The fixture lives under the real homedir so `~/...` can name it.
    const cwd = makeHomeDir('preview-test');
    writeFileSync(join(cwd, 'home.txt'), 'home sweet home');
    const viaTilde = `~/${relative(homedir(), join(cwd, 'home.txt'))}`;
    expect(readFilePreview(cwd, viaTilde)).toMatchObject({
      kind: 'ok', content: 'home sweet home',
    });
  });

  it('a tilde path that does not exist is not_found, never a literal ~ directory', () => {
    const cwd = makeCwd();
    const result = readFilePreview(cwd, `~/definitely-not-here-${Math.random().toString(36).slice(2)}`);
    expect(result).toEqual({ kind: 'not_found' });
  });

  it('an empty cwd has no sandbox — outside', () => {
    expect(readFilePreview('', 'anything.txt')).toEqual({ kind: 'outside' });
  });

  it('.. traversal out of cwd is outside', () => {
    const parent = makeCwd();
    const cwd = join(parent, 'inner');
    mkdirSync(cwd);
    writeFileSync(join(parent, 'secret.txt'), 'secret');
    expect(readFilePreview(cwd, '../secret.txt')).toEqual({ kind: 'outside' });
  });

  it('a symlink pointing out of cwd is outside — realpath decides, not the spelling', () => {
    const outside = makeCwd();
    const cwd = makeCwd();
    writeFileSync(join(outside, 'target.txt'), 'leaked');
    symlinkSync(join(outside, 'target.txt'), join(cwd, 'innocent.txt'));
    expect(readFilePreview(cwd, 'innocent.txt')).toEqual({ kind: 'outside' });
  });

  it('a symlink staying inside cwd is ok', () => {
    const cwd = makeCwd();
    writeFileSync(join(cwd, 'real.txt'), 'still inside');
    symlinkSync(join(cwd, 'real.txt'), join(cwd, 'link.txt'));
    expect(readFilePreview(cwd, 'link.txt')).toMatchObject({ kind: 'ok', content: 'still inside' });
  });

  it('a missing file is not_found', () => {
    const cwd = makeCwd();
    expect(readFilePreview(cwd, 'ghost.txt')).toEqual({ kind: 'not_found' });
  });

  it('a path through a file (ENOTDIR) is not_found', () => {
    const cwd = makeCwd();
    writeFileSync(join(cwd, 'file.txt'), 'x');
    expect(readFilePreview(cwd, 'file.txt/deeper.txt')).toEqual({ kind: 'not_found' });
  });

  it('a directory is not_found', () => {
    const cwd = makeCwd();
    mkdirSync(join(cwd, 'dir'));
    expect(readFilePreview(cwd, 'dir')).toEqual({ kind: 'not_found' });
  });

  it('over FILE_PREVIEW_MAX_BYTES is too_large with the size, without reading', () => {
    const cwd = makeCwd();
    const size = FILE_PREVIEW_MAX_BYTES + 1;
    writeFileSync(join(cwd, 'big.log'), Buffer.alloc(size));
    // Stat-able but unreadable: too_large must come from the stat alone.
    chmodSync(join(cwd, 'big.log'), 0o000);
    try {
      expect(readFilePreview(cwd, 'big.log')).toEqual({ kind: 'too_large', size });
    } finally {
      chmodSync(join(cwd, 'big.log'), 0o644);
    }
  });

  it('a NUL byte in the head is binary, media type from the extension', () => {
    const cwd = makeCwd();
    const bytes = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01]);
    writeFileSync(join(cwd, 'font.woff2'), bytes);
    expect(readFilePreview(cwd, 'font.woff2')).toEqual({
      kind: 'binary', size: bytes.length, mediaType: 'font/woff2',
    });
    writeFileSync(join(cwd, 'pic.png'), bytes);
    expect(readFilePreview(cwd, 'pic.png')).toMatchObject({
      kind: 'binary', mediaType: 'image/png',
    });
  });

  it('an unknown binary extension falls back to "binary"', () => {
    const cwd = makeCwd();
    writeFileSync(join(cwd, 'blob.xyz'), Buffer.from([0x00, 0x01, 0x02]));
    expect(readFilePreview(cwd, 'blob.xyz')).toEqual({
      kind: 'binary', size: 3, mediaType: 'binary',
    });
  });

  it('sniffing decides, not the extension — a UTF-8 .dat opens', () => {
    const cwd = makeCwd();
    writeFileSync(join(cwd, 'data.dat'), 'plain text, honestly — ün ⚡');
    expect(readFilePreview(cwd, 'data.dat')).toMatchObject({
      kind: 'ok', content: 'plain text, honestly — ün ⚡',
    });
  });

  it('counts lines as newlines + 1; the empty file is 1 line', () => {
    const cwd = makeCwd();
    writeFileSync(join(cwd, 'three.txt'), 'one\ntwo\nthree');
    expect(readFilePreview(cwd, 'three.txt')).toMatchObject({ kind: 'ok', lines: 3 });
    writeFileSync(join(cwd, 'trailing.txt'), 'one\ntwo\n');
    expect(readFilePreview(cwd, 'trailing.txt')).toMatchObject({ kind: 'ok', lines: 3 });
    writeFileSync(join(cwd, 'empty.txt'), '');
    expect(readFilePreview(cwd, 'empty.txt')).toMatchObject({ kind: 'ok', lines: 1, size: 0 });
  });
});

// Files the session named (spec 2026-10-03-api-token-and-named-files-design
// § 2): an absolute path outside the cwd opens when the transcript says it.

/** A transcript line as the CLI writes it — the path inside a JSON string. */
function line(text: string): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n';
}

/** A session's main transcript in its own dir, with room for subagents. */
function makeTranscript(main: string): string {
  const path = join(makeTmpDir('named'), 'sess.jsonl');
  writeFileSync(path, main);
  return path;
}

describe('namedInTranscript', () => {
  it('finds a path the transcript names', () => {
    const t = makeTranscript(line('Saved the screenshot to /tmp/shot.png.'));
    expect(namedInTranscript([t], '/tmp/shot.png')).toBe(true);
    expect(namedInTranscript([t], '/tmp/other.png')).toBe(false);
    // The sentence's dot ends the path; a dot the path goes on past does not.
    const bak = makeTranscript(line('kept /tmp/shot.png.bak'));
    expect(namedInTranscript([bak], '/tmp/shot.png')).toBe(false);
  });

  it('finds a path named only in a subagent transcript', () => {
    const t = makeTranscript(line('nothing here'));
    const dir = subagentDirOf(t);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-a1.jsonl'), line('wrote /tmp/agent-out.txt'));
    expect(namedInTranscript([t], '/tmp/agent-out.txt')).toBe(false);
    expect(namedInTranscript(sessionTranscriptFiles(t), '/tmp/agent-out.txt')).toBe(true);
  });

  it('finds the JSON-escaped form of a path', () => {
    const path = '/tmp/say "cheese"/réport.md';
    // ASCII-only JSON, as some writers emit it: the quotes and the é escaped.
    const escaped = JSON.stringify(path).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    const t = makeTranscript(`{"text":${escaped}}\n`);
    expect(namedInTranscript([t], path)).toBe(true);
    const quotesOnly = makeTranscript(line(`see ${path}`));
    expect(namedInTranscript([quotesOnly], path)).toBe(true);
  });

  it('does not take /tmp/a from /tmp/ab, but keeps looking past it', () => {
    const t = makeTranscript(line('made /tmp/ab and /tmp/abc'));
    expect(namedInTranscript([t], '/tmp/a')).toBe(false);
    const later = makeTranscript(line('made /tmp/ab, then /tmp/a'));
    expect(namedInTranscript([later], '/tmp/a')).toBe(true);
  });

  it('does not take a path from inside a longer one on the left', () => {
    const t = makeTranscript(line('/private/tmp/x and ~/tmp/y'));
    expect(namedInTranscript([t], '/tmp/x')).toBe(false);
    expect(namedInTranscript([t], '/tmp/y')).toBe(false);
  });

  it('takes a path right after an escaped newline', () => {
    const t = makeTranscript(line('Saved to:\n/tmp/shot.png'));
    expect(namedInTranscript([t], '/tmp/shot.png')).toBe(true);
  });

  it('a relative path never qualifies, even when the transcript holds it', () => {
    const t = makeTranscript(line('see notes.md and ../secret.txt'));
    expect(namedInTranscript([t], 'notes.md')).toBe(false);
    expect(namedInTranscript([t], '../secret.txt')).toBe(false);
  });

  it('matches a ~ path against either spelling', () => {
    const home = '/Users/someone';
    const tilde = makeTranscript(line('wrote ~/notes/a.md'));
    const full = makeTranscript(line('wrote /Users/someone/notes/b.md'));
    expect(namedInTranscript([tilde], '/Users/someone/notes/a.md', home)).toBe(true);
    expect(namedInTranscript([full], '~/notes/b.md', home)).toBe(true);
  });

  it('skips a transcript that is not there', () => {
    const t = makeTranscript(line('/tmp/x'));
    expect(namedInTranscript([join(makeTmpDir('named'), 'gone.jsonl'), t], '/tmp/x')).toBe(true);
  });
});

describe('resolveForSession', () => {
  const namesFrom = (t: string) => (raw: string) => namedInTranscript(sessionTranscriptFiles(t), raw);

  it('reads a named path outside cwd at its realpath, through a symlinked dir', () => {
    // `link` → `real` stands in for macOS's /tmp → /private/tmp.
    const root = makeTmpDir('named-root');
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'link'));
    writeFileSync(join(root, 'real', 'shot.txt'), 'x');
    const spelled = join(root, 'link', 'shot.txt');
    const t = makeTranscript(line(`Saved to ${spelled}`));
    expect(resolveForSession(makeCwd(), spelled, namesFrom(t))).toEqual({
      kind: 'ok', path: realpathSync(join(root, 'real', 'shot.txt')),
    });
  });

  it('refuses an outside path the transcript does not name', () => {
    const outside = makeTmpDir('named-out');
    writeFileSync(join(outside, 'secret.txt'), 's');
    const t = makeTranscript(line('nothing named'));
    expect(resolveForSession(makeCwd(), join(outside, 'secret.txt'), namesFrom(t))).toEqual({ kind: 'outside' });
  });

  it('a named path that does not exist is not_found', () => {
    const ghost = join(makeTmpDir('named-out'), 'ghost.png');
    const t = makeTranscript(line(`will write ${ghost}`));
    expect(resolveForSession(makeCwd(), ghost, namesFrom(t))).toEqual({ kind: 'not_found' });
  });

  it('a named relative path still resolves against cwd only', () => {
    const parent = makeCwd();
    const cwd = join(parent, 'inner');
    mkdirSync(cwd);
    writeFileSync(join(parent, 'secret.txt'), 's');
    const t = makeTranscript(line('../secret.txt'));
    expect(resolveForSession(cwd, '../secret.txt', namesFrom(t))).toEqual({ kind: 'outside' });
  });
});

describe('NamedPathCache', () => {
  it('asks again once the transcript grows, and keeps a yes', () => {
    const t = makeTranscript(line('nothing yet'));
    const named = new NamedPathCache(8).forSession('s', t);
    expect(named('/tmp/later.txt')).toBe(false);
    appendFileSync(t, line('now /tmp/later.txt'));
    expect(named('/tmp/later.txt')).toBe(true);
  });
});
