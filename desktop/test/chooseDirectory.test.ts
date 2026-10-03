import { describe, expect, it } from 'vitest';
import { pickerStartPath } from '../src/lib/chooseDirectory';

const HOME = '/Users/me';

describe('pickerStartPath', () => {
  it('keeps an absolute path, trimmed', () => {
    expect(pickerStartPath('  /Users/me/work/orbital ', HOME)).toBe('/Users/me/work/orbital');
  });

  it('expands a leading tilde', () => {
    expect(pickerStartPath('~', HOME)).toBe(HOME);
    expect(pickerStartPath('~/work', HOME)).toBe('/Users/me/work');
  });

  it('opens on home for anything that is not an absolute path', () => {
    expect(pickerStartPath('', HOME)).toBe(HOME);
    expect(pickerStartPath('work/orbital', HOME)).toBe(HOME);
    expect(pickerStartPath('~other/x', HOME)).toBe(HOME);
    expect(pickerStartPath(undefined, HOME)).toBe(HOME);
    expect(pickerStartPath(42, HOME)).toBe(HOME);
  });
});
