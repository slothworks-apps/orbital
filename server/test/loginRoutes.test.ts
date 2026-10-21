import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { join } from 'node:path';
import { buildServer } from '../src/index.js';
import { SESSION_STARTER_NAME, registerLoginRoutes } from '../src/api/logins.js';
import { Hub } from '../src/api/hub.js';
import { createImageStore } from '../src/images/store.js';
import { PROFILE_LOGINS_TOPIC } from '@orbital/shared/profileLogins';
import { LoginService, type LoginChild } from '../src/login/service.js';
import { SILENT_BROWSER } from '../src/login/parse.js';
import { CONTROL_HEADER, DEVICE_HEADER, remoteInjectOptions } from '../src/remote/inject.js';
import { ALLOWED_ROUTES, allowedPath } from '../src/remote/allowlist.js';
import { LOGINS_GRANT, ServingHalf, memberMayWatch } from '../src/remote/servingHalf.js';
import { makeTmpDir } from './tmp.js';

/**
 * The login routes (spec 2026-10-21-log-in-from-orbital-design § 2, § 6):
 * their answers and errors against a fake `claude`, the token in front of
 * them, and their place on the device group's allowlist.
 */

const silentChild = (env: Record<string, string>, envs: Record<string, string>[]): LoginChild => {
  envs.push(env);
  return { onStdout() {}, onStderr() {}, onExit() {}, write() {}, closeStdin() {}, kill() {} };
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const CONTROL_KEY = 'control-key-of-this-start';

async function routes(cliPath: string | null = '/bin/claude') {
  const envs: Record<string, string>[] = [];
  const logins = new LoginService({
    cliPath,
    dirPath: (id) => (id === 1 ? '/Users/someone/.claude' : undefined),
    publish: () => {},
    publishToSession: () => {},
    republish: () => {},
    sessions: { title: () => '', isEnded: () => false, isLimitWaiting: () => false },
    continueText: () => 'go on',
    autoContinue: () => true,
    home: '/Users/someone',
    baseEnv: { PATH: '/usr/bin' },
    spawn: (_file, _args, opts) => silentChild(opts.env, envs),
    runStatus: async () => ({ stdout: '{"loggedIn":false}' }),
  });
  app = Fastify();
  registerLoginRoutes(app, logins, { selfName: () => 'Studio', nameOf: (id) => (id === 'dev-pixel' ? 'Pixel 8' : null) }, CONTROL_KEY);
  await app.ready();
  return { app, envs };
}

describe('the login routes', () => {
  it('start a login and answer the profile\'s state; a member\'s start is manual only, under its name', async () => {
    const { app, envs } = await routes();
    const local = await app.inject({ method: 'POST', url: '/api/claude-dirs/1/login', payload: { kind: 'design' } });
    expect(local.statusCode).toBe(200);
    expect(local.json().runs.design).toMatchObject({ state: 'running', manualOnly: false, startedBy: { deviceId: null, name: 'Studio' } });

    const remote = await app.inject({
      method: 'POST', url: '/api/claude-dirs/1/login', payload: { kind: 'claude' }, headers: { [DEVICE_HEADER]: 'dev-pixel' },
    });
    expect(remote.json().runs.claude).toMatchObject({ manualOnly: true, step: 'code', startedBy: { deviceId: 'dev-pixel', name: 'Pixel 8' } });
    expect(envs.map((e) => e.BROWSER)).toEqual([undefined, SILENT_BROWSER]);

    const state = await app.inject({ method: 'GET', url: '/api/claude-dirs/1/login' });
    expect(state.json()).toMatchObject({ claudeDirId: 1, cliAvailable: true, account: { read: true, loggedIn: false } });
  });

  it('start a session\'s login, one carrying the control key, with BROWSER silenced; a wrong key is this Mac\'s web', async () => {
    const { app, envs } = await routes();
    const forged = await app.inject({
      method: 'POST', url: '/api/claude-dirs/1/login', payload: { kind: 'design' }, headers: { [CONTROL_HEADER]: 'guessed' },
    });
    expect(forged.json().runs.design).toMatchObject({ manualOnly: false, startedBy: { deviceId: null, name: 'Studio' } });

    const session = await app.inject(remoteInjectOptions(
      { method: 'POST', url: '/api/claude-dirs/1/login', payload: { kind: 'claude' }, control: CONTROL_KEY }, undefined,
    ));
    expect(session.json().runs.claude).toMatchObject({
      manualOnly: true, step: 'code', startedBy: { deviceId: null, name: SESSION_STARTER_NAME },
    });
    expect(envs.map((e) => e.BROWSER)).toEqual([undefined, SILENT_BROWSER]);
  });

  it('answer 404 for an unknown profile', async () => {
    const { app } = await routes();
    expect((await app.inject({ method: 'GET', url: '/api/claude-dirs/9/login' })).json()).toEqual({ error: 'not_found' });
    expect((await app.inject({ method: 'POST', url: '/api/claude-dirs/9/login', payload: { kind: 'claude' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/claude-dirs/abc/login/code', payload: { kind: 'claude', code: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/claude-dirs/9/login/claude' })).statusCode).toBe(404);
  });

  it('answer 409 for a code or a cancel with no login running', async () => {
    const { app } = await routes();
    const code = await app.inject({ method: 'POST', url: '/api/claude-dirs/1/login/code', payload: { kind: 'claude', code: 'abc#s' } });
    expect(code.statusCode).toBe(409);
    expect(code.json()).toEqual({ error: 'no_login' });
    expect((await app.inject({ method: 'DELETE', url: '/api/claude-dirs/1/login/design' })).statusCode).toBe(409);
  });

  it('answer 400 for an unknown kind or a code that cannot be one', async () => {
    const { app } = await routes();
    expect((await app.inject({ method: 'POST', url: '/api/claude-dirs/1/login', payload: { kind: 'console' } })).json()).toEqual({ error: 'bad_kind' });
    expect((await app.inject({ method: 'DELETE', url: '/api/claude-dirs/1/login/console' })).statusCode).toBe(400);
    const code = await app.inject({ method: 'POST', url: '/api/claude-dirs/1/login/code', payload: { kind: 'claude', code: 'a\nb' } });
    expect(code.json()).toEqual({ error: 'bad_code' });
  });

  it('answer 503 for a start with no Claude executable, and say so in the state', async () => {
    const { app } = await routes(null);
    expect((await app.inject({ method: 'POST', url: '/api/claude-dirs/1/login', payload: { kind: 'claude' } })).json()).toEqual({ error: 'no_cli' });
    expect((await app.inject({ method: 'GET', url: '/api/claude-dirs/1/login' })).json().cliAvailable).toBe(false);
  });

  it('are behind the API token', async () => {
    const dir = makeTmpDir('login-routes');
    app = await buildServer({ dbPath: join(dir, 'index.db'), claudeDir: dir, dataDir: dir, apiToken: 'test-token-0123456789' });
    for (const [method, url] of [
      ['GET', '/api/claude-dirs/1/login'], ['POST', '/api/claude-dirs/1/login'],
      ['POST', '/api/claude-dirs/1/login/code'], ['DELETE', '/api/claude-dirs/1/login/claude'],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(401);
    }
  });
});

describe('the login routes for another device', () => {
  const LOGIN_ROUTES = ALLOWED_ROUTES.filter(([, path]) => path.startsWith('/api/claude-dirs/:id/login'));

  it('are all on the allowlist, in the manage group only', () => {
    expect(LOGIN_ROUTES.map(([m, p]) => `${m} ${p}`).sort()).toEqual([
      'DELETE /api/claude-dirs/:id/login/:kind',
      'GET /api/claude-dirs/:id/login',
      'POST /api/claude-dirs/:id/login',
      'POST /api/claude-dirs/:id/login/code',
    ]);
    expect(new Set(LOGIN_ROUTES.map(([, , group]) => group))).toEqual(new Set(['manage']));
    expect(allowedPath('POST', '/api/claude-dirs/2/login/code')?.group).toBe('manage');
    expect(allowedPath('DELETE', '/api/claude-dirs/2/login/design')?.group).toBe('manage');
  });

  it('their topic may be watched by a member holding the manage grant, and by no other', async () => {
    expect(memberMayWatch(PROFILE_LOGINS_TOPIC)).toBe(true);
    const hub = new Hub();
    const dir = makeTmpDir('login-topic');
    let raw = '';
    const out: any[] = [];
    const serving = new ServingHalf({
      deviceId: 'm1', hub, images: createImageStore(dir), imagesDir: dir,
      inject: async () => ({ statusCode: 200, body: '{}' }),
      files: () => ({ status: 404 }), notifications: { get: () => ({}) as never, set: () => {} }, onSeen: () => {},
      getGrants: () => raw,
    });
    serving.open({ json: (msg) => { out.push(msg); }, inner: () => {} });
    const frames = () => out.filter((m) => m.t === 'ws' && m.frame.topic === PROFILE_LOGINS_TOPIC);

    // `manage` is off by default.
    serving.ask({ t: 'ws', type: 'subscribe', topic: PROFILE_LOGINS_TOPIC } as never);
    hub.publish(PROFILE_LOGINS_TOPIC, { event: 'login', login: {} });
    expect(frames()).toHaveLength(0);

    raw = JSON.stringify({ m1: { [LOGINS_GRANT]: true } });
    serving.ask({ t: 'ws', type: 'subscribe', topic: PROFILE_LOGINS_TOPIC } as never);
    hub.publish(PROFILE_LOGINS_TOPIC, { event: 'login', login: {} });
    expect(frames()).toHaveLength(1);

    // Taken back while the subscription stands: the next frame stays here.
    raw = '';
    hub.publish(PROFILE_LOGINS_TOPIC, { event: 'login', login: {} });
    expect(frames()).toHaveLength(1);
    serving.reset();
  });
});
