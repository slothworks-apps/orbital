import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateIdentity, deviceId, fromBase64Url, publicKeyOf, toBase64Url } from '@orbital/shared/remote/keys';
import { FLAG_STATE, FLAG_WAKE, WAKE_BYTES, ZERO_WAKE, decodeFrame, encodeFrame } from '@orbital/shared/remote/frame';
import { startHandshake } from '@orbital/shared/remote/handshake';
import {
  PAIRING_SECRET_BYTES, PAIR_NAME_MAX_CHARS, QrPayload, pairingProof, sealPairingDevice,
} from '@orbital/shared/remote/relayApi';
import { parseNotificationSettings } from '@orbital/shared/notifications';
import { PROTOCOL_VERSION, decodeInner, encodeInner } from '@orbital/shared/remote/messages';
import { MIN_PHONE_VERSION, MIN_RELAY_VERSION } from '@orbital/shared/remote/version';
import type { RosterEntry } from '@orbital/shared/remote/roster';
import { Hub } from '../src/api/hub.js';
import { openDb, type OrbitalDb } from '../src/db/database.js';
import { createImageStore } from '../src/images/store.js';
import { DeviceStore } from '../src/remote/devices.js';
import { RosterStore } from '../src/remote/rosterStore.js';
import { IDENTITY_FILE } from '../src/remote/identity.js';
import { RelayClient } from '../src/remote/relayClient.js';
import {
  BAD_SECRET_ERROR, NO_RELAY_URL_ERROR, PAIR_CODE_ATTEMPTS, RELAY_TOO_OLD_RECHECK_MS, RemoteService, UNKNOWN_PHONE_NAME,
  type RemoteServiceOptions,
} from '../src/remote/service.js';
import { pairingCode, wrongCode } from './remoteHarness.js';
import { makeTmpDir } from './tmp.js';

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
  opts: { corruptIdentity?: boolean; clientFactory?: RemoteServiceOptions['clientFactory']; relayUrl?: string } = {},
) {
  const dir = makeTmpDir('remote-svc');
  const db = openDb(join(dir, 'index.db'));
  const devices = new DeviceStore(db);
  seed?.(devices);
  if (opts.corruptIdentity) writeFileSync(join(dir, IDENTITY_FILE), 'not json');
  let now = NOW;
  const hub = new Hub({ heartbeatIntervalMs: 60_000 });
  const fake = new FakeClient();
  fake.answers['/pair/token'] = { status: 200, body: { token: 'tok', expiresAt: NOW + 60_000 } };
  const desktop = { notify_needs_input: 'true' };
  const settings: Record<string, string> = {
    remote_enabled: 'true', remote_relay_url: opts.relayUrl ?? 'https://relay.test', ...desktop,
  };
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
  return { service, fake, hub, db, devices, settings, advance: (ms: number) => { now += ms; } };
}

const phoneId = () => deviceId(generateIdentity().publicKey);
/** As the relay forwards it: the device sealed by the phone, and empty plain names. */
const request = (phone: string, proof = pairingProof(qrSecret, publicKeyOf(phone)!)) => ({
  type: 'pair_request', phone, proof, name: '', platform: '',
  device: sealPairingDevice(qrSecret, publicKeyOf(phone)!, { name: 'iPhone', platform: 'ios' }),
});
const tick = () => new Promise((r) => setTimeout(r, 0));
/** The code the phone shows for this request: what the user reads off it and types on the Mac. */
const codeFor = (service: RemoteService, phone: string) =>
  pairingCode(service.status().macId!, publicKeyOf(phone)!);

describe('RemoteService roster', () => {
  it('a rename made while the remote is off reaches the self entry at the next start', () => {
    const { service, settings } = build();
    const self = () => service.status().group.members.find((m) => m.self);
    expect(self()).toMatchObject({ links: true });
    settings.remote_enabled = 'false';
    service.settingsChanged();
    settings.remote_mac_name = 'renamed';
    service.nameChanged();
    settings.remote_enabled = 'true';
    service.settingsChanged();
    expect(self()).toMatchObject({ name: 'renamed', epoch: 1 });
  });
});

