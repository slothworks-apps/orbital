import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { generateIdentity, deviceId, publicKeyOf } from '@orbital/shared/remote/keys';
import { authSignature } from '@orbital/shared/remote/relayApi';
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
    await store.upsertDevice({ id: deviceId(mac.publicKey), kind: 'mac', name: 'studio' });
    await store.upsertDevice({ id: deviceId(phone.publicKey), kind: 'phone', name: 'Pixel' });
    const token = await store.createPairingToken(deviceId(mac.publicKey), Date.now() + 10_000);
    await store.redeemPairingToken(token, deviceId(phone.publicKey), 'Pixel', 'android', Date.now());
    await store.confirmPair(deviceId(mac.publicKey), deviceId(phone.publicKey), Date.now());
    return { store, app, base, mac, phone };
  }

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
