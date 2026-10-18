import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AS_OF_HEADER } from '../src/federation/routes.js';
import { DEVICE_HEADER } from '../src/remote/inject.js';
import { RETENTION_KEY, RETENTION_NEVER } from '../src/retention.js';
import { FakePhone } from './remoteFakePhone.js';
import { pairingCode, startMacAndRelay, until, type MacAndRelay } from './remoteHarness.js';

const SESSION_ID = 's-federated';

/** A local window on a server's hub: every frame it got on `topic`. */
function watch(s: MacAndRelay, topic: string): () => any[] {
  const socket = Object.assign(new EventEmitter(), { send: vi.fn() });
  s.hub.handleSocket(socket);
  socket.emit('message', JSON.stringify({ type: 'subscribe', topic }));
  return () => socket.send.mock.calls.map(([data]) => JSON.parse(data as string)).filter((f) => f.topic === topic);
}

/** One multipart upload of `bytes` named `name`, as the composer sends it. */
function multipart(name: string, type: string, bytes: Buffer) {
  const boundary = '----orbitaltestboundary';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`),
      bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

describe('federation: linked servers', () => {
  const closers: (() => unknown)[] = [];
  afterEach(async () => {
    for (const c of closers.splice(0).reverse()) await c();
  });

  /** A FakePhone paired with `mac` through its code, said hello. */
  async function pairPhone(mac: MacAndRelay, macId: string): Promise<FakePhone> {
    const pair = await mac.api('POST', '/api/remote/pair');
    const phone = new FakePhone();
    closers.push(() => phone.close());
    await phone.connect(pair.json().qr);
    expect((await phone.redeem()).status).toBe(200);
    await until(async () => (await mac.api('GET', '/api/remote')).json().pendingPair !== null);
    const confirm = mac.api('POST', '/api/remote/pair/confirm', { accept: true, phone: phone.id, code: pairingCode(macId, phone.identity.publicKey) });
    expect(await phone.nextControl('paired')).toMatchObject({ type: 'paired' });
    await phone.handshake();
    expect((await confirm).statusCode).toBe(200);
    await phone.hello();
    return phone;
  }

  it('A shows B\'s session marked with B\'s machine, keeps it offline when B goes, and passes none of it to its phone', async () => {
    const a = await startMacAndRelay(closers, { name: 'studio' });
    const b = await startMacAndRelay(closers, {
      relayUrl: a.relayUrl, name: 'laptop',
      // The fixture's timestamps are old; a retention sweep must not take the session.
      settings: [[RETENTION_KEY, RETENTION_NEVER]],
      beforeBoot: (d) => {
        mkdirSync(join(d, 'claude', 'projects', 'p'), { recursive: true });
        copyFileSync(join(import.meta.dirname, 'fixtures/transcript-basic.jsonl'), join(d, 'claude', 'projects', 'p', `${SESSION_ID}.jsonl`));
      },
    });
    await until(async () => (await b.api('GET', '/api/sessions')).json().sessions.some((s: any) => s.id === SESSION_ID));
    const idA = (await a.api('GET', '/api/remote')).json().macId as string;
    const idB = (await b.api('GET', '/api/remote')).json().macId as string;

    // A phone on A, watching A's sessions before B joins.
    const phone = await pairPhone(a, idA);
    phone.send({ t: 'ws', type: 'subscribe', topic: 'sessions' });
    phone.send({ t: 'http', id: 1, method: 'GET', path: '/api/health' });
    await phone.next('http_res', (m) => m.id === 1);

    const qr = (await a.api('POST', '/api/remote/pair')).json().qr;
    const join_ = await b.api('POST', '/api/remote/join', { code: qr });
    expect(join_.statusCode).toBe(200);
    await until(async () => (await a.api('GET', '/api/remote')).json().pendingPair !== null);
    await a.api('POST', '/api/remote/pair/confirm', { accept: true, phone: idB, code: join_.json().code });

    const federated = () => a.federation.sessions().find((s) => s.id === SESSION_ID) as { machine?: any } | undefined;
    await until(() => federated()?.machine?.online === true, 10_000);
    expect(federated()!.machine).toEqual({ id: idB, name: 'laptop', kind: 'desktop', os: expect.any(String), online: true, asOf: null });
    expect(a.federation.linkOf(SESSION_ID)?.id).toBe(idB);
    // B takes in nothing of A's: A has no sessions, and B's own are not federated back to it.
    expect(b.federation.sessions()).toEqual([]);

    // B's messages read on A while B is up: B's answer, as it gave it.
    const messagesUrl = `/api/sessions/${SESSION_ID}/messages`;
    const live = await a.api('GET', messagesUrl);
    expect(live.statusCode).toBe(200);
    expect(live.headers[AS_OF_HEADER]).toBeUndefined();
    expect(live.json()).toEqual((await b.api('GET', messagesUrl)).json());

    // B goes off the relay: A keeps its session, offline as of when it last heard.
    b.remote.stop();
    await until(() => federated()?.machine?.online === false, 10_000);
    expect(federated()!.machine.asOf).toEqual(expect.any(Number));

    // B's messages stay readable on A, marked as a copy; what A never read is not there.
    const copy = await a.api('GET', messagesUrl);
    expect(copy.statusCode).toBe(200);
    expect(Number(copy.headers[AS_OF_HEADER])).toBeGreaterThan(0);
    expect(copy.json()).toEqual(live.json());
    expect((await a.api('GET', `/api/sessions/${SESSION_ID}/media`)).statusCode).toBe(409);

    // Everything A published about B's session is in the phone's queue before this answer.
    phone.send({ t: 'http', id: 2, method: 'GET', path: '/api/health' });
    await phone.next('http_res', (m) => m.id === 2);
    const aboutB = phone.messages.filter((m: any) => m.t === 'ws' && m.frame?.topic === 'sessions'
      && (m.frame.session?.id === SESSION_ID || m.frame.sessionId === SESSION_ID));
    expect(aboutB).toEqual([]);

    // A restarts while B is still away: B's session is still listed, offline as of the same moment.
    const asOf = federated()!.machine.asOf as number;
    await a.app.close();
    const again = await startMacAndRelay(closers, { relayUrl: a.relayUrl, name: 'studio', dir: a.dir });
    const kept = again.federation.sessions().find((s) => s.id === SESSION_ID) as { machine?: any } | undefined;
    expect(kept?.machine).toEqual({ id: idB, name: 'laptop', kind: 'desktop', os: expect.any(String), online: false, asOf });
  }, 30_000);

  /** A session started here answers its first turn at once: no Claude CLI. */
  function fakeQueryFn() {
    return (({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
      const sid = options?.sessionId ?? options?.resume;
      async function* gen() {
        for await (const _turn of prompt) {
          yield { type: 'system', subtype: 'init', session_id: sid };
          yield { type: 'result', subtype: 'success', session_id: sid, usage: {} };
        }
      }
      return gen();
    }) as any;
  }

  /** A and B by a ceremony, C joined through B; B holds an indexed session. */
  async function threeLinked() {
    const a = await startMacAndRelay(closers, { name: 'studio' });
    const b = await startMacAndRelay(closers, {
      relayUrl: a.relayUrl, name: 'laptop', queryFn: fakeQueryFn(),
      settings: [[RETENTION_KEY, RETENTION_NEVER]],
      beforeBoot: (d) => {
        mkdirSync(join(d, 'claude', 'projects', 'p'), { recursive: true });
        copyFileSync(join(import.meta.dirname, 'fixtures/transcript-basic.jsonl'), join(d, 'claude', 'projects', 'p', `${SESSION_ID}.jsonl`));
      },
    });
    const c = await startMacAndRelay(closers, { relayUrl: a.relayUrl, name: 'vps', queryFn: fakeQueryFn() });
    await until(async () => (await b.api('GET', '/api/sessions')).json().sessions.some((s: any) => s.id === SESSION_ID));
    const [idA, idB, idC] = await Promise.all([a, b, c].map(async (s) => (await s.api('GET', '/api/remote')).json().macId as string));
    const join1 = await b.api('POST', '/api/remote/join', { code: (await a.api('POST', '/api/remote/pair')).json().qr });
    await until(async () => (await a.api('GET', '/api/remote')).json().pendingPair !== null);
    await a.api('POST', '/api/remote/pair/confirm', { accept: true, phone: idB, code: join1.json().code });
    await until(() => a.remote.channel(idB)?.ready === true && b.remote.channel(idA)?.ready === true, 10_000);
    // C joins through A, the group's primary, and links with B by itself.
    const join2 = await c.api('POST', '/api/remote/join', { code: (await a.api('POST', '/api/remote/pair')).json().qr });
    await until(async () => (await a.api('GET', '/api/remote')).json().pendingPair !== null);
    await a.api('POST', '/api/remote/pair/confirm', { accept: true, phone: idC, code: join2.json().code });
    await until(() => a.remote.channel(idC)?.ready === true && c.remote.channel(idA)?.ready === true
      && b.remote.channel(idC)?.ready === true, 15_000);
    // B's session reaches A and C through their own channels to B.
    await until(() => [a, c].every((s) => s.federation.linkOf(SESSION_ID)?.id === idB), 10_000);
    return { a, b, c, idA, idB, idC };
  }

  const listed = async (s: MacAndRelay, headers?: Record<string, string>) =>
    (await s.app.inject({ method: 'GET', url: '/api/sessions', headers })).json().sessions as any[];

  it('a request for another member\'s session or naming a member is answered by that member', async () => {
    const { a, b, c, idA, idB, idC } = await threeLinked();

    // The list carries every member's sessions, marked with their machine; B lists its own once.
    for (const s of [a, c]) {
      const mine = (await listed(s)).filter((x) => x.id === SESSION_ID);
      expect(mine).toEqual([expect.objectContaining({ machine: expect.objectContaining({ id: idB, online: true }) })]);
    }
    const onB = (await listed(b)).filter((x) => x.id === SESSION_ID);
    expect(onB).toHaveLength(1);
    expect(onB[0].machine).toBeUndefined();
    // A list asked over a channel carries only the device's own: no chaining.
    expect((await listed(a, { [DEVICE_HEADER]: idC })).some((x) => x.id === SESSION_ID)).toBe(false);

    // A session route for B's session is B's answer, never A's local 404.
    const messages = await a.api('GET', `/api/sessions/${SESSION_ID}/messages`);
    expect(messages.statusCode).toBe(200);
    expect(messages.json()).toEqual((await b.api('GET', `/api/sessions/${SESSION_ID}/messages`)).json());
    const one = await a.api('GET', `/api/sessions/${SESSION_ID}`);
    expect(one.statusCode).toBe(200);
    expect(one.json().session.machine).toMatchObject({ id: idB });
    // Asked over a channel, A does not forward it: its own route answers.
    const notForwarded = await a.app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}`, headers: { [DEVICE_HEADER]: idC } });
    expect(notForwarded.statusCode).toBe(404);

    // A spawn naming C starts on C, under C's own tag of the same name.
    await a.api('POST', '/api/tags', { name: 'green', hue: 0 });
    const ops = (await a.api('POST', '/api/tags', { name: 'ops', hue: 0 })).json().id as number;
    const minted = randomUUID();
    // The windows subscribe before the spawn, as the browser does with the id it minted.
    const onAFrames = watch(a, `session:${minted}`);
    const onCFrames = watch(c, `session:${minted}`);
    const spawn = await a.api('POST', '/api/sessions', {
      machine: idC, sessionId: minted, cwd: c.dir, prompt: 'go', permissionMode: 'acceptEdits', tagId: ops,
    });
    expect([spawn.statusCode, spawn.json()]).toEqual([201, { sessionId: minted }]);
    // The spawn's first frames on C reach A's window too, none lost before C's list named the session.
    await until(() => onCFrames().length > 0 && onAFrames().length >= onCFrames().length, 10_000);
    expect(onAFrames()[0]).toEqual(onCFrames()[0]);
    // A spawn C refuses leaves nothing expected of it.
    const refused = 'not-a-minted-id';
    expect((await a.api('POST', '/api/sessions', { machine: idC, sessionId: refused, cwd: c.dir, prompt: 'go', permissionMode: 'acceptEdits' })).statusCode)
      .toBe(400);
    expect(a.federation.linkOf(refused)).toBeNull();
    const onC = await c.api('GET', `/api/sessions/${minted}`);
    expect(onC.statusCode).toBe(200);
    const opsC = ((await c.api('GET', '/api/tags')).json().tags as { id: number; name: string }[]).find((t) => t.name === 'ops')!;
    expect(opsC.id).not.toBe(ops);
    expect(onC.json().session.tagIds).toEqual([opsC.id]);
    expect((await a.app.inject({ method: 'GET', url: `/api/sessions/${minted}`, headers: { [DEVICE_HEADER]: idC } })).statusCode).toBe(404);

    // A request over a channel that names another device is refused, never answered here or passed on.
    const misrouted = await a.app.inject({
      method: 'POST', url: '/api/sessions', headers: { [DEVICE_HEADER]: idC },
      payload: { machine: idB, sessionId: randomUUID(), cwd: a.dir, prompt: 'go', permissionMode: 'acceptEdits' },
    });
    expect([misrouted.statusCode, misrouted.json()]).toEqual([400, { error: 'not_forwarded' }]);
    expect((await a.app.inject({ method: 'GET', url: `/api/dirs?machine=${idB}`, headers: { [DEVICE_HEADER]: idC } })).statusCode).toBe(400);

    // The harness start view of B's session offers B's templates, not A's.
    const steps = [{ id: 'one', title: 'One', instructions: 'Do it.', mode: 'auto', doneWhen: 'done' }];
    expect((await b.api('POST', '/api/harness/templates', { name: 'on-b', tags: [], inputs: [], steps })).statusCode).toBe(201);
    expect((await a.api('POST', '/api/harness/templates', { name: 'on-a', tags: [], inputs: [], steps })).statusCode).toBe(201);
    const offered = await a.api('GET', `/api/harness/templates?sessionId=${SESSION_ID}`);
    expect(offered.statusCode).toBe(200);
    expect((offered.json().templates as { name: string }[]).map((t) => t.name)).toEqual(['on-b']);

    // This device by name is the local route; a device nobody knows is 404.
    const self = await a.api('GET', `/api/sessions/count?machine=${idA}`);
    expect([self.statusCode, self.json()]).toEqual([200, { total: 0 }]);
    const unknown = await a.api('GET', '/api/projects?machine=nobody');
    expect([unknown.statusCode, unknown.json()]).toEqual([404, { error: 'unknown_device' }]);

    // A's tags land on B by name: B's own "red", made there.
    await a.api('POST', '/api/tags', { name: 'blue', hue: 200 });
    const red = (await a.api('POST', '/api/tags', { name: 'red', hue: 0 })).json().id as number;
    expect((await a.api('PUT', `/api/sessions/${SESSION_ID}/tags`, { tagIds: [red] })).statusCode).toBe(200);
    const tagsB = (await b.api('GET', '/api/tags')).json().tags as { id: number; name: string }[];
    const redB = tagsB.find((t) => t.name === 'red')!;
    expect(tagsB.filter((t) => t.name === 'red')).toHaveLength(1);
    expect(redB.id).not.toBe(red);
    expect((await b.api('GET', `/api/sessions/${SESSION_ID}`)).json().session.tagIds).toEqual([redB.id]);

    // An image only B holds is served by A.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const ref = `${createHash('sha256').update(png).digest('hex')}.png`;
    mkdirSync(join(b.dir, 'images'), { recursive: true });
    writeFileSync(join(b.dir, 'images', ref), png);
    const image = await a.app.inject({ method: 'GET', url: `/api/images/${ref}` });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['x-content-type-options']).toBe('nosniff');
    expect(image.headers['cache-control']).toContain('immutable');
    expect(image.rawPayload.equals(png)).toBe(true);
    expect((await a.app.inject({ method: 'GET', url: `/api/images/${'cd'.repeat(32)}.png` })).statusCode).toBe(404);
    // Bytes that are not the ref's are not served as it, nor cached.
    const forged = `${'ef'.repeat(32)}.png`;
    writeFileSync(join(b.dir, 'images', forged), png);
    const wrong = await a.app.inject({ method: 'GET', url: `/api/images/${forged}` });
    expect(wrong.statusCode).toBe(404);
    expect(wrong.headers['cache-control'] ?? '').not.toContain('immutable');

    // The composer of B's session: the upload is stored here, and the message carries it to B's store.
    const shot = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      (() => {
        const ihdr = Buffer.alloc(25);
        ihdr.writeUInt32BE(13, 0);
        ihdr.write('IHDR', 4);
        ihdr.writeUInt32BE(32, 8);
        ihdr.writeUInt32BE(16, 12);
        return ihdr;
      })(),
    ]);
    const uploaded = await a.app.inject({
      method: 'POST', url: `/api/sessions/${SESSION_ID}/attachments`, ...multipart('shot.png', 'image/png', shot),
    });
    expect(uploaded.statusCode).toBe(201);
    // A file that is not an image would be a path on A that B cannot open: refused.
    const sheet = Buffer.from('a,b\n1,2\n');
    const notImage = await a.app.inject({
      method: 'POST', url: `/api/sessions/${SESSION_ID}/attachments`, ...multipart('sheet.csv', 'text/csv', sheet),
    });
    expect([notImage.statusCode, notImage.json()]).toEqual([422, { error: 'attachment_not_on_device' }]);
    const forSpawn = await a.app.inject({ method: 'POST', url: `/api/attachments?machine=${idB}`, ...multipart('sheet.csv', 'text/csv', sheet) });
    expect(forSpawn.statusCode).toBe(422);
    const forSelf = await a.app.inject({ method: 'POST', url: `/api/attachments?machine=${idA}`, ...multipart('sheet.csv', 'text/csv', sheet) });
    expect([forSelf.statusCode, forSelf.json().kind]).toEqual([201, 'file']);
    const shotRef = uploaded.json().ref as string;
    expect(existsSync(join(b.dir, 'images', shotRef))).toBe(false);
    const sent = await a.api('POST', `/api/sessions/${SESSION_ID}/messages`, { text: 'look', attachments: [shotRef] });
    expect(sent.statusCode).toBeLessThan(300);
    expect(existsSync(join(b.dir, 'images', shotRef))).toBe(true);
    // A forwarded list is the member's alone, shown as A shows B's sessions; A by name is A's own alone.
    const fromB = (await a.api('GET', `/api/sessions?machine=${idB}`)).json().sessions as any[];
    expect(fromB.map((x) => x.id)).toEqual([SESSION_ID]);
    expect(fromB[0].machine).toMatchObject({ id: idB, online: true });
    expect(fromB[0].tagIds).toEqual([red]);
    const fromA = (await a.api('GET', `/api/sessions?machine=${idA}`)).json().sessions as any[];
    expect(fromA.some((x) => x.machine !== undefined)).toBe(false);

    // A settings change with no body is refused, not a crash.
    expect((await a.app.inject({ method: 'PATCH', url: '/api/settings' })).statusCode).toBe(400);
    expect((await a.api('PATCH', '/api/settings', [1])).statusCode).toBe(400);

    // B goes away: a request for its session that A holds no copy of is 409, not a hang and not A's 404.
    b.remote.stop();
    await until(() => a.federation.linkOf(SESSION_ID)?.channel?.ready !== true, 10_000);
    const offline = await a.api('GET', `/api/sessions/${SESSION_ID}/messages?limit=1`);
    expect([offline.statusCode, offline.json()]).toEqual([409, { error: 'member_offline' }]);
  }, 60_000);

  it('removing a member on the primary takes its sessions off the others', async () => {
    const { a, c, idB } = await threeLinked();
    expect((await a.api('DELETE', `/api/remote/devices/${idB}`)).statusCode).toBe(200);
    await until(async () => !(await listed(c)).some((x) => x.id === SESSION_ID), 15_000);
    expect(c.federation.linkOf(SESSION_ID)).toBeNull();
  }, 60_000);
});
