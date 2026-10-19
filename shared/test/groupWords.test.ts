import { describe, expect, it } from 'vitest';
import { attemptsLine, exitWords, joinSentence, osLabel, relayChangeWords } from '../src/remote/groupWords.js';

describe('osLabel', () => {
  it('names the four known OSes', () => {
    expect(osLabel('macos')).toBe('macOS');
    expect(osLabel('linux')).toBe('Linux');
    expect(osLabel('ios')).toBe('iOS');
    expect(osLabel('android')).toBe('Android');
  });

  it('leaves an unknown OS as is', () => {
    expect(osLabel('windows')).toBe('windows');
    expect(osLabel('')).toBe('');
  });
});

describe('joinSentence', () => {
  it('names the OS from a Node platform or an OS name alike, and drops it when unknown', () => {
    expect(joinSentence({ name: 'imac-home', kind: 'desktop', platform: 'darwin' })).toBe('imac-home (desktop, macOS) wants to join');
    expect(joinSentence({ name: 'Pixel', kind: 'phone', platform: 'android' })).toBe('Pixel (phone, Android) wants to join');
    expect(joinSentence({ name: 'box', kind: 'headless', platform: '' })).toBe('box (headless) wants to join');
  });
});

describe('counted words', () => {
  it('agree in number', () => {
    expect(attemptsLine(1)).toBe('That code didn’t match · 1 attempt left');
    expect(attemptsLine(2)).toBe('That code didn’t match · 2 attempts left');
    expect(relayChangeWords(1).body).toBe('1 device will be removed and has to pair again on the new relay.');
    expect(relayChangeWords(3).body).toBe('3 devices will be removed and have to pair again on the new relay.');
    expect(exitWords('leave', 1, 'mac').body).toContain('forgets mac.');
    expect(exitWords('leave', 3, 'mac').body).toContain('forgets the other 3.');
  });
});
