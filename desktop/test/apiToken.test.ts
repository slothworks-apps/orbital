import { describe, expect, it } from 'vitest';
import { apiTokenPath, authCookies, bearerHeaders, parseApiToken } from '../src/lib/apiToken';

describe('apiTokenPath', () => {
  it('lives in the server’s default data dir', () => {
    expect(apiTokenPath({}, '/Users/x')).toBe('/Users/x/Library/Application Support/orbital/api-token');
  });

  it('follows ORBITAL_DATA_DIR, as the server does', () => {
    expect(apiTokenPath({ ORBITAL_DATA_DIR: '/tmp/orbital-data' }, '/Users/x')).toBe(
      '/tmp/orbital-data/api-token',
    );
  });
});

describe('parseApiToken', () => {
  it('trims the newline an editor or `echo` leaves', () => {
    expect(parseApiToken('abc_DEF-123\n')).toBe('abc_DEF-123');
  });

  it('reads a missing or blank file as no token', () => {
    expect(parseApiToken(null)).toBeNull();
    expect(parseApiToken('  \n')).toBeNull();
  });
});

describe('bearerHeaders', () => {
  it('sends nothing without a token, so a server without a guard sees what it always did', () => {
    expect(bearerHeaders(null)).toEqual({});
  });

  it('carries the token as a bearer', () => {
    expect(bearerHeaders('t0k')).toEqual({ Authorization: 'Bearer t0k' });
  });
});

describe('authCookies', () => {
  it('sets one cookie per host every window loads from, whatever the port', () => {
    const cookies = authCookies('t0k', 4737);
    expect(cookies.map((c) => new URL(c.url).hostname).sort()).toEqual(['127.0.0.1', 'localhost']);
    for (const cookie of cookies) {
      expect(cookie).toMatchObject({ name: 'orbital_token', value: 't0k', httpOnly: true, sameSite: 'strict', path: '/' });
    }
  });
});
