import { describe, it, expect } from 'vitest';
import {
  insideCwd,
  lockPortOf,
  normaliseSelection,
  parseDiagnostics,
  parseIdeLock,
  pathFromFileUri,
  readDiffOutcome,
  sameSelection,
  workspaceRootFor,
} from '../src/ide/protocol.js';

/** A lock as the JetBrains plugin writes it, measured 2026-09-23. */
const LOCK = JSON.stringify({
  workspaceFolders: ['/Users/t/Projects/orbital'],
  pid: 97631,
  ideName: 'WebStorm',
  transport: 'ws',
  runningInWindows: false,
  authToken: 'secret-token',
});

describe('lockPortOf', () => {
  it('reads the port out of the file name, which is the only place it is', () => {
    expect(lockPortOf('60108.lock')).toBe(60108);
  });

  it('refuses anything that is not a port-named lock', () => {
    expect(lockPortOf('notalock.txt')).toBeNull();
    expect(lockPortOf('60108.lock.tmp')).toBeNull();
    expect(lockPortOf('.lock')).toBeNull();
    expect(lockPortOf('99999.lock')).toBeNull();
    expect(lockPortOf('0.lock')).toBeNull();
  });
});

describe('parseIdeLock', () => {
  it('reads a real lock, port from the name and the rest from the JSON', () => {
    expect(parseIdeLock('60108.lock', LOCK)).toEqual({
      port: 60108,
      workspaceFolders: ['/Users/t/Projects/orbital'],
      ideName: 'WebStorm',
      authToken: 'secret-token',
      pid: 97631,
    });
  });

  it('ignores a lock it could not act on', () => {
    expect(parseIdeLock('60108.lock', 'half-written {')).toBeNull();
    expect(parseIdeLock('60108.lock', '"a string"')).toBeNull();
    // No token to authenticate with, and no workspace to match a cwd against.
    expect(parseIdeLock('60108.lock', JSON.stringify({ workspaceFolders: ['/w'] }))).toBeNull();
    expect(parseIdeLock('60108.lock', JSON.stringify({ authToken: 't' }))).toBeNull();
    expect(
      parseIdeLock('60108.lock', JSON.stringify({ authToken: 't', workspaceFolders: ['rel/ative'] })),
    ).toBeNull();
    // A transport this client cannot speak.
    expect(
      parseIdeLock(
        '60108.lock',
        JSON.stringify({ authToken: 't', workspaceFolders: ['/w'], transport: 'stdio' }),
      ),
    ).toBeNull();
    expect(parseIdeLock('not-a-lock', LOCK)).toBeNull();
  });

  it('keeps a lock that only forgot to name itself', () => {
    const lock = parseIdeLock(
      '1.lock',
      JSON.stringify({ authToken: 't', workspaceFolders: ['/w/a', '/w/b'] }),
    );
    expect(lock?.ideName).toBeTruthy();
    expect(lock?.workspaceFolders).toEqual(['/w/a', '/w/b']);
    expect(lock?.pid).toBeNull();
  });

  it('normalises the workspace roots it keeps', () => {
    const lock = parseIdeLock(
      '1.lock',
      JSON.stringify({ authToken: 't', workspaceFolders: ['/w/a/', '/w/a', '/w/b/./'] }),
    );
    expect(lock?.workspaceFolders).toEqual(['/w/a', '/w/b']);
  });
});

