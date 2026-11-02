import { describe, expect, it } from 'vitest';
import {
  codeSpanBareName,
  codeSpanPath,
  findPathMatches,
  hasTextExtension,
  isBareFileName,
  isMediaPath,
  isPdfPath,
  isPressablePath,
  mediaPathsInReply,
} from '../src/paths.js';

describe('media paths', () => {
  it('recognises a PDF as media, but never as text, and pressable like an image', () => {
    expect(isPdfPath('out/report.PDF')).toBe(true);
    expect(isMediaPath('out/report.pdf')).toBe(true);
    expect(hasTextExtension('out/report.pdf')).toBe(false);
    expect(isPressablePath('out/report.pdf')).toBe(true);
  });

  it('never counts code, markdown or other text files as media', () => {
    expect(isMediaPath('web/src/App.tsx')).toBe(false);
    expect(isMediaPath('docs/README.md')).toBe(false);
    expect(isMediaPath('notes/pdf')).toBe(false);
    expect(mediaPathsInReply('Edited web/src/App.tsx and docs/spec.md.')).toEqual([]);
  });
});

describe('mediaPathsInReply', () => {
  it('names images and PDFs in prose in order, trailing punctuation trimmed', () => {
    expect(mediaPathsInReply('Saved out/shot.png, then /tmp/report.pdf.')).toEqual(['out/shot.png', '/tmp/report.pdf']);
  });

  it('keeps a path named twice once, at its first place', () => {
    expect(mediaPathsInReply('See a/one.png and b/two.jpg; a/one.png again, and `a/one.png`.')).toEqual([
      'a/one.png',
      'b/two.jpg',
    ]);
  });

  it('drops a :line suffix from the path', () => {
    expect(mediaPathsInReply('look at icons/logo.svg:3')).toEqual(['icons/logo.svg']);
  });

  it('skips paths inside fenced code blocks, backtick or tilde', () => {
    const text = [
      'Before a/before.png',
      '```bash',
      'open out/fenced.png',
      '```',
      '~~~~',
      'out/tilde.png',
      '```',
      'still code out/still.png',
      '~~~~',
      'After a/after.png',
    ].join('\n');
    expect(mediaPathsInReply(text)).toEqual(['a/before.png', 'a/after.png']);
  });

  it('skips a fenced block left open to the end', () => {
    expect(mediaPathsInReply('a/one.png\n```\nout/never.png')).toEqual(['a/one.png']);
  });

  it('skips an indented code block, but not a nested list item', () => {
    const code = 'Run this:\n\n    convert in.png out/indented.png\n\nDone, see a/x.png';
    expect(mediaPathsInReply(code)).toEqual(['a/x.png']);
    const list = '- first\n\n    see out/in-list.png\n- second';
    expect(mediaPathsInReply(list)).toEqual(['out/in-list.png']);
  });

  it('counts a code span only when it is one path and nothing else', () => {
    expect(mediaPathsInReply('Saved `out/shot.png` for you')).toEqual(['out/shot.png']);
    expect(mediaPathsInReply('Ran `open out/shot.png` for you')).toEqual([]);
    expect(mediaPathsInReply('Ran ``a `b` out/shot.png`` here')).toEqual([]);
  });

  it('reads an unclosed backtick as text', () => {
    expect(mediaPathsInReply('a stray ` before out/shot.png')).toEqual(['out/shot.png']);
  });

  it('leaves a link label and target to the link', () => {
    expect(mediaPathsInReply('[out/label.png](out/target.png) and ![alt](img/a.png), then out/real.png')).toEqual([
      'out/real.png',
    ]);
  });

  it('skips a URL', () => {
    expect(mediaPathsInReply('from https://example.com/a/b.png')).toEqual([]);
  });
});

describe('codeSpanBareName', () => {
  it('takes a span that is one file name, with its line, and ignores the column', () => {
    expect(codeSpanBareName('findAll.ts')).toEqual({ index: 0, length: 10, text: 'findAll.ts', path: 'findAll.ts', line: null });
    expect(codeSpanBareName(' findAll.ts:42 ')).toEqual({ index: 0, length: 13, text: 'findAll.ts:42', path: 'findAll.ts', line: 42 });
    expect(codeSpanBareName('findAll.ts:42:7')).toMatchObject({ path: 'findAll.ts', line: 42, text: 'findAll.ts:42:7' });
    expect(codeSpanBareName('shot.PNG')?.path).toBe('shot.PNG');
    expect(codeSpanBareName('report.pdf')?.path).toBe('report.pdf');
  });

  it('takes a name whose extension is whitelisted even when it reads as a word, since only a span gets here', () => {
    expect(codeSpanBareName('Node.js')?.path).toBe('Node.js');
  });

  it('refuses a command, a path, a version, a dotfile, dots alone and a trailing dot', () => {
    for (const span of ['cat findAll.ts', 'web/src/App.tsx', '1.2', '.env', '.gitignore', '.', '..', 'findAll.ts.',
      'findAll', 'font.woff2', 'a\\b.ts', 'findAll.ts:', 'findAll.ts:x', '']) {
      expect(codeSpanBareName(span), span).toBeNull();
    }
  });

  it('leaves a span with a directory to codeSpanPath, unchanged', () => {
    expect(codeSpanPath('findAll.ts')).toBeNull();
    expect(codeSpanPath('web/src/App.tsx:3')?.line).toBe(3);
  });

  it('never makes a bare name in prose or in a reply\'s media a path', () => {
    expect(findPathMatches('Built with Node.js and findAll.ts.')).toEqual([]);
    expect(mediaPathsInReply('Saved `shot.png` and shot.png.')).toEqual([]);
  });
});

describe('isBareFileName', () => {
  it('accepts a file name alone, never one with a directory, a line or a separator', () => {
    expect(isBareFileName('index.ts')).toBe(true);
    for (const name of ['index.ts:3', 'a/index.ts', 'a\\index.ts', '..', '.', '.env', 'index', 'in dex.ts']) {
      expect(isBareFileName(name), name).toBe(false);
    }
  });
});
