import { describe, expect, it } from 'vitest';
import { relaySecretCommit, relayUrlCommit, sameRelay } from '../src/remote/relaySettings.js';

describe('sameRelay', () => {
  it('takes a trailing slash, or several, as the same relay', () => {
    expect(sameRelay('wss://relay.example', 'wss://relay.example/')).toBe(true);
    expect(sameRelay('wss://relay.example//', 'wss://relay.example')).toBe(true);
  });

  it('tells other relays apart, a path or a port included', () => {
    expect(sameRelay('wss://relay.example', 'wss://other.example')).toBe(false);
    expect(sameRelay('wss://relay.example/a', 'wss://relay.example')).toBe(false);
    expect(sameRelay('wss://relay.example:8443', 'wss://relay.example')).toBe(false);
  });
});

describe('relayUrlCommit', () => {
  it('does nothing when the trimmed value is what is saved', () => {
    expect(relayUrlCommit('https://a.example', '  https://a.example ', 3)).toBe('none');
    expect(relayUrlCommit('', '   ', 3)).toBe('none');
  });

  it('saves straight away with no phone paired', () => {
    expect(relayUrlCommit('', 'https://b.example', 0)).toBe('save');
  });

  it('asks first when phones are paired', () => {
    expect(relayUrlCommit('', 'https://b.example', 2)).toBe('ask');
    expect(relayUrlCommit('https://b.example', '', 1)).toBe('ask');
  });

  it('cannot decide a change before the phones are known', () => {
    expect(relayUrlCommit('', 'https://b.example', null)).toBe('unknown');
    expect(relayUrlCommit('https://b.example', ' https://b.example ', null)).toBe('none');
  });
});

describe('relaySecretCommit', () => {
  it('does nothing when the trimmed value is what is saved', () => {
    expect(relaySecretCommit('s3cret', ' s3cret ', 2)).toBe('none');
    expect(relaySecretCommit('', '  ', null)).toBe('none');
  });

  it('saves straight away with no phone paired', () => {
    expect(relaySecretCommit('', 's3cret', 0)).toBe('save');
  });

  it('asks first when a changed secret would strand paired phones', () => {
    expect(relaySecretCommit('', 's3cret', 2)).toBe('ask');
    expect(relaySecretCommit('old', 'new', 1)).toBe('ask');
  });

  it('saves a cleared secret without asking: an open relay takes the one the phones hold', () => {
    expect(relaySecretCommit('s3cret', '', 3)).toBe('save');
    expect(relaySecretCommit('s3cret', '  ', null)).toBe('save');
  });

  it('cannot decide a change before the phones are known', () => {
    expect(relaySecretCommit('old', 'new', null)).toBe('unknown');
  });
});
