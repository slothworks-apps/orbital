import { describe, expect, it } from 'vitest';
import {
  attemptsLine, exitWords, joinSentence, osLabel, osVersionText, relayChangeWords, updateSessionsWords, updateWaitingWords,
} from '../src/remote/groupWords.js';

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
    expect(updateSessionsWords(1, 'nuc').question).toBe('1 session is running on nuc.');
    expect(updateSessionsWords(3, 'nuc').question).toBe('3 sessions are running on nuc.');
    expect(updateSessionsWords(1, 'nuc').body).toBe('Update now stops it when it restarts.');
    expect(updateSessionsWords(3, 'nuc').body).toBe('Update now stops them when it restarts.');
    expect(updateWaitingWords(1, '0.36.0').line).toBe('waiting for 1 session to finish · then 0.36.0');
    expect(updateWaitingWords(2, '0.36.0').phoneState).toBe('online · waiting for 2 sessions');
  });

  it('a confirm that named fewer sessions than run now says how many started since', () => {
    expect(updateSessionsWords(4, 'nuc', 3)).toEqual({
      question: '4 sessions are running on nuc now.',
      body: '1 started since you pressed Update. Update now stops them when it restarts.',
    });
    // The same count or fewer: the plain words.
    expect(updateSessionsWords(2, 'nuc', 3).question).toBe('2 sessions are running on nuc.');
  });
});

describe('osVersionText', () => {
  it('puts the version after the OS label, and gives the label alone without one', () => {
    expect(osVersionText('macos', '14.6')).toBe('macOS 14.6');
    expect(osVersionText('android', ' 15 ')).toBe('Android 15');
    expect(osVersionText('ios', '')).toBe('iOS');
  });
});
