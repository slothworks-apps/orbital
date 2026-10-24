import { describe, expect, it } from 'vitest';
import {
  PER_DEVICE_SETTING_KEYS, SHARED_SETTING_KEYS, isPerDeviceSetting, isSharedSetting, readStampedSettings, stampBeats,
  type SettingStamp,
} from '../src/sharedSettings.js';

const A = 'A'.repeat(43);
const B = 'B'.repeat(43);
const P = 'P'.repeat(43);

/** The value both sides settle on: whichever beats the other, else either (they are equal). */
function settle(x: SettingStamp, y: SettingStamp, primary: string | null): SettingStamp {
  return stampBeats(y, x, primary) ? y : x;
}

describe('stampBeats', () => {
  it('lets the later change win, whoever made it', () => {
    expect(stampBeats({ at: 2, origin: A }, { at: 1, origin: P }, P)).toBe(true);
    expect(stampBeats({ at: 1, origin: P }, { at: 2, origin: A }, P)).toBe(false);
  });

  it('gives a tie to the primary, then to the higher origin id', () => {
    expect(stampBeats({ at: 0, origin: P }, { at: 0, origin: B }, P)).toBe(true);
    expect(stampBeats({ at: 0, origin: B }, { at: 0, origin: P }, P)).toBe(false);
    expect(stampBeats({ at: 0, origin: B }, { at: 0, origin: A }, P)).toBe(true);
    expect(stampBeats({ at: 0, origin: A }, { at: 0, origin: B }, null)).toBe(false);
  });

  it('a joined member\'s reset stamp loses even to an untouched default', () => {
    expect(stampBeats({ at: 0, origin: A }, { at: -1, origin: P }, P)).toBe(true);
  });

  it('a copied value keeps its origin, so the same stamp never beats itself', () => {
    const copied = { at: 5, origin: A };
    expect(stampBeats(copied, { ...copied }, P)).toBe(false);
  });

  it('settles on the same stamp whichever side compares', () => {
    const stamps: SettingStamp[] = [
      { at: 0, origin: A }, { at: 0, origin: B }, { at: 0, origin: P }, { at: 3, origin: A }, { at: 3, origin: B }, { at: -1, origin: B },
    ];
    for (const primary of [P, A, null]) {
      for (const x of stamps) {
        for (const y of stamps) expect(settle(x, y, primary)).toEqual(settle(y, x, primary));
      }
    }
  });
});

describe('the classes', () => {
  it('places no key in both', () => {
    for (const key of SHARED_SETTING_KEYS) expect(isPerDeviceSetting(key)).toBe(false);
    for (const key of PER_DEVICE_SETTING_KEYS) expect(isSharedSetting(key)).toBe(false);
  });

  it('keeps every remote_ and new_session_last_ key on its device', () => {
    expect(isPerDeviceSetting('remote_grants')).toBe(true);
    expect(isPerDeviceSetting('new_session_last_cwd')).toBe(true);
    expect(isSharedSetting('remote_grants')).toBe(false);
  });
});

describe('readStampedSettings', () => {
  it('takes only shared keys with a well-formed stamp, and clamps a time past the bound', () => {
    const read = readStampedSettings({
      settings: {
        default_model: { value: 'opus', at: 10, origin: A },
        map_theme: { value: 'desk', at: 9_999, origin: B },
        claude_executable_path: { value: '/x', at: 10, origin: A },
        confirm_before_clear: { value: true, at: 10, origin: A },
        end_closes_panel: { value: 'false', at: Number.NaN, origin: A },
        map_show_trash: { value: 'false', at: 1, origin: '' },
      },
    }, 100);
    expect(read).toEqual({
      default_model: { value: 'opus', at: 10, origin: A },
      map_theme: { value: 'desk', at: 100, origin: B },
    });
  });

  it('reads anything else as nothing', () => {
    expect(readStampedSettings(null, 1)).toEqual({});
    expect(readStampedSettings({ settings: [] }, 1)).toEqual({});
    expect(readStampedSettings('x', 1)).toEqual({});
  });
});
