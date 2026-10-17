import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { RETENTION_KEY, RETENTION_NEVER } from '../src/retention.js';
import { FakePhone } from './remoteFakePhone.js';
import { pairingCode, startMacAndRelay, until, type MacAndRelay } from './remoteHarness.js';

const SESSION_ID = 's-federated';

describe('federation: two linked servers', () => {
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

    // B goes off the relay: A keeps its session, offline as of when it last heard.
    b.remote.stop();
    await until(() => federated()?.machine?.online === false, 10_000);
    expect(federated()!.machine.asOf).toEqual(expect.any(Number));

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
});
