import { describe, expect, it } from 'vitest';
import {
  MIN_RELAY_VERSION, MIN_SERVER_VERSION, RELAY_VERSION_BEFORE_ANNOUNCING, compareVersions, isSupportedServer, phoneAppVersion,
  relayTooOld,
} from '../src/remote/version.js';

describe('compareVersions', () => {
  it('compares dotted numbers numerically, a missing part as zero', () => {
    expect(compareVersions('0.17.10', '0.17.9')).toBe(1);
    expect(compareVersions('0.17', '0.17.0')).toBe(0);
    expect(compareVersions('0.16.9', '0.17.0')).toBe(-1);
  });

  it('ignores a pre-release suffix and counts dev as the newest', () => {
    expect(compareVersions('0.18.0-beta.1', '0.18.0')).toBe(0);
    expect(compareVersions('dev', '99.0.0')).toBe(1);
    expect(compareVersions('dev', 'dev')).toBe(0);
    expect(compareVersions('1.0.0', 'dev')).toBe(-1);
  });

  it('supports a Mac from MIN_SERVER_VERSION on', () => {
    expect(isSupportedServer(MIN_SERVER_VERSION)).toBe(true);
    expect(isSupportedServer('dev')).toBe(true);
    expect(isSupportedServer('0.0.1')).toBe(false);
    expect(isSupportedServer('')).toBe(false);
  });
});

describe('relayTooOld', () => {
  it('passes a relay at or above MIN_RELAY_VERSION and refuses one below, naming both', () => {
    expect(relayTooOld(MIN_RELAY_VERSION)).toBeNull();
    expect(relayTooOld('99.0.0')).toBeNull();
    expect(relayTooOld('0.0.1')).toEqual({ relayVersion: '0.0.1', needed: MIN_RELAY_VERSION });
  });

  it('takes a relay that announces nothing for RELAY_VERSION_BEFORE_ANNOUNCING', () => {
    for (const silent of [undefined, null, '', '  ']) {
      const verdict = relayTooOld(silent);
      const expected = compareVersions(RELAY_VERSION_BEFORE_ANNOUNCING, MIN_RELAY_VERSION) < 0
        ? { relayVersion: RELAY_VERSION_BEFORE_ANNOUNCING, needed: MIN_RELAY_VERSION }
        : null;
      expect(verdict).toEqual(expected);
    }
  });
});

describe('phoneAppVersion', () => {
  it('reads the version after the app name, and nothing from a hello that names none', () => {
    expect(phoneAppVersion('orbital-mobile/0.3.2')).toBe('0.3.2');
    expect(phoneAppVersion('orbital-mobile/0.4.0-beta.1')).toBe('0.4.0-beta.1');
    expect(phoneAppVersion('0.4.0')).toBe('0.4.0');
    expect(phoneAppVersion('orbital-mobile/test')).toBeNull();
    expect(phoneAppVersion('orbital-mobile/')).toBeNull();
  });
});