describe('RemoteService pairing', () => {
  it('gives the relay no name with a pairing code; the QR alone carries it', async () => {
    const { service, fake } = build();
    const res = await service.startPairing();
    expect(fake.posts.find((p) => p.path === '/pair/token')?.payload).toEqual({});
    expect('qr' in res && QrPayload.parse(JSON.parse(res.qr)).name).toBeTruthy();
  });
  it('shows a phone whose sealed device does not open, or that sent none, as an unknown phone', async () => {
    for (const device of [undefined, sealPairingDevice(new Uint8Array(PAIRING_SECRET_BYTES), new Uint8Array(32), { name: 'x', platform: 'y' })]) {
      const { service, fake } = build();
      await service.startPairing();
      const phone = phoneId();
      // A relay that put a name in the clear is not believed either.
      fake.emit('control', { ...request(phone), name: 'Relay says', platform: 'android', device });
      expect(service.status().pendingPair).toMatchObject({ phone, name: UNKNOWN_PHONE_NAME, platform: '' });
    }
  });
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
    expect(await service.confirmPairing(true, phone, codeFor(service, phone))).toEqual({ error: 'no_pending' });
    expect(fake.posts.map((p) => p.path)).not.toContain('/pair/confirm');
  });
  it('confirm applies only to the phone the user verified, and pairs it with the desktop settings', async () => {
    const { service, fake, hub, devices, settings } = build();
    await service.startPairing();
    const phone = phoneId();
    fake.emit('control', request(phone));
    expect(await service.confirmPairing(true, phoneId(), codeFor(service, phone))).toEqual({ error: 'no_pending' });
    expect(service.status().pendingPair?.phone).toBe(phone);

    const before = hub.subscriberCount('sessions');
    expect(await service.confirmPairing(true, phone, codeFor(service, phone))).toEqual({ ok: true });
    await tick();
    expect(service.status().pendingPair).toBeNull();
    expect(devices.get(phone)?.notifications).toEqual(parseNotificationSettings(settings));
    expect(hub.subscriberCount('sessions')).toBe(before + 1);
  });
  it('a relay failure answers relay_error to pairing and to confirm', async () => {
    const { service, fake, devices } = build();
    await service.startPairing();
    const phone = phoneId();
    fake.emit('control', request(phone));
    fake.answers['/pair/token'] = { status: 0, body: { error: 'network' } };
    fake.answers['/pair/confirm'] = { status: 0, body: { error: 'network' } };
    expect(await service.confirmPairing(true, phone, codeFor(service, phone))).toEqual({ error: 'relay_error' });
    expect(devices.get(phone)).toBeNull();
    expect(await service.startPairing()).toEqual({ error: 'relay_error' });
  });

  it('the status carries the attempts left, never the code', async () => {
    const { service, fake, hub } = build();
    const publish = vi.spyOn(hub, 'publish');
    await service.startPairing();
    const phone = phoneId();
    fake.emit('control', request(phone));
    const code = codeFor(service, phone);
    expect(service.status().pendingPair).toEqual({ phone, name: 'iPhone', platform: 'ios', kind: 'phone', attemptsLeft: PAIR_CODE_ATTEMPTS });
    expect(JSON.stringify(service.status())).not.toContain(code);
    expect(publish).toHaveBeenCalledWith('remote', expect.objectContaining({ event: 'pair_request', phone }));
    expect(JSON.stringify(publish.mock.calls)).not.toContain(code);
  });
  it.each(['lower', 'look-alikes', 'dashed'])('the right code pairs however it is spelled (%s)', async (spelling) => {
    const { service, fake, devices } = build();
    await service.startPairing();
    // Generated until the code has a 0 or a 1 for the look-alike spelling to replace.
    let phone = phoneId();
    while (spelling === 'look-alikes' && !/[01]/.test(codeFor(service, phone))) phone = phoneId();
    fake.emit('control', request(phone));
    const code = codeFor(service, phone);
    const typed = spelling === 'lower' ? code.toLowerCase()
      : spelling === 'look-alikes' ? code.replace(/0/g, 'o').replace(/1/g, 'L')
        : ` ${code.slice(0, 3)}-${code.slice(3)} `;
    expect(await service.confirmPairing(true, phone, typed)).toEqual({ ok: true });
    expect(devices.get(phone)).not.toBeNull();
    expect(fake.posts.find((p) => p.path === '/pair/confirm')?.payload).toEqual({ phone, accept: true });
  });
  it('a wrong code counts down without telling the relay; the right one still pairs', async () => {
    const { service, fake, devices } = build();
    await service.startPairing();
    const phone = phoneId();
    fake.emit('control', request(phone));
    const code = codeFor(service, phone);
    expect(await service.confirmPairing(true, phone, wrongCode(code))).toEqual({ error: 'code_mismatch', attemptsLeft: PAIR_CODE_ATTEMPTS - 1 });
    expect(service.status().pendingPair?.attemptsLeft).toBe(PAIR_CODE_ATTEMPTS - 1);
    expect(devices.get(phone)).toBeNull();
    expect(fake.posts.map((p) => p.path)).not.toContain('/pair/confirm');
    expect(await service.confirmPairing(true, phone, code)).toEqual({ ok: true });
  });
  it('the last wrong code rejects on the relay and clears the request; the next one starts afresh', async () => {
    const { service, fake, devices } = build();
    await service.startPairing();
    const phone = phoneId();
    fake.emit('control', request(phone));
    const wrong = wrongCode(codeFor(service, phone));
    for (let left = PAIR_CODE_ATTEMPTS - 1; left > 0; left--) {
      expect(await service.confirmPairing(true, phone, wrong)).toEqual({ error: 'code_mismatch', attemptsLeft: left });
    }
    expect(await service.confirmPairing(true, phone, wrong)).toEqual({ error: 'code_rejected' });
    expect(fake.posts.filter((p) => p.path === '/pair/confirm').map((p) => p.payload)).toEqual([{ phone, accept: false }]);
    expect(devices.get(phone)).toBeNull();
    expect(service.status()).toMatchObject({ pendingPair: null, pairing: null });

    await service.startPairing();
    const next = phoneId();
    fake.emit('control', request(next));
    expect(service.status().pendingPair?.attemptsLeft).toBe(PAIR_CODE_ATTEMPTS);
  });
  it('reject needs no code', async () => {
    const { service, fake, devices } = build();
    await service.startPairing();
    const phone = phoneId();
    fake.emit('control', request(phone));
    expect(await service.confirmPairing(false, phone)).toEqual({ ok: true });
    expect(fake.posts.find((p) => p.path === '/pair/confirm')?.payload).toEqual({ phone, accept: false });
    expect(devices.get(phone)).toBeNull();
    expect(service.status().pendingPair).toBeNull();
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
    const confirm = service.confirmPairing(true, id, codeFor(service, id));

    const hs = startHandshake(phone, publicKeyOf(service.status().macId!)!, 'initiator');
    fake.emit('data', encodeFrame({ peer: phone.publicKey, flags: 0, wake: ZERO_WAKE, body: hs.message! }));
    expect(fake.sent).toHaveLength(1);
    expect(hs.complete(decodeFrame(fake.sent[0])!.body)).not.toBeNull();

    answer({ status: 200, body: {} });
    expect(await confirm).toEqual({ ok: true });
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
    const confirm = service.confirmPairing(true, id, codeFor(service, id));
    const hs = startHandshake(phone, publicKeyOf(service.status().macId!)!, 'initiator');
    fake.emit('data', encodeFrame({ peer: phone.publicKey, flags: 0, wake: ZERO_WAKE, body: hs.message! }));
    expect(fake.sent).toHaveLength(1);

    answer({ status: 0, body: { error: 'network' } });
    expect(await confirm).toEqual({ error: 'relay_error' });
    await tick();
    expect(devices.get(id)).toBeNull();
    expect(hub.subscriberCount('sessions')).toBe(before);
    // With the device gone, its frames are a stranger's again.
    const again = startHandshake(phone, publicKeyOf(service.status().macId!)!, 'initiator');
    fake.emit('data', encodeFrame({ peer: phone.publicKey, flags: 0, wake: ZERO_WAKE, body: again.message! }));
    expect(fake.sent).toHaveLength(1);
  });
});