describe('normaliseSelection', () => {
  const at = (
    start: [number, number],
    end: [number, number],
    text?: string,
  ): Record<string, unknown> => ({
    selection: {
      start: { line: start[0], character: start[1] },
      end: { line: end[0], character: end[1] },
    },
    ...(text === undefined ? {} : { text }),
    filePath: '/w/a/CLAUDE.md',
  });

  it('turns the measured payload into 1-based lines', () => {
    expect(normaliseSelection(at([84, 0], [88, 39], 'display: inline…'))).toEqual({
      filePath: '/w/a/CLAUDE.md',
      lineStart: 85,
      lineCount: 5,
      text: 'display: inline…',
    });
  });

  it('drops the line a selection stops at the start of', () => {
    // Dragged from the head of line 85 to the head of line 89: four lines.
    expect(normaliseSelection(at([84, 0], [88, 0], 'x'))?.lineCount).toBe(4);
    // One whole line, selected to the start of the next.
    expect(normaliseSelection(at([84, 0], [85, 0], 'x'))?.lineCount).toBe(1);
  });

  it('counts one line for a caret, column zero included', () => {
    expect(normaliseSelection(at([84, 0], [84, 0]))).toEqual({
      filePath: '/w/a/CLAUDE.md',
      lineStart: 85,
      lineCount: 1,
      text: null,
    });
    expect(normaliseSelection(at([84, 12], [84, 12]))?.lineCount).toBe(1);
  });

  it('counts one line for a selection inside one line', () => {
    expect(normaliseSelection(at([84, 2], [84, 30], 'x'))?.lineCount).toBe(1);
  });

  it('says nothing is selected when the text is absent or empty', () => {
    expect(normaliseSelection(at([84, 0], [88, 39]))?.text).toBeNull();
    expect(normaliseSelection(at([84, 0], [88, 39], ''))?.text).toBeNull();
  });

  it('refuses a payload it cannot place', () => {
    expect(normaliseSelection(null)).toBeNull();
    expect(normaliseSelection({ filePath: '/w/a/x.ts' })).toBeNull();
    expect(normaliseSelection({ ...at([1, 0], [1, 0]), filePath: 'relative.ts' })).toBeNull();
    expect(normaliseSelection({ ...at([1, 0], [1, 0]), filePath: '' })).toBeNull();
  });

  it('takes the start as the end when only the start is given', () => {
    const selection = normaliseSelection({
      selection: { start: { line: 3, character: 0 } },
      filePath: '/w/a/x.ts',
    });
    expect(selection).toMatchObject({ lineStart: 4, lineCount: 1 });
  });
});

describe('sameSelection', () => {
  const one = { filePath: '/w/a/x.ts', lineStart: 3, lineCount: 2, text: 'hi' };
  it('is the flood filter: equal by value, not by identity', () => {
    expect(sameSelection(one, { ...one })).toBe(true);
    expect(sameSelection(null, null)).toBe(true);
    expect(sameSelection(one, null)).toBe(false);
    expect(sameSelection(one, { ...one, lineCount: 3 })).toBe(false);
    expect(sameSelection(one, { ...one, text: null })).toBe(false);
  });
});

describe('workspaceRootFor', () => {
  const roots = ['/w/a', '/w/a/inner', '/w/b'];

  it('answers with the longest root covering the cwd', () => {
    expect(workspaceRootFor('/w/a/src', roots)).toBe('/w/a');
    expect(workspaceRootFor('/w/a/inner/src', roots)).toBe('/w/a/inner');
    expect(workspaceRootFor('/w/a', roots)).toBe('/w/a');
  });

  it('does not let a sibling name pass for a root', () => {
    expect(workspaceRootFor('/w/a-evil', roots)).toBeNull();
    expect(workspaceRootFor('/w/c', roots)).toBeNull();
    expect(workspaceRootFor('', roots)).toBeNull();
  });
});

