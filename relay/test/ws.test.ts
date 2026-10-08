import { readFileSync } from 'node:fs';
import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { generateIdentity, deviceId, publicKeyOf } from '@orbital/shared/remote/keys';
import { authSignature, signRequest } from '@orbital/shared/remote/relayApi';
import { FLAG_STATE, FLAG_WAKE, ZERO_WAKE, decodeFrame, encodeFrame } from '@orbital/shared/remote/frame';
import { buildRelay, OFFLINE_QUEUE_MAX } from '../src/app.js';
import { openRelayStore } from '../src/store.js';
import type { WakeHook } from '../src/ws.js';
import { connectDevice, listen, sleep } from './helpers.js';

function frameTo(id: string, body: number[], flags = 0, wake = ZERO_WAKE) {
  return encodeFrame({ peer: publicKeyOf(id)!, flags, wake, body: new Uint8Array(body) });
}

describe('relay websocket', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  async function relay(onWake: WakeHook = () => {}) {
    const store = await openRelayStore(':memory:');
    const app = await buildRelay({ store, onWake });
    const base = await listen(app);
    closers.push(() => app.close());
    const mac = generateIdentity();
    const phone = generateIdentity();
    await store.upsertDevice({ id: deviceId(mac.publicKey), kind: 'mac' });
    await store.upsertDevice({ id: deviceId(phone.publicKey), kind: 'phone' });
    const token = await store.createPairingToken(deviceId(mac.publicKey), Date.now() + 10_000);
    await store.redeemPairingToken(token, deviceId(phone.publicKey), Date.now());
    await store.confirmPair(deviceId(mac.publicKey), deviceId(phone.publicKey), Date.now());
    return { store, app, base, mac, phone };
  }

  it('announces its package version in the challenge', async () => {
    const { base, mac } = await relay();
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?mac=${deviceId(mac.publicKey)}`);
    const first = await new Promise<unknown>((resolve) => ws.once('message', (raw) => resolve(JSON.parse((raw as Buffer).toString('utf8')))));
    ws.close();
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(first).toMatchObject({ type: 'challenge', version });
  });

  it('tells a phone that expects its pair that the pair is gone, and says nothing to one that is about to pair', async () => {
    const { base, store, mac, phone } = await relay();
    const macId = deviceId(mac.publicKey);
    // Still paired: the flag earns no answer.
    const still = await connectDevice(base, phone, macId, '&paired=1');
    // About to pair: no pair yet, but no flag either.
    const fresh = await connectDevice(base, generateIdentity(), macId);
    await sleep(50);
    expect(still.control.find((m) => m.type === 'unpaired')).toBeUndefined();
    expect(fresh.control.find((m) => m.type === 'unpaired')).toBeUndefined();
    still.ws.close(); fresh.ws.close();
    // Revoked while the phone was away: it hears so on its next connect.
    await store.revokePair(macId, deviceId(phone.publicKey));
    const back = await connectDevice(base, phone, macId, '&paired=1');
    expect(await back.next('unpaired')).toMatchObject({ type: 'unpaired', mac: macId });
    back.ws.close();
  });

  it('a revoke that lands while a phone is connecting is not lost', async () => {
    const { base, app, store, mac, phone } = await relay();
    const macId = deviceId(mac.publicKey);
    const phoneId = deviceId(phone.publicKey);
    const m = await connectDevice(base, mac);
    // Hold the phone between its peers read and its attach, and revoke there.
    const touch = store.touch.bind(store);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let reached!: () => void;
    const atTouch = new Promise<void>((r) => { reached = r; });
    store.touch = async (id, now) => {
      if (id === phoneId) { reached(); await held; }
      return touch(id, now);
    };
    const connecting = connectDevice(base, phone, macId, '&paired=1');
    await atTouch;
    const revoked = await app.inject({
      method: 'POST', url: '/pair/revoke', payload: signRequest(mac, 'pair.revoke', { phone: phoneId }, Date.now()),
    });
    expect(revoked.statusCode).toBe(200);
    release();
    const p = await connecting;
    expect(p.peers).toEqual([]);
    expect(await p.next('unpaired')).toMatchObject({ type: 'unpaired', mac: macId });
    p.ws.send(frameTo(macId, [1]));
    await sleep(50);
    expect(m.data).toHaveLength(0);
  });

  it('a pair confirmed while a phone is connecting routes at once', async () => {
    const { base, app, store, mac } = await relay();
    const macId = deviceId(mac.publicKey);
    const late = generateIdentity();
    const lateId = deviceId(late.publicKey);
    const m = await connectDevice(base, mac);
    const token = await store.createPairingToken(macId, Date.now() + 10_000);
    await store.redeemPairingToken(token, lateId, Date.now());
    const touch = store.touch.bind(store);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let reached!: () => void;
    const atTouch = new Promise<void>((r) => { reached = r; });
    store.touch = async (id, now) => {
      if (id === lateId) { reached(); await held; }
      return touch(id, now);
    };
    const connecting = connectDevice(base, late, macId);
    await atTouch;
    const confirmed = await app.inject({
      method: 'POST', url: '/pair/confirm', payload: signRequest(mac, 'pair.confirm', { phone: lateId, accept: true }, Date.now()),
    });
    expect(confirmed.statusCode).toBe(200);
    release();
    const p = await connecting;
    expect(p.peers).toEqual([macId]);
    p.ws.send(frameTo(macId, [2]));
    expect(decodeFrame(await m.nextData())!.body).toEqual(new Uint8Array([2]));
  });

  it('forwards only within a pair, rewriting the peer to the sender', async () => {
    const { base, mac, phone } = await relay();
    const m = await connectDevice(base, mac);
    const p = await connectDevice(base, phone);
    const stranger = await connectDevice(base, generateIdentity());
    stranger.ws.send(frameTo(m.id, [9]));
    p.ws.send(frameTo(m.id, [1, 2]));
    const got = decodeFrame(await m.nextData())!;
    expect(deviceId(got.peer)).toBe(p.id);
    expect(got.body).toEqual(new Uint8Array([1, 2]));
    await sleep(50);
    expect(m.data).toHaveLength(0);
    expect(stranger.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('forwards a frame sent in the same breath as auth', async () => {
    const { base, mac, phone } = await relay();
    const m = await connectDevice(base, mac);
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
    closers.push(async () => { ws.terminate(); });
    const nonce = await new Promise<string>((r) => ws.once('message', (raw) => r(JSON.parse((raw as Buffer).toString('utf8')).nonce)));
    // Corked, both go out in one TCP write before `ok`, so the relay's
    // receiver parses them from one read and emits them back to back.
    const tcp = (ws as unknown as { _socket: import('node:net').Socket })._socket;
    tcp.cork();
    ws.send(JSON.stringify({ type: 'auth', pub: deviceId(phone.publicKey), sig: authSignature(phone, nonce) }));
    ws.send(frameTo(m.id, [7]));
    tcp.uncork();
    const got = decodeFrame(await m.nextData())!;
    expect(deviceId(got.peer)).toBe(deviceId(phone.publicKey));
    expect(got.body).toEqual(new Uint8Array([7]));
  });

  it('ok lists the online peers, and peers hear each other come and go', async () => {
    const { base, mac, phone } = await relay();
    const m = await connectDevice(base, mac);
    expect(m.peers).toEqual([]);
    const p = await connectDevice(base, phone);
    expect(p.peers).toEqual([m.id]);
    const online = await m.next('presence');
    expect(online).toEqual({ type: 'presence', peer: p.id, online: true });
    p.ws.close();
    const offline = await m.next('presence');
    expect(offline).toEqual({ type: 'presence', peer: p.id, online: false });
  });

  it('queues empty-body state frames for an offline phone, drops the rest, drains on connect', async () => {
    const { base, mac, phone } = await relay();
    const m = await connectDevice(base, mac);
    const to = deviceId(phone.publicKey);
    m.ws.send(frameTo(to, [1]));
    // Content is sealed under keys the phone's next handshake replaces: never queued.
    m.ws.send(frameTo(to, [1], FLAG_STATE));
    for (let i = 0; i < OFFLINE_QUEUE_MAX + 2; i++) m.ws.send(frameTo(to, [], FLAG_STATE, new Uint8Array(16).fill(i)));
    await sleep(50);
    const p = await connectDevice(base, phone);
    const drained: Uint8Array[] = [];
    for (let i = 0; i < OFFLINE_QUEUE_MAX; i++) drained.push(await p.nextData());
    expect(decodeFrame(drained[0])!.wake).toEqual(new Uint8Array(16).fill(2));
    expect(drained.every((f) => decodeFrame(f)!.body.length === 0)).toBe(true);
    await sleep(50);
    expect(p.data).toHaveLength(0);
  });

  it('a device the relay has never met may connect but gets no row', async () => {
    const { base, store } = await relay();
    const stranger = await connectDevice(base, generateIdentity());
    expect(await store.device(stranger.id)).toBeNull();
  });

  it('calls the wake hook only when the addressee is offline', async () => {
    const wakes: unknown[] = [];
    const { base, mac, phone } = await relay((from, to, wake) => { wakes.push({ from, to, wake: Buffer.from(wake).toString('hex') }); });
    const m = await connectDevice(base, mac);
    const wake = new Uint8Array(16).fill(1);
    m.ws.send(frameTo(deviceId(phone.publicKey), [], FLAG_WAKE | FLAG_STATE, wake));
    await sleep(50);
    expect(wakes).toEqual([{ from: m.id, to: deviceId(phone.publicKey), wake: '01'.repeat(16) }]);
    const p = await connectDevice(base, phone);
    await p.nextData();
    m.ws.send(frameTo(p.id, [], FLAG_WAKE, wake));
    await p.nextData();
    expect(wakes).toHaveLength(1);
  });

  it('closes a socket that fails auth or sends junk before auth', async () => {
    const { base } = await relay();
    const closeCode = async (first: string) => {
      const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
      await new Promise((r) => ws.once('open', r));
      ws.send(first);
      return new Promise<number>((r) => ws.once('close', r));
    };
    expect(await closeCode(JSON.stringify({ type: 'auth', pub: deviceId(generateIdentity().publicKey), sig: 'bad' }))).toBe(4001);
    expect(await closeCode('not json')).toBe(4001);
  });
});
