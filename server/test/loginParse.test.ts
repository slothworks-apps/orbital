import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  LineSplitter,
  SILENT_BROWSER,
  cleanLoginCode,
  lastMeaningfulLine,
  loginEnv,
  manualUrlOf,
  readAuthStatus,
  readDesignEvent,
  readDesignStatus,
} from '../src/login/parse.js';

/**
 * What `claude auth login`, `claude design-login --json` and the two status
 * commands write is undocumented (spec 2026-10-21-log-in-from-orbital-design
 * § What the CLI does); these pin the readings of the shapes the spike saw,
 * and that anything else is ignored rather than thrown.
 */

const MANUAL = 'https://claude.ai/oauth/authorize?code=true&client_id=x&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s';

describe('auth login output', () => {
  it('reads the manual URL off its line, and nothing off any other', () => {
    expect(manualUrlOf(`If the browser didn't open, visit: ${MANUAL}`)).toBe(MANUAL);
    expect(manualUrlOf('\x1b[2mIf the browser didn’t open, visit: https://claude.ai/x\x1b[0m')).toBe('https://claude.ai/x');
    expect(manualUrlOf('Opening browser to sign in…')).toBeNull();
    expect(manualUrlOf("If the browser didn't open, visit: javascript:alert(1)")).toBeNull();
  });

  it('keeps the prompt, which has no newline, pending until the next line ends it', () => {
    const split = new LineSplitter();
    expect(split.push('Opening browser to sign in…\nIf the browser didn')).toEqual(['Opening browser to sign in…']);
    expect(split.push(`'t open, visit: ${MANUAL}\nPaste code here if prompted > `)).toEqual([`If the browser didn't open, visit: ${MANUAL}`]);
    expect(split.pending).toBe('Paste code here if prompted > ');
    expect(split.push('Login failed: Request failed with status code 400\n')).toEqual([
      'Paste code here if prompted > Login failed: Request failed with status code 400',
    ]);
    expect(split.flush()).toEqual([]);
  });

  it('takes the CLI\'s last words for a failure, past the prompt and its own narration', () => {
    expect(lastMeaningfulLine([
      'Opening browser to sign in…',
      `If the browser didn't open, visit: ${MANUAL}`,
      'Paste code here if prompted > Login failed: Request failed with status code 400',
      '',
    ])).toBe('Login failed: Request failed with status code 400');
    expect(lastMeaningfulLine(['Opening browser to sign in…', 'Paste code here if prompted > '])).toBeNull();
  });
});

describe('design-login JSON lines', () => {
  it('reads pages and done', () => {
    expect(readDesignEvent(JSON.stringify({ event: 'pages', url: 'http://localhost:5000/cb', manual_url: 'https://claude.ai/design/code', manual_first: false })))
      .toEqual({ event: 'pages', url: 'http://localhost:5000/cb', manualUrl: 'https://claude.ai/design/code', manualFirst: false });
    expect(readDesignEvent('{"event":"done","ok":true}')).toEqual({ event: 'done', ok: true, message: null });
    expect(readDesignEvent('{"event":"done","ok":false,"message":"Sign-in timed out."}'))
      .toEqual({ event: 'done', ok: false, message: 'Sign-in timed out.' });
  });

  it('ignores unknown events, broken lines and pages without a usable URL', () => {
    expect(readDesignEvent('{"event":"progress","step":2}')).toBeNull();
    expect(readDesignEvent('{"event":"pages","url":')).toBeNull();
    expect(readDesignEvent('not json')).toBeNull();
    expect(readDesignEvent('[1,2]')).toBeNull();
    expect(readDesignEvent('{"event":"pages","url":"file:///etc/passwd"}')).toBeNull();
  });
});

describe('status answers', () => {
  it('reads auth status, field by field', () => {
    expect(readAuthStatus(JSON.stringify({
      loggedIn: true, authMethod: 'claude.ai', email: 'a@example.com', orgName: 'Acme', subscriptionType: 'max', configDirectory: '/x',
    }))).toEqual({ loggedIn: true, email: 'a@example.com', orgName: 'Acme', plan: 'max' });
    expect(readAuthStatus('{"loggedIn":false}')).toEqual({ loggedIn: false, email: null, orgName: null, plan: null });
  });

  it('reads an answer without loggedIn, or no answer, as unknown — never as logged out', () => {
    expect(readAuthStatus('{"email":"a@example.com"}')).toBeNull();
    expect(readAuthStatus('')).toBeNull();
    expect(readAuthStatus('Error: something')).toBeNull();
  });

  it('reads the design status, and an answer without signed_in as unknown', () => {
    expect(readDesignStatus('{"available":true,"signed_in":false,"can_sign_in_here":true}')).toEqual({ available: true, signedIn: false });
    expect(readDesignStatus('{"signed_in":true}')).toEqual({ available: true, signedIn: true });
    expect(readDesignStatus('{"available":false,"signed_in":false,"reason":"not on this plan"}')).toEqual({ available: false, signedIn: false });
    expect(readDesignStatus('{"available":true}')).toBeNull();
  });
});

describe('the login environment', () => {
  const home = '/Users/someone';
  const base = {
    PATH: '/usr/bin', HOME: home, CLAUDE_CONFIG_DIR: '/elsewhere', CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SSE_PORT: '1234', BROWSER: 'firefox',
  };

  it('gives the default profile no CLAUDE_CONFIG_DIR, and another its path', () => {
    expect(loginEnv(base, join(home, '.claude'), { remote: false, home })).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(loginEnv(base, '/Users/someone/.claude-work', { remote: false, home }).CLAUDE_CONFIG_DIR).toBe('/Users/someone/.claude-work');
  });

  it('drops CLAUDECODE and every CLAUDE_CODE_ variable, keeping the rest', () => {
    const env = loginEnv(base, join(home, '.claude'), { remote: false, home });
    expect(Object.keys(env).filter((k) => k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_'))).toEqual([]);
    expect(env.PATH).toBe('/usr/bin');
  });

  it('silences BROWSER for a login from another device and removes it for one on this Mac', () => {
    expect(loginEnv(base, join(home, '.claude'), { remote: true, home }).BROWSER).toBe(SILENT_BROWSER);
    expect(loginEnv(base, join(home, '.claude'), { remote: false, home })).not.toHaveProperty('BROWSER');
  });
});

describe('the pasted code', () => {
  it('is trimmed, and refused when empty or carrying a line break', () => {
    expect(cleanLoginCode('  abc#def\n')).toBe('abc#def');
    expect(cleanLoginCode('   ')).toBeNull();
    expect(cleanLoginCode('abc\ndef')).toBeNull();
    expect(cleanLoginCode(42)).toBeNull();
  });
});
