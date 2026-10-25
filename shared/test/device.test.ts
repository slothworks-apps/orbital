import { describe, expect, it } from 'vitest';
import { RESPONDER_FIRST_ID, capabilitiesOf, initiates, osName } from '../src/remote/device.js';

describe('initiates', () => {
  const a = 'AAAA';
  const b = 'BBBB';
  it('a phone always initiates', () => {
    expect(initiates({ id: b, kind: 'phone' }, { id: a, kind: 'desktop' })).toBe(true);
  });
  it('never initiates towards a phone', () => {
    expect(initiates({ id: a, kind: 'desktop' }, { id: b, kind: 'phone' })).toBe(false);
  });
  it('initiates towards a device paired through an older Mac code', () => {
    expect(initiates({ id: b, kind: 'desktop' }, { id: a, kind: null })).toBe(true);
  });
  it('between two other members the lower id initiates, and exactly one does', () => {
    expect(initiates({ id: a, kind: 'desktop' }, { id: b, kind: 'headless' })).toBe(true);
    expect(initiates({ id: b, kind: 'headless' }, { id: a, kind: 'desktop' })).toBe(false);
  });
  it('a kind it does not know counts as a member, not as a phone', () => {
    expect(initiates({ id: a, kind: 'desktop' }, { id: b, kind: 'tablet' })).toBe(true);
    expect(initiates({ id: b, kind: 'desktop' }, { id: a, kind: 'tablet' })).toBe(false);
  });
});

describe('capabilitiesOf', () => {
  it('a phone serves nothing, and only a desktop or headless names the group capability', () => {
    expect(capabilitiesOf('phone')).toEqual([]);
    expect(capabilitiesOf('headless')).toEqual(['sessions', 'group', 'settings-sync']);
    expect(capabilitiesOf('desktop')).toContain('sessions');
    expect(capabilitiesOf('desktop')).toContain('group');
  });
});

describe('osName', () => {
  it('names Node and Capacitor platforms', () => {
    expect(osName('darwin')).toBe('macos');
    expect(osName('linux')).toBe('linux');
    expect(osName('ios')).toBe('ios');
  });
});

it('responder ids never meet initiator ids a phone can reach', () => {
  expect(RESPONDER_FIRST_ID).toBeGreaterThan(2 ** 30);
  expect(RESPONDER_FIRST_ID).toBeLessThan(2 ** 32);
});
