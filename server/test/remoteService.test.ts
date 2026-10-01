import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateIdentity, deviceId, fromBase64Url, publicKeyOf } from '@orbital/shared/remote/keys';
import { FLAG_STATE, FLAG_WAKE, WAKE_BYTES, ZERO_WAKE, decodeFrame, encodeFrame } from '@orbital/shared/remote/frame';
import { startHandshake } from '@orbital/shared/remote/handshake';
import { PAIRING_SECRET_BYTES, QrPayload, pairingProof } from '@orbital/shared/remote/relayApi';
import { parseNotificationSettings } from '@orbital/shared/notifications';
import { Hub } from '../src/api/hub.js';
import { openDb } from '../src/db/database.js';
import { createImageStore } from '../src/images/store.js';
import { DeviceStore } from '../src/remote/devices.js';
import { IDENTITY_FILE } from '../src/remote/identity.js';
import { RelayClient } from '../src/remote/relayClient.js';
import { RemoteService, type RemoteServiceOptions } from '../src/remote/service.js';

type Answer = { status: number; body: unknown };

/** Stands in for the relay connection: online on `start`, records what is posted and sent. */
class FakeClient extends EventEmitter {
  status: 'off' | 'connecting' | 'online' = 'off';
  readonly peersOnline = new Set<string>();
  readonly posts: { path: string; payload: unknown }[] = [];
  readonly sent: Uint8Array[] = [];
  answers: Record<string, Answer> = {};
  start() { this.status = 'online'; this.emit('status', 'online'); }
  stop() { this.status = 'off'; }
  sendData(frame: Uint8Array) { this.sent.push(frame); return true; }
  async post(path: string, _action: string, payload: unknown): Promise<Answer> {
    this.posts.push({ path, payload });
    return this.answers[path] ?? { status: 200, body: {} };
  }
}

const NOW = 1_000_000;

/**
 * The secret from the last QR `startPairing` made: what a real phone reads
 * off the screen. `request` proves it the way the phone does.
 */
let qrSecret: Uint8Array = new Uint8Array(PAIRING_SECRET_BYTES);

function build(
  seed?: (devices: DeviceStore) => void,
  opts: { corruptIdentity?: boolean; clientFactory?: RemoteServiceOptions['clientFactory'] } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'orbital-remote-svc-'));
  const db = openDb(join(dir, 'index.db'));
  const devices = new DeviceStore(db);
  seed?.(devices);
  if (opts.corruptIdentity) writeFileSync(join(dir, IDENTITY_FILE), 'not json');
  let now = NOW;
  const hub = new Hub({ heartbeatIntervalMs: 60_000 });
  const fake = new FakeClient();
  fake.answers['/pair/token'] = { status: 200, body: { token: 'tok', expiresAt: NOW + 60_000 } };
  const desktop = { notify_needs_input: 'false' };
  const settings: Record<string, string> = { remote_enabled: 'true', ...desktop };
  const service = new RemoteService({
    db, hub, dataDir: dir, images: createImageStore(join(dir, 'images')), imagesDir: join(dir, 'images'),
    serverVersion: 'test',
    inject: async () => ({ statusCode: 200, body: JSON.stringify({ sessions: [] }) }),
    settings: { get: (k) => settings[k] ?? '' },
    allSettings: () => settings,
    now: () => now,
    clientFactory: opts.clientFactory ?? (() => fake as unknown as RelayClient),
  });
  const startPairing = service.startPairing.bind(service);
  service.startPairing = async () => {
    const res = await startPairing();
    if ('qr' in res) qrSecret = fromBase64Url(QrPayload.parse(JSON.parse(res.qr)).secret);
    return res;
  };
  service.start();
  return { service, fake, hub, devices, settings, advance: (ms: number) => { now += ms; } };
}