describe('insideCwd', () => {
  it('holds the sandbox the open-files list is filtered by', () => {
    expect(insideCwd('/w/a', '/w/a/src/x.ts')).toBe(true);
    expect(insideCwd('/w/a', '/w/a')).toBe(true);
    expect(insideCwd('/w/a', '/w/a-evil/x.ts')).toBe(false);
    expect(insideCwd('/w/a', '/w/b/x.ts')).toBe(false);
    expect(insideCwd('/w/a', 'relative.ts')).toBe(false);
    expect(insideCwd('', '/w/a/x.ts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Talking back to the editor (spec § Talking back to the editor)
// ---------------------------------------------------------------------------

describe('pathFromFileUri', () => {
  it('unwraps the URI the extension answers with, spaces and all', () => {
    expect(pathFromFileUri('file:///w/a/src/x.ts')).toBe('/w/a/src/x.ts');
    expect(pathFromFileUri('file:///w/a/My%20File.ts')).toBe('/w/a/My File.ts');
  });

  it('takes a bare absolute path too, and refuses everything else', () => {
    expect(pathFromFileUri('/w/a/x.ts')).toBe('/w/a/x.ts');
    expect(pathFromFileUri('relative.ts')).toBeNull();
    expect(pathFromFileUri('')).toBeNull();
    expect(pathFromFileUri('file://')).toBeNull();
  });
});

describe('parseDiagnostics', () => {
  const ANSWER = JSON.stringify([
    {
      uri: 'file:///w/a/src/x.ts',
      diagnostics: [
        {
          message: 'Cannot find name "foo".',
          severity: 'Error',
          source: 'ts',
          range: { start: { line: 11, character: 4 }, end: { line: 11, character: 7 } },
        },
        { message: 'Unused import', severity: 2, range: { start: { line: 0, character: 0 } } },
      ],
    },
  ]);

  it('flattens the groups, with lines the gutter would agree with', () => {
    expect(parseDiagnostics(ANSWER)).toEqual([
      {
        filePath: '/w/a/src/x.ts',
        line: 12,
        severity: 'error',
        message: 'Cannot find name "foo".',
        source: 'ts',
      },
      { filePath: '/w/a/src/x.ts', line: 1, severity: 'warning', message: 'Unused import', source: null },
    ]);
  });

  it('reads severity as a word or as an LSP number, and never drops a finding it cannot rank', () => {
    const severities = ['Warning', 'warn', 'HINT', 1, 3, 4, 'something new', null];
    const found = parseDiagnostics(
      JSON.stringify([
        {
          uri: 'file:///w/a/x.ts',
          diagnostics: severities.map((severity) => ({ message: 'm', severity })),
        },
      ]),
    );
    expect(found.map((d) => d.severity)).toEqual([
      'warning', 'warning', 'hint', 'error', 'info', 'hint', 'info', 'info',
    ]);
  });

  it('answers nothing rather than throwing for anything it cannot read', () => {
    expect(parseDiagnostics('not json')).toEqual([]);
    expect(parseDiagnostics('')).toEqual([]);
    expect(parseDiagnostics('[]')).toEqual([]);
    // No path to attribute the finding to, a finding with no message, and a
    // group that is not a group at all.
    expect(parseDiagnostics(JSON.stringify([{ diagnostics: [{ message: 'm' }] }]))).toEqual([]);
    expect(
      parseDiagnostics(JSON.stringify([{ uri: 'file:///w/a/x.ts', diagnostics: [{}, 'x', null] }])),
    ).toEqual([]);
    expect(parseDiagnostics(JSON.stringify([null, 3, 'x']))).toEqual([]);
  });

  it('takes a single group that was not wrapped in a list', () => {
    const one = JSON.stringify({ uri: '/w/a/x.ts', diagnostics: [{ message: 'm' }] });
    expect(parseDiagnostics(one)).toEqual([
      { filePath: '/w/a/x.ts', line: 1, severity: 'info', message: 'm', source: null },
    ]);
  });
});

describe('readDiffOutcome', () => {
  const text = (value: string) => ({ type: 'text', text: value });

  it('reads the three answers openDiff blocks for', () => {
    expect(readDiffOutcome([text('DIFF_REJECTED')])).toEqual({ kind: 'rejected' });
    expect(readDiffOutcome([text('TAB_CLOSED')])).toEqual({ kind: 'closed' });
    expect(readDiffOutcome([text('FILE_SAVED'), text('const a = 2;\n')])).toEqual({
      kind: 'saved',
      contents: 'const a = 2;\n',
    });
  });

  it('keeps the two elements apart — the verdict is the first, the file the second', () => {
    // A save with nothing behind it says the human accepted and left the
    // content alone; it must not be read as an empty file.
    expect(readDiffOutcome([text('FILE_SAVED')])).toEqual({ kind: 'saved', contents: null });
  });

  it('is null for anything this build does not understand', () => {
    // Guessing here would approve an edit nobody approved.
    expect(readDiffOutcome([text('SOMETHING_NEW')])).toBeNull();
    expect(readDiffOutcome([])).toBeNull();
    expect(readDiffOutcome(null)).toBeNull();
    expect(readDiffOutcome('FILE_SAVED')).toBeNull();
    expect(readDiffOutcome([{ type: 'image' }])).toBeNull();
  });

  it('is tolerant of the whitespace a marker may arrive with', () => {
    expect(readDiffOutcome([text(' FILE_SAVED\n')])).toEqual({ kind: 'saved', contents: null });
  });
});
