import { describe, expect, it } from 'vitest';
import {
  classifyChildExit,
  classifyProbe,
  decideNavigation,
  decideStartup,
  needsCliPrompt,
  windowUrl,
} from '../src/lib/startup';

describe('classifyProbe', () => {
  it('reads a fetch failure as nothing listening', () => {
    expect(classifyProbe({ error: true })).toEqual({ kind: 'refused' });
  });

  it('recognises orbital and carries its health payload', () => {
    const body = {
      app: 'orbital',
      claudeCli: { source: 'path', path: '/opt/homebrew/bin/claude', version: '2.1.272' },
    };
    expect(classifyProbe({ ok: true, body })).toEqual({ kind: 'orbital', health: body });
  });

  it('treats a foreign JSON answer as another service on the port', () => {
    expect(classifyProbe({ ok: true, body: { app: 'grafana' } })).toEqual({ kind: 'other' });
  });

  it('treats a body with no app field as another service', () => {
    expect(classifyProbe({ ok: true, body: { status: 'up' } })).toEqual({ kind: 'other' });
  });

  it('treats a non-2xx answer as another service, even if the body looks like ours', () => {
    expect(classifyProbe({ ok: false, body: { app: 'orbital' } })).toEqual({ kind: 'other' });
  });

  it('treats an unparseable body as another service', () => {
    expect(classifyProbe({ ok: true, body: null })).toEqual({ kind: 'other' });
    expect(classifyProbe({ ok: true, body: '<html>hello</html>' })).toEqual({ kind: 'other' });
  });
});

describe('decideStartup', () => {
  it('attaches to an orbital that is already listening', () => {
    expect(decideStartup({ kind: 'orbital', health: { app: 'orbital' } })).toBe('attach');
  });

  it('forks when nothing is listening', () => {
    expect(decideStartup({ kind: 'refused' })).toBe('fork');
  });

  it('never forks onto a foreign service', () => {
    expect(decideStartup({ kind: 'other' })).toBe('occupied');
  });
});

describe('needsCliPrompt', () => {
  const missing = { claudeCli: { source: 'missing', path: null, version: null } };
  const found = { claudeCli: { source: 'path', path: '/usr/local/bin/claude', version: '2.1.272' } };

  it('prompts when we forked the server and the CLI is missing', () => {
    expect(needsCliPrompt(missing, true)).toBe(true);
  });

  it('stays quiet when we attached — that server is the user’s own', () => {
    expect(needsCliPrompt(missing, false)).toBe(false);
  });

  it('stays quiet when the CLI was found', () => {
    expect(needsCliPrompt(found, true)).toBe(false);
  });

  it('stays quiet when health says nothing about the CLI', () => {
    expect(needsCliPrompt({}, true)).toBe(false);
  });
});

describe('classifyChildExit', () => {
  const state = { quitting: false, current: true, awaitingStart: false };

  it('offers a restart when the server dies under a running app', () => {
    expect(classifyChildExit(state)).toBe('offer-restart');
  });

  it('aborts the start instead of offering a restart when nobody is watching yet', () => {
    // The waiting code owns this failure; a second dialog would stack on it.
    expect(classifyChildExit({ ...state, awaitingStart: true })).toBe('abort-start');
  });

  it('ignores the death of a child we already replaced', () => {
    expect(classifyChildExit({ ...state, current: false })).toBe('ignore');
    expect(classifyChildExit({ ...state, current: false, awaitingStart: true })).toBe('ignore');
  });

  it('ignores every death once we are quitting', () => {
    expect(classifyChildExit({ ...state, quitting: true })).toBe('ignore');
    expect(classifyChildExit({ quitting: true, current: true, awaitingStart: true })).toBe('ignore');
  });
});

describe('decideNavigation', () => {
  it('lets the window navigate within Orbital’s own origin', () => {
    expect(decideNavigation('http://127.0.0.1:4737/', 4737)).toBe('allow');
    expect(decideNavigation('http://127.0.0.1:4737/sandbox', 4737)).toBe('allow');
    // Both windowUrl answers are ours, whichever mode this process is in.
    expect(decideNavigation('http://127.0.0.1:5173/', 4737)).toBe('allow');
  });

  it('sends a link in a transcript to the browser instead of replacing the map', () => {
    expect(decideNavigation('https://example.com/docs', 4737)).toBe('external');
    expect(decideNavigation('http://example.com', 4737)).toBe('external');
  });

  it('treats another service on loopback as external, not as us', () => {
    // Same host, different port: the preload must not follow it.
    expect(decideNavigation('http://127.0.0.1:9999/', 4737)).toBe('external');
    expect(decideNavigation('http://localhost:4737/', 4737)).toBe('external');
  });

  it('follows the configured port rather than a hard-coded one', () => {
    expect(decideNavigation('http://127.0.0.1:4791/', 4791)).toBe('allow');
    expect(decideNavigation('http://127.0.0.1:4737/', 4791)).toBe('external');
  });

  it('swallows anything that is not http(s) rather than handing it to the OS', () => {
    // shell.openExternal launches a handler application for these.
    expect(decideNavigation('file:///etc/passwd', 4737)).toBe('deny');
    expect(decideNavigation('javascript:alert(1)', 4737)).toBe('deny');
    expect(decideNavigation('not a url', 4737)).toBe('deny');
  });
});

describe('windowUrl', () => {
  it('points at vite in development', () => {
    expect(windowUrl(true, 4737)).toBe('http://127.0.0.1:5173');
  });

  it('points at the server itself otherwise', () => {
    expect(windowUrl(false, 4737)).toBe('http://127.0.0.1:4737');
    expect(windowUrl(false, 4791)).toBe('http://127.0.0.1:4791');
  });
});