const phoneId = () => deviceId(generateIdentity().publicKey);
const request = (phone: string, proof = pairingProof(qrSecret, publicKeyOf(phone)!)) =>
  ({ type: 'pair_request', phone, name: 'iPhone', platform: 'ios', proof });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('RemoteService pairing', () => {
  it('ignores a pair request outside a pairing window', () => {
    const { service, fake } = build();
    fake.emit('control', request(phoneId()));
    expect(service.status().pendingPair).toBeNull();
  });
  it('keeps the first request of a window; a second does not replace it', async () => {
    const { service, fake } = build();
    await service.startPairing();
    const first = phoneId();
    fake.emit('control', request(first));
    fake.emit('control', request(phoneId()));
    expect(service.status().pendingPair?.phone).toBe(first);
  });
  it('ignores a pair request whose proof is not for this code and this key', async () => {
    const { service, fake } = build();
    await service.startPairing();
    const phone = phoneId();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A key the relay swapped in, carrying the real phone's proof.
    fake.emit('control', request(phoneId(), pairingProof(qrSecret, publicKeyOf(phone)!)));
    fake.emit('control', request(phone, 'not-a-proof'));
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
    expect(service.status().pendingPair).toBeNull();
    fake.emit('control', request(phone));
    expect(service.status().pendingPair?.phone).toBe(phone);
  });
  it('an expired code takes its pending request with it', async () => {
    const { service, fake, advance } = build();
    await service.startPairing();
    const phone = phoneId();
    fake.emit('control', request(phone));
    expect(service.status().pendingPair?.phone).toBe(phone);
    advance(60_000);
    expect(service.status()).toMatchObject({ pendingPair: null, pairing: null });
    expect(await service.confirmPairing(true, phone)).toBe(false);
    expect(fake.posts.map((p) => p.path)).not.toContain('/pair/confirm');
  });
  it('confirm applies only to the phone the user verified, and pairs it with the desktop settings', async () => {
    const { service, fake, hub, devices, settings } = build();
    await service.startPairing();
    const phone = phoneId();
    fake.emit('control', request(phone));
    expect(await service.confirmPairing(true, phoneId())).toBe(false);
    expect(service.status().pendingPair?.phone).toBe(phone);

    const before = hub.subscriberCount('sessions');
    expect(await service.confirmPairing(true, phone)).toBe(true);
    await tick();
    expect(service.status().pendingPair).toBeNull();
    expect(devices.get(phone)?.notifications).toEqual(parseNotificationSettings(settings));
    expect(hub.subscriberCount('sessions')).toBe(before + 1);
  });
  it('a relay failure answers relay_error to pairing and false to confirm', async () => {
    const { service, fake, devices } = build();
    await service.startPairing();
    const phone = phoneId();
    fake.emit('control', request(phone));
    fake.answers['/pair/token'] = { status: 0, body: { error: 'network' } };
    fake.answers['/pair/confirm'] = { status: 0, body: { error: 'network' } };
    expect(await service.confirmPairing(true, phone)).toBe(false);
    expect(devices.get(phone)).toBeNull();
    expect(await service.startPairing()).toEqual({ error: 'relay_error' });
  });

  /**
   * The relay sends `paired` to the phone before it answers the Mac's
   * confirm, so a phone's handshake can arrive while the post is pending.
   */
  function holdConfirm(fake: FakeClient): (a: Answer) => void {
    let answer!: (a: Answer) => void;
    fake.post = (path: string, _action: string, payload: unknown) => {
      fake.posts.push({ path, payload });
      return new Promise<Answer>((resolve) => { answer = resolve; });
    };
    return (a) => answer(a);
  }

  it('a confirmed phone exists before the relay answers, so its immediate handshake is answered', async () => {
    const { service, fake, devices } = build();
    await service.startPairing();
    const phone = generateIdentity();
    const id = deviceId(phone.publicKey);
    fake.emit('control', request(id));
    const answer = holdConfirm(fake);
    const confirm = service.confirmPairing(true, id);

    const hs = startHandshake(phone, publicKeyOf(service.status().macId!)!, 'initiator');
    fake.emit('data', encodeFrame({ peer: phone.publicKey, flags: 0, wake: ZERO_WAKE, body: hs.message! }));
    expect(fake.sent).toHaveLength(1);
    expect(hs.complete(decodeFrame(fake.sent[0])!.body)).not.toBeNull();

    answer({ status: 200, body: {} });
    expect(await confirm).toBe(true);
    expect(devices.get(id)).not.toBeNull();
    expect(service.status().pendingPair).toBeNull();
  });

  it('a confirm the relay refuses rolls the early device back', async () => {
    const { service, fake, hub, devices } = build();
    await service.startPairing();
    const phone = generateIdentity();
    const id = deviceId(phone.publicKey);
    fake.emit('control', request(id));
    await tick();
    const before = hub.subscriberCount('sessions');
    const answer = holdConfirm(fake);
    const confirm = service.confirmPairing(true, id);
    const hs = startHandshake(phone, publicKeyOf(service.status().macId!)!, 'initiator');
    fake.emit('data', encodeFrame({ peer: phone.publicKey, flags: 0, wake: ZERO_WAKE, body: hs.message! }));
    expect(fake.sent).toHaveLength(1);

    answer({ status: 0, body: { error: 'network' } });
    expect(await confirm).toBe(false);
    await tick();
    expect(devices.get(id)).toBeNull();
    expect(hub.subscriberCount('sessions')).toBe(before);
    // With the device gone, its frames are a stranger's again.
    const again = startHandshake(phone, publicKeyOf(service.status().macId!)!, 'initiator');
    fake.emit('data', encodeFrame({ peer: phone.publicKey, flags: 0, wake: ZERO_WAKE, body: again.message! }));
    expect(fake.sent).toHaveLength(1);
  });
});

describe('RemoteService relay status', () => {
  it('counts refused connection attempts and publishes each one, though the relay stays connecting', async () => {
    const { service, hub } = build(undefined, {
      // Nothing listens on port 1: every attempt is refused straight away.
      clientFactory: (o) => new RelayClient({ ...o, relayUrl: 'http://127.0.0.1:1', reconnectDelayMs: 20 }),
    });
    const published: Record<string, unknown>[] = [];
    const publish = vi.spyOn(hub, 'publish').mockImplementation((topic, payload) => {
      if (topic === 'remote') published.push(payload);
    });
    try {
      await waitFor(() => published.some((p) => p.relayAttempts === 2));
      expect(service.status()).toMatchObject({ relay: 'connecting', relayAttempts: 2 });
      expect(published.find((p) => p.relayAttempts === 2)).toMatchObject({ event: 'status', relay: 'connecting' });
    } finally {
      publish.mockRestore();
      service.stop();
    }
    expect(service.status().relayAttempts).toBe(0);
  });
});

