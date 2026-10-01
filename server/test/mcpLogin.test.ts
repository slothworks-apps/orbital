import { describe, it, expect } from 'vitest';
import { McpLoginUnsupportedError, mcpLoginUrl } from '../src/mcp/login.js';

/** The answer the spike saw from `mcpAuthenticate` (idea mcp-login-from-orbital). */
const SPIKE_ANSWER = {
  authUrl: 'https://mcp.cloudflare.com/authorize?response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A3118%2Fcallback',
  requiresUserAction: true,
  callbackExpected: true,
  redirectScheme: 'localhost',
  state: 's',
  callbackPort: 3118,
};

describe('mcpLoginUrl', () => {
  it('answers the URL when the CLI catches the callback on localhost', () => {
    expect(mcpLoginUrl(SPIKE_ANSWER)).toBe(SPIKE_ANSWER.authUrl);
  });

  it('takes an answer without the optional fields', () => {
    expect(mcpLoginUrl({ authUrl: 'http://127.0.0.1:9000/auth' })).toBe('http://127.0.0.1:9000/auth');
  });

  it.each([
    ['a callback Orbital would have to relay', { ...SPIKE_ANSWER, redirectScheme: 'claude' }],
    ['no callback at all', { ...SPIKE_ANSWER, callbackExpected: false }],
    ['no URL', { requiresUserAction: true }],
    ['a URL that does not parse', { authUrl: 'not a url' }],
    ['a non-http(s) URL', { authUrl: 'javascript:alert(1)' }],
    ['a file URL', { authUrl: 'file:///etc/passwd' }],
    ['nothing', undefined],
  ])('refuses %s', (_label, answer) => {
    expect(() => mcpLoginUrl(answer)).toThrow(McpLoginUnsupportedError);
  });
});