/** Members written straight into the store, beside the service's own self entry: no link is asked yet. */
function withMembers(db: OrbitalDb, ...entries: Partial<RosterEntry>[]) {
  const store = new RosterStore(db);
  const added = entries.map((e): RosterEntry => ({
    id: phoneId(), kind: 'desktop', name: 'peer', os: 'linux', links: true, epoch: 1,
    addedBy: 'x', addedAt: NOW, describedAt: NOW, ...e,
  }));
  store.replace([...store.list(), ...added]);
  return added.map((e) => e.id);
}

describe('RemoteService mutual pairs', () => {
  const ok = { type: 'ok', peers: [] };
  const asked = (fake: FakeClient) => fake.posts.filter((p) => p.path === '/pair/mutual').map((p) => (p.payload as { peer: string }).peer);

  it('asks once per relay connection for each live member that links and is not paired yet', async () => {
    const { fake, db, devices } = build();
    const paired = phoneId();
    devices.add({ id: paired, name: 'p', platform: 'linux', kind: 'desktop', pairedAt: NOW, notifications: parseNotificationSettings({}) });
    const [server] = withMembers(db, {}, { kind: 'phone', links: false }, { removedBy: 'x', removedAt: NOW }, { id: paired });
    fake.emit('control', ok);
    await tick();
    expect(asked(fake)).toEqual([server]);
    fake.emit('control', ok);
    await tick();
    expect(asked(fake)).toEqual([server, server]);
  });

  it('a relay without the route marks the member pair-by-hand until the next ok; a relay error is asked again, a refusal is not', async () => {
    const { service, fake, db, settings } = build();
    const [server] = withMembers(db, {});
    const member = () => service.status().group.members.find((m) => m.id === server);
    fake.answers['/pair/mutual'] = { status: 404, body: {} };
    fake.emit('control', ok);
    await tick();
    expect(member()).toMatchObject({ pairByHand: true });
    fake.answers['/pair/mutual'] = { status: 500, body: {} };
    fake.emit('control', ok);
    await tick();
    expect(member()).toMatchObject({ pairByHand: false });
    expect(asked(fake)).toHaveLength(2);
    // A roster change asks again what failed on the relay's side.
    settings.remote_mac_name = 'renamed';
    service.nameChanged();
    await tick();
    expect(asked(fake)).toHaveLength(3);
    // A refusal waits for the next relay `ok`, whatever the roster does.
    fake.answers['/pair/mutual'] = { status: 429, body: {} };
    fake.emit('control', ok);
    await tick();
    settings.remote_mac_name = 'renamed again';
    service.nameChanged();
    await tick();
    expect(asked(fake)).toHaveLength(4);
  });

  it('a linked member the roster holds live becomes a paired device once; any other id is ignored', async () => {
    const { service, fake, db } = build();
    const [server] = withMembers(db, { name: 'vps', os: 'linux' });
    const [removed] = withMembers(db, { removedBy: 'x', removedAt: NOW });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fake.emit('control', { type: 'linked', peer: phoneId() });
    fake.emit('control', { type: 'linked', peer: removed });
    warn.mockRestore();
    expect(service.status().devices).toEqual([]);
    // A removed member is not left half linked: its pair goes at once. An unknown id is only ignored.
    expect(fake.posts.filter((p) => p.path === '/pair/revoke').map((p) => p.payload)).toEqual([{ phone: removed }]);
    // Both the post's answer and the control say so; the device is added once.
    fake.answers['/pair/mutual'] = { status: 200, body: { linked: true } };
    fake.emit('control', ok);
    await tick();
    fake.emit('control', { type: 'linked', peer: server });
    expect(service.status().devices).toEqual([
      expect.objectContaining({ id: server, name: 'vps', platform: 'linux', kind: 'desktop' }),
    ]);
    expect(service.status().group.members.find((m) => m.id === server)).toMatchObject({ linked: true });
  });

  it('a linked phone another member paired is ignored and watched for nothing', async () => {
    const { service, fake, db, hub } = build();
    const [phone] = withMembers(db, { kind: 'phone', links: false });
    const published = vi.spyOn(hub, 'publish');
    fake.emit('control', { type: 'linked', peer: phone });
    await tick();
    expect(service.status().devices).toEqual([]);
    expect(published).not.toHaveBeenCalled();
    published.mockRestore();
    // No watcher: a session needing input sends this phone no wake.
    hub.publish('sessions', { event: 'upsert', session: { id: 's1', title: 'one', status: 'working' } });
    hub.publish('sessions', { event: 'status', sessionId: 's1', status: 'needs_input' });
    expect(fake.sent).toEqual([]);
  });
});