describe('RemoteService revoke', () => {
  it('removes the device even when the relay revoke fails', async () => {
    const phone = phoneId();
    const { service, fake, devices } = build((d) => d.add({
      id: phone, name: 'iPhone', platform: 'ios', pairedAt: 1, notifications: parseNotificationSettings({}),
    }));
    fake.answers['/pair/revoke'] = { status: 0, body: { error: 'network' } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await service.revoke(phone)).toBe(true);
    warn.mockRestore();
    expect(devices.get(phone)).toBeNull();
    expect(fake.posts.map((p) => p.path)).toEqual(['/pair/revoke']);
  });
});

describe('RemoteService data', () => {
  it('opens no session for an unpaired phone', () => {
    const { fake, service } = build();
    const stranger = generateIdentity();
    const hs = startHandshake(stranger, publicKeyOf(service.status().macId!)!, 'initiator');
    fake.emit('data', encodeFrame({ peer: stranger.publicKey, flags: 0, wake: ZERO_WAKE, body: hs.message! }));
    expect(fake.sent).toEqual([]);
  });
  it('answers a paired phone\'s handshake through the relay', () => {
    const phone = generateIdentity();
    const { fake, service } = build((d) => d.add({
      id: deviceId(phone.publicKey), name: 'iPhone', platform: 'ios', pairedAt: 1, notifications: parseNotificationSettings({}),
    }));
    const hs = startHandshake(phone, publicKeyOf(service.status().macId!)!, 'initiator');
    fake.emit('data', encodeFrame({ peer: phone.publicKey, flags: 0, wake: ZERO_WAKE, body: hs.message! }));
    expect(fake.sent).toHaveLength(1);
    const reply = decodeFrame(fake.sent[0])!;
    expect(deviceId(reply.peer)).toBe(deviceId(phone.publicKey));
    expect(hs.complete(reply.body)).not.toBeNull();
  });
  it('a phone back online on a new socket handshakes afresh', () => {
    const phone = generateIdentity();
    const id = deviceId(phone.publicKey);
    const { fake, service } = build((d) => d.add({
      id, name: 'iPhone', platform: 'ios', pairedAt: 1, notifications: parseNotificationSettings({}),
    }));
    const macKey = publicKeyOf(service.status().macId!)!;
    const first = startHandshake(phone, macKey, 'initiator');
    fake.emit('data', encodeFrame({ peer: phone.publicKey, flags: 0, wake: ZERO_WAKE, body: first.message! }));
    // The relay replaced the phone's socket: no `offline`, just `online` again.
    fake.emit('control', { type: 'presence', peer: id, online: true });
    const second = startHandshake(phone, macKey, 'initiator');
    fake.emit('data', encodeFrame({ peer: phone.publicKey, flags: 0, wake: ZERO_WAKE, body: second.message! }));
    expect(fake.sent).toHaveLength(2);
    expect(second.complete(decodeFrame(fake.sent[1])!.body)).not.toBeNull();
  });
  it('a needs_input transition sends one empty wake frame, flagged and tokened', async () => {
    const phone = generateIdentity();
    const { fake, hub } = build((d) => d.add({
      id: deviceId(phone.publicKey), name: 'iPhone', platform: 'ios', pairedAt: 1, notifications: parseNotificationSettings({}),
    }));
    await tick(); // the watcher starts once its seed fetch answers
    hub.publish('sessions', { event: 'upsert', session: { id: 's1', title: 'one', status: 'working' } });
    hub.publish('sessions', { event: 'status', sessionId: 's1', status: 'needs_input' });
    expect(fake.sent).toHaveLength(1);
    const frame = decodeFrame(fake.sent[0])!;
    expect(deviceId(frame.peer)).toBe(deviceId(phone.publicKey));
    expect(frame.flags).toBe(FLAG_WAKE | FLAG_STATE);
    expect(frame.wake).toHaveLength(WAKE_BYTES);
    expect(frame.wake.some((b) => b !== 0)).toBe(true);
    expect(frame.body).toHaveLength(0);
  });
});

describe('RemoteService identity', () => {
  it('a regenerated identity forgets every paired phone, with one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { devices, service } = build((d) => {
      for (const id of [phoneId(), phoneId()]) {
        d.add({ id, name: 'iPhone', platform: 'ios', pairedAt: 1, notifications: parseNotificationSettings({}) });
      }
    }, { corruptIdentity: true });
    const ours = warn.mock.calls.filter(([line]) => String(line).startsWith('[remote]'));
    warn.mockRestore();
    expect(devices.list()).toEqual([]);
    expect(service.status().devices).toEqual([]);
    expect(ours).toHaveLength(1);
  });
});

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}
