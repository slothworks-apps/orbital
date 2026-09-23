import { describe, it, expect } from 'vitest';
import {
  editTargetPath,
  inputForSavedContents,
  isDiffableTool,
  proposedContents,
} from '../src/ide/edits.js';

/**
 * The arithmetic `openDiff` rests on (spec 2026-09-23-ide-bridge-design
 * § Talking back to the editor). Both directions are worth pinning: the
 * forward one decides what a human is shown, and getting it wrong shows a
 * change the tool will not make; the reverse one decides what gets written
 * after a hand-edit, and getting it wrong writes the version the human
 * edited away from.
 */

const FILE = '/w/a.ts';
const ORIGINAL = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';

describe('which tools can be reviewed as a diff', () => {
  it('takes the three whose input both determines and can reproduce a file', () => {
    expect(isDiffableTool('Write')).toBe(true);
    expect(isDiffableTool('Edit')).toBe(true);
    expect(isDiffableTool('MultiEdit')).toBe(true);
  });

  it('takes nothing else — a Bash command is not a file', () => {
    for (const tool of ['Bash', 'Read', 'NotebookEdit', 'WebFetch', 'AskUserQuestion']) {
      expect(isDiffableTool(tool)).toBe(false);
      expect(editTargetPath(tool, { file_path: FILE })).toBeNull();
    }
  });

  it('names the file, and nothing when the input does not', () => {
    expect(editTargetPath('Edit', { file_path: FILE })).toBe(FILE);
    expect(editTargetPath('Edit', {})).toBeNull();
    expect(editTargetPath('Edit', { file_path: '' })).toBeNull();
    expect(editTargetPath('Edit', { file_path: 42 })).toBeNull();
  });
});

describe('the file as the tool would leave it', () => {
  it('is Write’s own content, whether or not the file exists yet', () => {
    expect(proposedContents('Write', { file_path: FILE, content: 'x' }, ORIGINAL)).toBe('x');
    expect(proposedContents('Write', { file_path: FILE, content: 'x' }, null)).toBe('x');
    expect(proposedContents('Write', { file_path: FILE }, null)).toBeNull();
  });

  it('applies an Edit exactly where the CLI would', () => {
    expect(
      proposedContents('Edit', { file_path: FILE, old_string: 'b = 2', new_string: 'b = 9' }, ORIGINAL),
    ).toBe('const a = 1;\nconst b = 9;\nconst c = 3;\n');
  });

  it('refuses a patch that does not apply, rather than showing a change that will not happen', () => {
    // Not there at all.
    expect(
      proposedContents('Edit', { file_path: FILE, old_string: 'nope', new_string: 'x' }, ORIGINAL),
    ).toBeNull();
    // There more than once, without `replace_all` — the CLI errors on this,
    // so there is no single file to show.
    expect(
      proposedContents('Edit', { file_path: FILE, old_string: 'const', new_string: 'let' }, ORIGINAL),
    ).toBeNull();
    // And with `replace_all`, every occurrence goes.
    expect(
      proposedContents(
        'Edit',
        { file_path: FILE, old_string: 'const', new_string: 'let', replace_all: true },
        ORIGINAL,
      ),
    ).toBe('let a = 1;\nlet b = 2;\nlet c = 3;\n');
  });

  it('has no file to patch when the file is not there', () => {
    expect(
      proposedContents('Edit', { file_path: FILE, old_string: 'a', new_string: 'b' }, null),
    ).toBeNull();
  });

  it('applies MultiEdit’s replacements in order, each onto the last result', () => {
    expect(
      proposedContents(
        'MultiEdit',
        {
          file_path: FILE,
          edits: [
            { old_string: 'a = 1', new_string: 'a = 7' },
            // Only matches because the first replacement already landed.
            { old_string: 'a = 7;\nconst b', new_string: 'a = 7;\nlet b' },
          ],
        },
        ORIGINAL,
      ),
    ).toBe('const a = 7;\nlet b = 2;\nconst c = 3;\n');
  });

  it('refuses a MultiEdit whose later replacement no longer applies', () => {
    expect(
      proposedContents(
        'MultiEdit',
        {
          file_path: FILE,
          edits: [
            { old_string: 'a = 1', new_string: 'a = 7' },
            { old_string: 'a = 1', new_string: 'a = 8' },
          ],
        },
        ORIGINAL,
      ),
    ).toBeNull();
    expect(proposedContents('MultiEdit', { file_path: FILE, edits: [] }, ORIGINAL)).toBeNull();
    expect(proposedContents('MultiEdit', { file_path: FILE, edits: 'no' }, ORIGINAL)).toBeNull();
  });
});

describe('saying a hand-edit back in the tool’s own vocabulary', () => {
  const SAVED = 'const a = 1;\nconst b = 2;\nconst c = 4;\n';

  it('rewrites Write’s content, so the agent still does the writing', () => {
    expect(
      inputForSavedContents('Write', { file_path: FILE, content: 'x' }, ORIGINAL, SAVED),
    ).toEqual({ file_path: FILE, content: SAVED });
  });

  it('collapses Edit to one whole-file replacement, unambiguous by construction', () => {
    const input = inputForSavedContents(
      'Edit',
      { file_path: FILE, old_string: 'c = 3', new_string: 'c = 5' },
      ORIGINAL,
      SAVED,
    );
    expect(input).toEqual({
      file_path: FILE,
      old_string: ORIGINAL,
      new_string: SAVED,
      replace_all: false,
    });
    // And the rewritten input reproduces exactly what the human saved.
    expect(proposedContents('Edit', input as Record<string, unknown>, ORIGINAL)).toBe(SAVED);
  });

  it('collapses MultiEdit the same way', () => {
    const input = inputForSavedContents(
      'MultiEdit',
      { file_path: FILE, edits: [{ old_string: 'c = 3', new_string: 'c = 5' }] },
      ORIGINAL,
      SAVED,
    );
    expect(input).toEqual({
      file_path: FILE,
      edits: [{ old_string: ORIGINAL, new_string: SAVED }],
    });
    expect(proposedContents('MultiEdit', input as Record<string, unknown>, ORIGINAL)).toBe(SAVED);
  });

  it('has nothing to key a patch on when the original is empty or absent', () => {
    expect(
      inputForSavedContents('Edit', { file_path: FILE, old_string: '', new_string: 'x' }, '', SAVED),
    ).toBeNull();
    expect(
      inputForSavedContents('Edit', { file_path: FILE, old_string: 'a', new_string: 'b' }, null, SAVED),
    ).toBeNull();
    // Write is the exception: its input IS the file, with or without one.
    expect(inputForSavedContents('Write', { file_path: FILE }, null, SAVED)).toEqual({
      file_path: FILE,
      content: SAVED,
    });
  });
});
