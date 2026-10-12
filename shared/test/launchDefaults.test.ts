import { describe, expect, it } from 'vitest';
import { claudeDirExhausted, effectiveLaunchDefaults, type LaunchClaudeDir, type LaunchConfig } from '../src/launchDefaults.js';

const global: LaunchConfig = { claudeDirId: 1, model: 'sonnet', permissionMode: 'acceptEdits' };
const dirs: LaunchClaudeDir[] = [{ id: 1 }, { id: 2 }, { id: 3 }];
const resolve = (tag: Parameters<typeof effectiveLaunchDefaults>[0]['tag'], claudeDirs = dirs, defaultClaudeDirId: number | null = 3) =>
  effectiveLaunchDefaults({ tag, global, defaultClaudeDirId, claudeDirs });

describe('effectiveLaunchDefaults', () => {
  it('is the global default for no tag, a tag without defaults, and a tag from an older Mac', () => {
    for (const tag of [null, undefined, {}, { claude_dir_id: null, model: null, permission_mode: null }]) {
      expect(resolve(tag)).toEqual({ ...global, claudeDirFrom: 'global' });
    }
  });

  it('takes each value the tag names, and only that one', () => {
    expect(resolve({ model: 'opus' })).toEqual({ ...global, model: 'opus', claudeDirFrom: 'global' });
    expect(resolve({ permission_mode: 'plan' })).toEqual({ ...global, permissionMode: 'plan', claudeDirFrom: 'global' });
    expect(resolve({ claude_dir_id: 2 })).toEqual({ ...global, claudeDirId: 2, claudeDirFrom: 'tag' });
  });

  it('gives way to the main default directory when the tag directory is used up', () => {
    const used = [{ id: 1 }, { id: 2, exhausted: true }, { id: 3 }];
    expect(resolve({ claude_dir_id: 2, model: 'opus' }, used)).toMatchObject({
      claudeDirId: 3, claudeDirFrom: 'tag_exhausted', model: 'opus',
    });
    // No main default known: the caller's global.
    expect(resolve({ claude_dir_id: 2 }, used, null)).toMatchObject({ claudeDirId: 1, claudeDirFrom: 'tag_exhausted' });
  });

  it('keeps a tag directory that is not used up', () => {
    const others = [{ id: 1, exhausted: true }, { id: 2, exhausted: false }];
    expect(resolve({ claude_dir_id: 2 }, others)).toMatchObject({ claudeDirId: 2, claudeDirFrom: 'tag' });
  });

  it('ignores a tag directory that is gone or missing on disk', () => {
    expect(resolve({ claude_dir_id: 9 })).toMatchObject({ claudeDirId: 1, claudeDirFrom: 'global' });
    expect(resolve({ claude_dir_id: 2 }, [{ id: 1 }, { id: 2, exists: false }])).toMatchObject({
      claudeDirId: 1, claudeDirFrom: 'global',
    });
  });
});

describe('claudeDirExhausted', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  const later = '2026-10-13T15:00:00Z';
  const earlier = '2026-10-13T09:00:00Z';

  it('is used up by a window at 100 % that has not reset yet', () => {
    expect(claudeDirExhausted({ tracked: true, windows: [{ percent: 40, resetsAt: later }, { percent: 100, resetsAt: later }], waits: [] }, now)).toBe(true);
    expect(claudeDirExhausted({ tracked: true, windows: [{ percent: 100, resetsAt: null }], waits: [] }, now)).toBe(true);
  });

  it('is not used up below 100 %, or once the full window has reset', () => {
    expect(claudeDirExhausted({ tracked: true, windows: [{ percent: 99, resetsAt: later }], waits: [] }, now)).toBe(false);
    expect(claudeDirExhausted({ tracked: true, windows: [{ percent: 100, resetsAt: earlier }], waits: [] }, now)).toBe(false);
  });

  it('is used up while a session of it waits for a reset', () => {
    expect(claudeDirExhausted({ tracked: true, windows: [], waits: [{}] }, now)).toBe(true);
  });

  it('is never used up when limits are not tracked', () => {
    expect(claudeDirExhausted({ tracked: false, windows: [{ percent: 100, resetsAt: later }], waits: [{}] }, now)).toBe(false);
  });
});
