import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { startMacAndRelay, until, type MacAndRelay } from './remoteHarness.js';

/** A local window on a server's hub: every frame it got on `topic`. */
function watch(s: MacAndRelay, topic: string): () => any[] {
  const socket = Object.assign(new EventEmitter(), { send: vi.fn() });
  s.hub.handleSocket(socket);
  socket.emit('message', JSON.stringify({ type: 'subscribe', topic }));
  return () => socket.send.mock.calls.map(([data]) => JSON.parse(data as string)).filter((f) => f.topic === topic);
}

describe('settings the group shares, between two servers', () => {
  const closers: (() => unknown)[] = [];
  afterEach(async () => {
    for (const c of closers.splice(0).reverse()) await c();
  });

  it('a joining Mac takes the group\'s values, even ones it changed later, and a change on either reaches the other', async () => {
    const a = await startMacAndRelay(closers, { name: 'studio' });
    const b = await startMacAndRelay(closers, { relayUrl: a.relayUrl, name: 'laptop' });
    const read = async (s: MacAndRelay) => (await s.api('GET', '/api/settings')).json() as Record<string, string>;

    await a.api('PATCH', '/api/settings', { default_model: 'opus' });
    // Changed on the laptop after the studio's change, before it joins: the group's values still win.
    await b.api('PATCH', '/api/settings', { default_model: 'haiku', map_state_pills: 'label', sidebar_width: '420' });
    // A tag of the same name on both, and one only the laptop has.
    await a.api('POST', '/api/tags', { name: 'work', hue: 10 });
    await b.api('POST', '/api/tags', { name: 'work', hue: 200 });
    await b.api('POST', '/api/tags', { name: 'laptop-only', hue: 40 });
    const windowOnB = watch(b, 'settings');

    const qr = (await a.api('POST', '/api/remote/pair')).json().qr;
    const joined = await b.api('POST', '/api/remote/join', { code: qr });
    expect(joined.statusCode).toBe(200);
    const idB = (await b.api('GET', '/api/remote')).json().macId as string;
    await until(async () => (await a.api('GET', '/api/remote')).json().pendingPair !== null);
    await a.api('POST', '/api/remote/pair/confirm', { accept: true, phone: idB, code: joined.json().code });

    await until(async () => (await read(b)).default_model === 'opus', 10_000);
    await until(async () => (await read(b)).map_state_pills === 'dot');
    // Per device: the laptop's own layout stays.
    expect((await read(b)).sidebar_width).toBe('420');
    expect((await read(a)).sidebar_width).toBe('300');
    // The laptop's windows were told what changed under them.
    expect(windowOnB().flatMap((f) => Object.keys(f.settings ?? {}))).toEqual(expect.arrayContaining(['default_model', 'map_state_pills']));

    // A change on either side reaches the other.
    await b.api('PATCH', '/api/settings', { confirm_before_clear: 'false' });
    await until(async () => (await read(a)).confirm_before_clear === 'false', 10_000);
    await a.api('PATCH', '/api/settings', { map_theme: 'desk' });
    await until(async () => (await read(b)).map_theme === 'desk', 10_000);

    // Tags: the group's "work" wins on the joining laptop, its own tag reaches the studio, and a rename travels.
    type ListedTag = { id: number; name: string; hue: number; uuid: string };
    const tagsOf = async (s: MacAndRelay) => (await s.api('GET', '/api/tags')).json().tags as ListedTag[];
    await until(async () => (await tagsOf(a)).some((t) => t.name === 'laptop-only'), 10_000);
    expect((await tagsOf(b)).find((t) => t.name === 'work')?.hue).toBe(10);
    const laptopOnly = (await tagsOf(b)).find((t) => t.name === 'laptop-only')!;
    expect((await tagsOf(a)).find((t) => t.name === 'laptop-only')?.uuid).toBe(laptopOnly.uuid);
    await b.api('PATCH', `/api/tags/${laptopOnly.id}`, { name: 'travel' });
    await until(async () => (await tagsOf(a)).some((t) => t.name === 'travel'), 10_000);
    expect(windowOnB().some((f) => f.event === 'tags')).toBe(true);
  }, 30_000);
});