describe('RemoteService join', () => {
  it('keeps the other device under its name cut to PAIR_NAME_MAX_CHARS', async () => {
    const { service, fake } = build();
    const other = deviceId(generateIdentity().publicKey);
    const long = 'd'.repeat(PAIR_NAME_MAX_CHARS + 30);
    const qr: QrPayload = {
      v: 1, relay: 'https://relay.test', mac: other, name: long, token: 'tok',
      secret: toBase64Url(new Uint8Array(PAIRING_SECRET_BYTES)), kind: 'desktop',
    };
    const res = await service.join(JSON.stringify(qr));
    expect(res).toMatchObject({ device: other });
    expect(service.status().joining).toEqual({ device: other, name: long.slice(0, PAIR_NAME_MAX_CHARS) });
    fake.emit('control', { type: 'paired', mac: other });
    expect(service.status().devices).toEqual([expect.objectContaining({ id: other, name: long.slice(0, PAIR_NAME_MAX_CHARS) })]);
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

describe('RemoteService remove', () => {
  const revoked = (fake: FakeClient) => fake.posts.filter((p) => p.path === '/pair/revoke').map((p) => (p.payload as { phone: string }).phone);

  it('removes a phone paired before the roster: its entry is written, marked removed, and the device goes even when the relay revoke fails', async () => {
    const phone = phoneId();
    const { service, fake, devices } = build((d) => d.add({
      id: phone, name: 'iPhone', platform: 'ios', kind: 'phone', pairedAt: 1, notifications: parseNotificationSettings({}),
    }));
    fake.answers['/pair/revoke'] = { status: 0, body: { error: 'network' } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await service.remove(phone)).toBe(true);
    warn.mockRestore();
    expect(devices.get(phone)).toBeNull();
    expect(fake.posts.map((p) => p.path)).toEqual(['/pair/revoke']);
    expect(service.status().group.members.find((m) => m.id === phone)).toMatchObject({
      kind: 'phone', name: 'iPhone', os: 'ios', removedBy: service.status().macId, removedAt: NOW, linked: false,
    });
  });

  it('a live member with no pair here is removed and still revoked at the relay, which drops a waiting half', async () => {
    const { service, fake, db } = build();
    const [member] = withMembers(db, {});
    expect(await service.remove(member)).toBe(true);
    expect(revoked(fake)).toEqual([member]);
    expect(service.status().group.members.find((m) => m.id === member)?.removedAt).toBe(NOW);
  });

  it('is false for an id neither in the roster nor paired, and for a member already removed', async () => {
    const { service, fake, db } = build();
    const [removed] = withMembers(db, { removedBy: 'x', removedAt: NOW });
    expect(await service.remove(phoneId())).toBe(false);
    expect(await service.remove(removed)).toBe(false);
    expect(revoked(fake)).toEqual([]);
  });

  it('leave revokes every pair, forgets every device and member, and starts a group of one at the next epoch', async () => {
    const paired = [phoneId(), phoneId()];
    const { service, fake, db, devices } = build((d) => {
      for (const id of paired) {
        d.add({ id, name: 'p', platform: 'ios', kind: 'phone', pairedAt: 1, notifications: parseNotificationSettings({}) });
      }
    });
    withMembers(db, { id: paired[0], kind: 'phone', links: false }, {});
    const self = service.status().macId!;
    await service.leave();
    expect(revoked(fake).sort()).toEqual([...paired].sort());
    expect(devices.list()).toEqual([]);
    expect(service.status().group.members).toEqual([
      expect.objectContaining({ id: self, self: true, epoch: 2, addedBy: self }),
    ]);
    expect(service.status().group.members[0].removedAt).toBeUndefined();
  });

  it('the relay saying unpaired drops that paired device and leaves the roster to the group', () => {
    const phone = phoneId();
    const { service, fake, devices, db } = build((d) => d.add({
      id: phone, name: 'iPhone', platform: 'ios', kind: 'phone', pairedAt: 1, notifications: parseNotificationSettings({}),
    }));
    withMembers(db, { id: phone, kind: 'phone', links: false });
    const before = service.rosterDigest();
    fake.emit('control', { type: 'unpaired', mac: phone });
    expect(devices.get(phone)).toBeNull();
    expect(service.rosterDigest()).toBe(before);
    expect(revoked(fake)).toEqual([]);
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
      id: deviceId(phone.publicKey), name: 'iPhone', platform: 'ios', kind: 'phone', pairedAt: 1, notifications: parseNotificationSettings({}),
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
      id, name: 'iPhone', platform: 'ios', kind: 'phone', pairedAt: 1, notifications: parseNotificationSettings({}),
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
  it('a peer that says bye takes its channel out of the map, so the next handshake builds a fresh one', () => {
    const phone = generateIdentity();
    const id = deviceId(phone.publicKey);
    const { fake, service } = build((d) => d.add({
      id, name: 'iPhone', platform: 'ios', kind: 'phone', pairedAt: 1, notifications: parseNotificationSettings({}),
    }));
    const macKey = publicKeyOf(service.status().macId!)!;
    const hs = startHandshake(phone, macKey, 'initiator');
    fake.emit('data', encodeFrame({ peer: phone.publicKey, flags: 0, wake: ZERO_WAKE, body: hs.message! }));
    const cipher = hs.complete(decodeFrame(fake.sent[0])!.body)!;
    const seal = (value: unknown) => encodeFrame({
      peer: phone.publicKey, flags: 0, wake: ZERO_WAKE, body: cipher.seal(encodeInner({ kind: 'json', value })),
    });
    fake.emit('data', seal({ t: 'hello', protocol: PROTOCOL_VERSION, app: `orbital-mobile/${MIN_PHONE_VERSION}` }));
    expect(service.channel(id)?.ready).toBe(true);
    fake.emit('data', seal({ t: 'bye', reason: 'protocol' }));
    expect(service.channel(id)).toBeNull();
  });
  it('a needs_input transition sends one empty wake frame, flagged and tokened', async () => {
    const phone = generateIdentity();
    const { fake, hub } = build((d) => d.add({
      id: deviceId(phone.publicKey), name: 'iPhone', platform: 'ios', kind: 'phone', pairedAt: 1, notifications: parseNotificationSettings({ notify_needs_input: 'true' }),
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

describe('RemoteService relay URL', () => {
  it('enabled with no relay URL is a failed start that constructs no client, until a URL is set', () => {
    const factory = vi.fn<NonNullable<RemoteServiceOptions['clientFactory']>>();
    const { service, fake, settings } = build(undefined, { relayUrl: '  ', clientFactory: factory });
    expect(factory).not.toHaveBeenCalled();
    expect(service.status()).toMatchObject({
      enabled: true, relay: 'off', relayAttempts: 0, relayUrl: '', macId: null, error: NO_RELAY_URL_ERROR,
    });

    factory.mockImplementation(() => fake as unknown as RelayClient);
    settings.remote_relay_url = 'https://relay.test';
    service.settingsChanged();
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ relayUrl: 'https://relay.test' }));
    expect(service.status()).toMatchObject({ relay: 'online', relayUrl: 'https://relay.test', error: null });
    service.stop();
  });
});

describe('RemoteService relay secret', () => {
  it('the QR carries the relay secret when one is set, and no such key otherwise', async () => {
    const client = new FakeClient();
    client.answers['/pair/token'] = { status: 200, body: { token: 'tok', expiresAt: NOW + 60_000 } };
    const factory = vi.fn<NonNullable<RemoteServiceOptions['clientFactory']>>(() => client as unknown as RelayClient);
    const { service, settings } = build(undefined, { clientFactory: factory });
    settings.remote_relay_secret = '  s3cret  ';
    service.settingsChanged();
    expect(factory).toHaveBeenLastCalledWith(expect.objectContaining({ relaySecret: 's3cret' }));
    const withSecret = await service.startPairing();
    expect('qr' in withSecret && JSON.parse(withSecret.qr)).toMatchObject({ relaySecret: 's3cret' });

    settings.remote_relay_secret = '';
    service.settingsChanged();
    const without = await service.startPairing();
    expect('qr' in without && JSON.parse(without.qr)).not.toHaveProperty('relaySecret');
    service.stop();
  });
  it('a refused secret is reported and leaves the relay off, until a settings change starts it again', () => {
    const { service, fake, settings, hub } = build();
    const publish = vi.spyOn(hub, 'publish');
    fake.stop();
    fake.emit('refused', 'bad_secret');
    expect(service.status()).toMatchObject({ relay: 'off', error: BAD_SECRET_ERROR });
    expect(publish).toHaveBeenLastCalledWith('remote', expect.objectContaining({ event: 'status', error: BAD_SECRET_ERROR }));

    settings.remote_relay_secret = 'new';
    service.settingsChanged();
    expect(service.status()).toMatchObject({ relay: 'online', error: null });
    service.stop();
  });
});

describe('RemoteService versions', () => {
  it('a relay too old is reported with both versions and offers no code, until the user tries again', async () => {
    const { service, fake } = build();
    const tooOld = { relayVersion: '0.0.1', needed: MIN_RELAY_VERSION };
    fake.stop();
    fake.emit('refused', 'relay_too_old', tooOld);
    expect(service.status()).toMatchObject({ relay: 'too_old', relayTooOld: tooOld, error: null });
    expect(await service.startPairing()).toEqual({ error: 'relay_too_old' });

    // "Try again" (POST /api/remote/restart) starts afresh.
    service.settingsChanged();
    expect(service.status()).toMatchObject({ relay: 'online', relayTooOld: null });
    service.stop();
  });

  it('knocks on a relay too old again by itself after RELAY_TOO_OLD_RECHECK_MS', () => {
    vi.useFakeTimers();
    try {
      const { service, fake } = build();
      fake.stop();
      fake.emit('refused', 'relay_too_old', { relayVersion: null, needed: MIN_RELAY_VERSION });
      vi.advanceTimersByTime(RELAY_TOO_OLD_RECHECK_MS - 1);
      expect(service.status()).toMatchObject({ relay: 'too_old', relayTooOld: { relayVersion: null } });
      vi.advanceTimersByTime(1);
      expect(service.status()).toMatchObject({ relay: 'online', relayTooOld: null });

      // A stop in between cancels the knock: a remote turned off stays off.
      fake.stop();
      fake.emit('refused', 'relay_too_old', { relayVersion: null, needed: MIN_RELAY_VERSION });
      service.stop();
      vi.advanceTimersByTime(RELAY_TOO_OLD_RECHECK_MS);
      expect(service.status()).toMatchObject({ relay: 'off' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks a phone refused for its app version, until it says hello with one that will do', () => {
    const phone = generateIdentity();
    const id = deviceId(phone.publicKey);
    const { fake, service, advance } = build((d) => d.add({
      id, name: 'iPhone', platform: 'ios', kind: 'phone', pairedAt: 1, notifications: parseNotificationSettings({}),
    }));
    const macKey = publicKeyOf(service.status().macId!)!;
    /** A fresh connection from the phone: handshake, then a hello naming `version`; answers what the Mac sent back. */
    const connectWith = (version: string): unknown[] => {
      fake.emit('control', { type: 'presence', peer: id, online: true });
      const hs = startHandshake(phone, macKey, 'initiator');
      const from = fake.sent.length;
      fake.emit('data', encodeFrame({ peer: phone.publicKey, flags: 0, wake: ZERO_WAKE, body: hs.message! }));
      const cipher = hs.complete(decodeFrame(fake.sent[from])!.body)!;
      const hello = encodeInner({ kind: 'json', value: { t: 'hello', protocol: PROTOCOL_VERSION, app: `orbital-mobile/${version}` } });
      fake.emit('data', encodeFrame({ peer: phone.publicKey, flags: 0, wake: ZERO_WAKE, body: cipher.seal(hello) }));
      return fake.sent.slice(from + 1).map((f) => {
        const inner = decodeInner(cipher.open(decodeFrame(f)!.body)!);
        return inner?.kind === 'json' ? inner.value : null;
      });
    };
    const device = () => service.status().devices.find((d) => d.id === id)!;

    expect(connectWith('0.0.1')).toEqual([{ t: 'bye', reason: 'protocol' }]);
    expect(device().needsUpdate).toEqual({ version: '0.0.1', needed: MIN_PHONE_VERSION, at: NOW });
    // Each refusal moves the time the list shows.
    advance(10 * 60_000);
    connectWith('0.0.1');
    expect(device().needsUpdate).toEqual({ version: '0.0.1', needed: MIN_PHONE_VERSION, at: NOW + 10 * 60_000 });
    expect(connectWith(MIN_PHONE_VERSION)).toMatchObject([{ t: 'hello' }]);
    expect(device().needsUpdate).toBeNull();
  });
});

describe('RemoteService identity', () => {
  it('a regenerated identity forgets every paired phone, with one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { devices, service } = build((d) => {
      for (const id of [phoneId(), phoneId()]) {
        d.add({ id, name: 'iPhone', platform: 'ios', kind: 'phone', pairedAt: 1, notifications: parseNotificationSettings({}) });
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
