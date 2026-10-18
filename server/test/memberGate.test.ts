import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type HelloMessage } from '@orbital/shared/remote/messages';
import { capabilitiesOf } from '@orbital/shared/remote/device';
import { memberTooOld } from '../src/remote/memberGate.js';

const hello = (patch: Partial<HelloMessage>): HelloMessage => ({ t: 'hello', protocol: PROTOCOL_VERSION, ...patch });

describe('memberTooOld', () => {
  it('never judges a phone, even a shipped one', () => {
    expect(memberTooOld('phone', hello({ app: 'orbital-mobile/0.1.0' }))).toBe(false);
  });
  it('a hello naming group will do', () => {
    expect(memberTooOld('desktop', hello({ kind: 'desktop', capabilities: capabilitiesOf('desktop') }))).toBe(false);
    expect(memberTooOld('headless', hello({ kind: 'headless', capabilities: capabilitiesOf('headless') }))).toBe(false);
  });
  it('a shipped Mac, whose hello names no capabilities, is too old', () => {
    expect(memberTooOld('desktop', hello({ server: '0.14.0', macName: 'studio' }))).toBe(true);
    expect(memberTooOld(null, hello({ server: '0.14.0', macName: 'studio' }))).toBe(true);
    expect(memberTooOld('desktop', hello({ kind: 'desktop', capabilities: ['sessions'] }))).toBe(true);
  });
  it('a member not heard from yet cannot be told', () => {
    expect(memberTooOld('desktop', null)).toBe(false);
  });
});
