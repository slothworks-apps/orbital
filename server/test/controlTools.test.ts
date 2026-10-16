import { describe, it, expect } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildServer } from '../src/index.js';
import { CONTROL_OPERATIONS, type ControlOperation } from '../src/control/catalog.js';
import { controlRequest, controlTools, onMachine } from '../src/runner/controlTools.js';
import { remoteInjectOptions } from '../src/remote/inject.js';
import { makeTmpDir } from './tmp.js';

const CATALOG: ControlOperation[] = [
  { name: 'get_session', area: 'sessions', method: 'GET', path: '/api/sessions/:id', does: '' },
  { name: 'list_messages', area: 'sessions', method: 'GET', path: '/api/sessions/:id/messages', does: '' },
  { name: 'end_session', area: 'sessions', method: 'POST', path: '/api/sessions/:id/end', does: '', notOnCaller: true },
  { name: 'toggle_mcp', area: 'mcp', method: 'POST', path: '/api/sessions/:id/mcp/:name/enabled', does: '' },
  { name: 'update_settings', area: 'settings', method: 'PATCH', path: '/api/settings', does: '', deniedKeys: (k) => k.startsWith('remote_') },
  { name: 'delete_tag', area: 'tags', method: 'DELETE', path: '/api/tags/:id', does: '' },
];

const req = (name: string, params: Record<string, unknown> | undefined, kind: 'read' | 'act' = 'read') =>
  controlRequest('caller', name, params, kind, CATALOG);

describe('controlRequest', () => {
  it('fills path params by name and sends the rest as the query of a read', () => {
    expect(req('list_messages', { id: 'abc', before: 'x y', limit: 20 }))
      .toEqual({ ok: true, method: 'GET', url: '/api/sessions/abc/messages?before=x+y&limit=20' });
  });

  it('sends the rest as the body of an act, and encodes a path param that is not a plain word', () => {
    expect(req('toggle_mcp', { id: 's1', name: 'claude.ai Gmail', enabled: false }, 'act'))
      .toEqual({ ok: true, method: 'POST', url: '/api/sessions/s1/mcp/claude.ai%20Gmail/enabled', payload: { enabled: false } });
  });

  it('cannot climb out of its route through a path param', () => {
    expect(req('get_session', { id: '..' }).ok).toBe(false);
    expect(req('get_session', { id: '../tags' })).toEqual({ ok: true, method: 'GET', url: '/api/sessions/..%2Ftags' });
  });

  it('refuses a missing path param and an unknown operation', () => {
    expect(req('get_session', {})).toEqual({ ok: false, error: 'get_session needs id' });
    expect(req('nope', {}).ok).toBe(false);
  });

  it('keeps reads and acts on their own tools', () => {
    expect(req('end_session', { id: 's1' }, 'read').ok).toBe(false);
    expect(req('get_session', { id: 's1' }, 'act').ok).toBe(false);
    expect(req('delete_tag', { id: 3 }, 'act')).toEqual({ ok: true, method: 'DELETE', url: '/api/tags/3' });
  });

  it('refuses a body key the operation keeps for the user', () => {
    expect(req('update_settings', { map_theme: 'desk', remote_relay_secret: 'x' }, 'act').ok).toBe(false);
    expect(req('update_settings', { map_theme: 'desk' }, 'act').ok).toBe(true);
  });

  it('will not stop the calling session, but will stop another', () => {
    expect(req('end_session', { id: 'caller' }, 'act').ok).toBe(false);
    expect(req('end_session', { id: 'other' }, 'act').ok).toBe(true);
  });
});

async function withServer(run: (app: Awaited<ReturnType<typeof buildServer>>) => Promise<void>) {
  const claudeDir = makeTmpDir('control');
  mkdirSync(join(claudeDir, 'projects'), { recursive: true });
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
  const app = await buildServer({ claudeDir, dbPath: join(claudeDir, 'index.db'), queryFn: (() => {}) as any, apiToken: 't0ken' });
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

describe('the control tools against the server', () => {
  it('act changes Orbital and read sees it; a refused call reaches no route', async () => {
    await withServer(async (app) => {
      const calls: string[] = [];
      const tools = controlTools('caller', async (r) => {
        calls.push(`${r.method} ${r.url}`);
        const res = await app.inject(remoteInjectOptions(r, 't0ken'));
        return { statusCode: res.statusCode, body: res.body };
      });
      const [, read, act] = tools.map((t) => (args: any) => t.handler(args, undefined));
      const made = await act({ operation: 'create_tag', params: { name: 'ops', hue: 120 } });
      expect(made.isError).toBeUndefined();
      const listed = await read({ operation: 'list_tags' });
      expect(JSON.parse((listed.content[0] as any).text).tags.map((t: any) => t.name)).toContain('ops');
      const refused = await act({ operation: 'end_session', params: { id: 'caller' } });
      expect(refused.isError).toBe(true);
      const missing = await act({ operation: 'end_session', params: { id: 'nobody' } });
      expect((missing.content[0] as any).text).toMatch(/^HTTP 404/);
      expect(calls).toEqual(['POST /api/tags', 'GET /api/tags', 'POST /api/sessions/nobody/end']);
    });
  });
});

describe('the operation catalog', () => {
  it('names every operation once', () => {
    const names = CONTROL_OPERATIONS.map((o) => o.name);
    expect(new Set(names).size).toBe(names.length);
  });

  /** A renamed or removed route would otherwise leave an operation that only ever answers 404. */
  it('points every operation at a route the server registers', async () => {
    await withServer(async (app) => {
      const missing = CONTROL_OPERATIONS.filter((o) => !app.hasRoute({ method: o.method, url: o.path }));
      expect(missing.map((o) => `${o.method} ${o.path}`)).toEqual([]);
    });
  });
});

describe('an operation on another Mac', () => {
  it('names the Mac in the query of a read and in the body of an act', () => {
    expect(onMachine({ ok: true, method: 'GET', url: '/api/projects' }, 'M')).toEqual({ ok: true, method: 'GET', url: '/api/projects?machine=M' });
    expect(onMachine({ ok: true, method: 'GET', url: '/api/files?path=a' }, 'M')).toMatchObject({ url: '/api/files?path=a&machine=M' });
    expect(onMachine({ ok: true, method: 'POST', url: '/api/sessions', payload: { cwd: '/p' } }, 'M'))
      .toEqual({ ok: true, method: 'POST', url: '/api/sessions', payload: { cwd: '/p', machine: 'M' } });
  });

  it('leaves this Mac\'s operations and refusals alone', () => {
    const req = { ok: true as const, method: 'GET', url: '/api/tags' };
    expect(onMachine(req, undefined)).toBe(req);
    const refused = { ok: false as const, error: 'unknown operation' };
    expect(onMachine(refused, 'M')).toBe(refused);
  });
});
