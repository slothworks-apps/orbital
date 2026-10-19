import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateIdentity, deviceId, fromBase64Url, publicKeyOf, toBase64Url } from '@orbital/shared/remote/keys';
import { FLAG_STATE, FLAG_WAKE, WAKE_BYTES, ZERO_WAKE, decodeFrame, encodeFrame } from '@orbital/shared/remote/frame';
import { startHandshake } from '@orbital/shared/remote/handshake';
import {
  PAIRING_SECRET_BYTES, PAIRING_TOKEN_TTL_MS, PAIR_NAME_MAX_CHARS, QrPayload, pairingProof, sealPairingDevice,
} from '@orbital/shared/remote/relayApi';
import { NEEDS_INPUT_SETTLE_MS, parseNotificationSettings } from '@orbital/shared/notifications';
import { PROTOCOL_VERSION, decodeInner, encodeInner } from '@orbital/shared/remote/messages';
import { MIN_PHONE_VERSION, MIN_RELAY_VERSION } from '@orbital/shared/remote/version';
import { describeDevice, exitDigest, foundRoster, memberIds, nextRoster, type RosterState } from '@orbital/shared/remote/roster';
import { Hub } from '../src/api/hub.js';
import { openDb, type OrbitalDb } from '../src/db/database.js';
import { createImageStore } from '../src/images/store.js';
import { DeviceStore } from '../src/remote/devices.js';
import { RosterStore } from '../src/remote/rosterStore.js';
import { IDENTITY_FILE, readIdentity } from '../src/remote/identity.js';
import { RelayClient } from '../src/remote/relayClient.js';
import { PAIR_CODE_ATTEMPTS, UNKNOWN_PHONE_NAME } from '@orbital/shared/remote/ceremony';
import { MUTUAL_RETRY_MS } from '@orbital/shared/remote/group';
import { BAD_SECRET_ERROR, NO_RELAY_URL_ERROR } from '../src/remote/errors.js';
import { RELAY_TOO_OLD_RECHECK_MS, RemoteService, type RemoteServiceOptions } from '../src/remote/service.js';
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
  opts: {
    corruptIdentity?: boolean; clientFactory?: RemoteServiceOptions['clientFactory']; relayUrl?: string;
    groupPresence?: RemoteServiceOptions['groupPresence'];
  } = {},
) {
  const dir = makeTmpDir('remote-svc');
  const db = openDb(join(dir, 'index.db'));
  dirOf.set(db, dir);
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
    settings: {
      get: (k) => settings[k] ?? '',
      set: (k, v) => { settings[k] = v; },
    },
    allSettings: () => settings,
    now: () => now,
    clientFactory: opts.clientFactory ?? (() => fake as unknown as RelayClient),
    ...(opts.groupPresence ? { groupPresence: opts.groupPresence } : {}),
  });
  const startPairing = service.startPairing.bind(service);
  service.startPairing = async () => {
    const res = await startPairing();
    if ('qr' in res) qrSecret = fromBase64Url(QrPayload.parse(JSON.parse(res.qr)).secret);
    return res;
  };
  service.start();
  return { service, fake, hub, db, dir, devices, settings, advance: (ms: number) => { now += ms; } };
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
  it('a rename made while the remote is off reaches this device\'s description at the next start', () => {
    const { service, settings, db } = build();
    withMembers(db, {});
    service.nameChanged();
    const self = () => service.status().group.members.find((m) => m.self);
    const own = () => service.rosterState().descriptions.find((d) => d.id === service.status().macId);
    expect(self()).toMatchObject({ links: true, primary: true });
    settings.remote_enabled = 'false';
    service.settingsChanged();
    settings.remote_mac_name = 'renamed';
    service.nameChanged();
    settings.remote_enabled = 'true';
    service.settingsChanged();
    expect(self()).toMatchObject({ name: 'renamed' });
    expect(own()).toMatchObject({ name: 'renamed', by: service.status().macId });
  });

  it('a roster that cannot be written here is still answered with this side\'s own', () => {
    const peer = generateIdentity();
    const id = deviceId(peer.publicKey);
    const { fake, service, db } = build((d) => d.add({
      id, name: 'vps', platform: 'linux', kind: 'desktop', pairedAt: 1, notifications: parseNotificationSettings({}),
    }));
    // This device's group names the peer, whose empty roster lacks it.
    withMembers(db, { id, name: 'vps' }, {});
    const hs = startHandshake(peer, publicKeyOf(service.status().macId!)!, 'initiator');
    fake.emit('data', encodeFrame({ peer: peer.publicKey, flags: 0, wake: ZERO_WAKE, body: hs.message! }));
    const cipher = hs.complete(decodeFrame(fake.sent[0])!.body)!;
    const seal = (value: unknown) => encodeFrame({
      peer: peer.publicKey, flags: 0, wake: ZERO_WAKE, body: cipher.seal(encodeInner({ kind: 'json', value })),
    });
    const received = (from: number) => fake.sent.slice(from).map((f) => {
      const inner = decodeInner(cipher.open(decodeFrame(f)!.body)!);
      return inner?.kind === 'json' ? inner.value as { t: string } : null;
    });
    fake.emit('data', seal({ t: 'hello', protocol: PROTOCOL_VERSION, kind: 'desktop', name: 'vps', capabilities: ['group'] }));
    expect(service.channel(id)?.groups).toBe(true);
    const replace = vi.spyOn(RosterStore.prototype, 'replace').mockImplementation(() => { throw new Error('disk full'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const from = fake.sent.length;
    try {
      fake.emit('data', seal({ t: 'roster', roster: null, descriptions: [], left: [] }));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not take a roster'));
    } finally {
      replace.mockRestore();
      warn.mockRestore();
    }
    expect(received(from)).toContainEqual(expect.objectContaining({ t: 'roster' }));
  });
});

describe('RemoteService exits', () => {
  it('a removed member takes its grants along; another member keeps its own', async () => {
    const id = deviceId(generateIdentity().publicKey);
    const { service, db, settings } = build((d) => d.add({
      id, name: 'vps', platform: 'linux', kind: 'desktop', pairedAt: 1, notifications: parseNotificationSettings({}),
    }));
    withMembers(db, { id, name: 'vps' });
    settings.remote_grants = JSON.stringify({ [id]: { ide: true }, other: { manage: true } });
    expect(await service.remove(id)).toEqual({ ok: true });
    expect(JSON.parse(settings.remote_grants)).toEqual({ other: { manage: true } });
  });

  it('a member removed while asleep is served nothing when it comes back, only the version that ends its pair; its ack ends it', async () => {
    const peer = generateIdentity();
    const id = deviceId(peer.publicKey);
    const { fake, service, db, devices } = build((d) => d.add({
      id, name: 'vps', platform: 'linux', kind: 'desktop', pairedAt: 1, notifications: parseNotificationSettings({}),
    }));
    withMembers(db, { id, name: 'vps' });
    expect(await service.remove(id)).toEqual({ ok: true });
    // Asleep: nothing could reach it, so its pair stays.
    expect(devices.get(id)).not.toBeNull();
    expect(fake.posts.filter((p) => p.path === '/pair/revoke')).toEqual([]);
    const hs = startHandshake(peer, publicKeyOf(service.status().macId!)!, 'initiator');
    fake.emit('data', encodeFrame({ peer: peer.publicKey, flags: 0, wake: ZERO_WAKE, body: hs.message! }));
    const cipher = hs.complete(decodeFrame(fake.sent[0])!.body)!;
    const seal = (value: unknown) => encodeFrame({
      peer: peer.publicKey, flags: 0, wake: ZERO_WAKE, body: cipher.seal(encodeInner({ kind: 'json', value })),
    });
    const received = (from: number) => fake.sent.slice(from).map((f) => {
      const inner = decodeInner(cipher.open(decodeFrame(f)!.body)!);
      return inner?.kind === 'json' ? inner.value as { t: string; [k: string]: unknown } : null;
    });
    const from = fake.sent.length;
    fake.emit('data', seal({ t: 'hello', protocol: PROTOCOL_VERSION, kind: 'desktop', name: 'vps', capabilities: ['group', 'sessions'] }));
    fake.emit('data', seal({ t: 'http', id: 1, method: 'GET', path: '/api/sessions' }));
    fake.emit('data', seal({ t: 'ws', type: 'subscribe', topic: 'sessions' }));
    await tick();
    const got = received(from).filter((m) => m && m.t !== 'hello');
    const ending = got.find((m) => m?.t === 'roster') as unknown as RosterState;
    expect(ending.roster).toMatchObject({ version: 2 });
    expect(got).toContainEqual({ t: 'http_res', id: 1, status: 403, body: { error: 'not_in_group' } });
    expect(got.some((m) => m?.t === 'ws')).toBe(false);
    // It acknowledges the version: only now does its pair end.
    fake.emit('data', seal({ t: 'roster_ack', digest: exitDigest(ending) }));
    await tick();
    expect(devices.get(id)).toBeNull();
    expect(fake.posts.filter((p) => p.path === '/pair/revoke').map((p) => p.payload)).toEqual([{ phone: id }]);
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
    expect(service.status().pendingPair).toEqual({
      phone, name: 'iPhone', platform: 'ios', kind: 'phone', attemptsLeft: PAIR_CODE_ATTEMPTS, manager: { by: 'here', newGroup: true },
    });
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

/** Where each test's service keeps its identity, by its database. */
const dirOf = new WeakMap<OrbitalDb, string>();

type MemberSpec = { id?: string; kind?: string; name?: string; os?: string; links?: boolean; removedAt?: number };

/**
 * Members written straight into the store: this device, the primary, signs
 * the next version naming them, each described by itself as given. One with
 * `removedAt` was removed already: no version names it. No link is asked yet.
 */
function withMembers(db: OrbitalDb, ...specs: MemberSpec[]): string[] {
  const store = new RosterStore(db);
  const self = readIdentity(dirOf.get(db)!)!;
  const ids = specs.map((e) => e.id ?? phoneId());
  const live = specs.map((e, i) => ({ ...e, id: ids[i] })).filter((e) => e.removedAt === undefined);
  const held = store.read();
  const add = live.map((e) => ({ id: e.id, kind: e.kind ?? 'desktop' }));
  const roster = held.roster ? nextRoster(held.roster, self, { add }, NOW)! : foundRoster(self, 'desktop', add, NOW)!;
  const descriptions = live.map((e) => describeDevice(e.id, {
    name: e.name ?? 'peer', os: e.os ?? 'linux', links: e.links ?? true,
  }, self, NOW));
  const next: RosterState = { roster, descriptions: [...held.descriptions, ...descriptions], left: [] };
  store.replace(next);
  return ids;
}

/** The relay connection drops and comes back: a new connection, and its `ok`. */
function reconnect(fake: FakeClient): void {
  fake.status = 'connecting';
  fake.emit('status', 'connecting');
  fake.status = 'online';
  fake.emit('status', 'online');
  fake.emit('control', { type: 'ok', peers: [] });
}

describe('RemoteService mutual pairs', () => {
  const asked = (fake: FakeClient) => fake.posts.filter((p) => p.path === '/pair/mutual').map((p) => (p.payload as { peer: string }).peer);

  it('asks once per relay connection for each live member that links, paired here or not', async () => {
    const { service, fake, db, devices, settings } = build();
    const paired = phoneId();
    devices.add({ id: paired, name: 'p', platform: 'linux', kind: 'desktop', pairedAt: NOW, notifications: parseNotificationSettings({}) });
    const [server] = withMembers(db, {}, { kind: 'phone', links: false }, { removedAt: NOW }, { id: paired });
    reconnect(fake);
    await tick();
    expect(asked(fake).sort()).toEqual([paired, server].sort());
    reconnect(fake);
    await tick();
    expect(asked(fake).sort()).toEqual([paired, paired, server, server].sort());
    // Between two connections a roster change asks only for whom is not paired and not asked yet.
    fake.answers['/pair/mutual'] = { status: 500, body: {} };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reconnect(fake);
    await tick();
    settings.remote_mac_name = 'renamed';
    service.nameChanged();
    await tick();
    warn.mockRestore();
    expect(asked(fake).filter((id) => id === paired)).toHaveLength(3);
    expect(asked(fake).filter((id) => id === server)).toHaveLength(4);
  });

  it('a relay that repeats ok on one connection is asked nothing more', async () => {
    const { fake, db, service } = build();
    const [server] = withMembers(db, {});
    const [gone] = withMembers(db, {});
    await service.remove(gone);
    fake.answers['/pair/revoke'] = { status: 500, body: {} };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reconnect(fake);
    await tick();
    const posts = fake.posts.length;
    for (let i = 0; i < 5; i++) fake.emit('control', { type: 'ok', peers: [] });
    await tick();
    warn.mockRestore();
    expect(fake.posts).toHaveLength(posts);
    expect(asked(fake)).toContain(server);
  });

  it('a paired member whose pair the relay lost is asked again at the next ok, and linked again', async () => {
    const { service, fake, db, devices } = build();
    const [server] = withMembers(db, {});
    fake.answers['/pair/mutual'] = { status: 200, body: { linked: true } };
    reconnect(fake);
    await tick();
    expect(devices.get(server)).not.toBeNull();
    // The relay lost the pair (the other side revoked it while this one was away): this row stays.
    fake.answers['/pair/mutual'] = { status: 200, body: { linked: false } };
    reconnect(fake);
    await tick();
    expect(asked(fake)).toEqual([server, server]);
    // The other side's half arrives: the relay says `linked`, and the row is the same one.
    fake.emit('control', { type: 'linked', peer: server });
    expect(service.status().devices.map((d) => d.id)).toEqual([server]);
  });

  it('a rate-limited ask is asked again after MUTUAL_RETRY_MS; a stopped remote asks nothing', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { service, fake, db } = build();
      const [server] = withMembers(db, {});
      fake.answers['/pair/mutual'] = { status: 429, body: {} };
      reconnect(fake);
      await vi.advanceTimersByTimeAsync(0);
      expect(asked(fake)).toEqual([server]);
      await vi.advanceTimersByTimeAsync(MUTUAL_RETRY_MS - 1);
      expect(asked(fake)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(asked(fake)).toEqual([server, server]);
      // Limited again, then the remote stops: the retry goes with it.
      service.stop();
      await vi.advanceTimersByTimeAsync(MUTUAL_RETRY_MS * 2);
      expect(asked(fake)).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('a relay without the route marks the member pair-by-hand until the next ok; a relay error is asked again, a refusal is not', async () => {
    const { service, fake, db, settings } = build();
    const [server] = withMembers(db, {});
    const member = () => service.status().group.members.find((m) => m.id === server);
    fake.answers['/pair/mutual'] = { status: 404, body: {} };
    reconnect(fake);
    await tick();
    expect(member()).toMatchObject({ pairByHand: true });
    fake.answers['/pair/mutual'] = { status: 500, body: {} };
    reconnect(fake);
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
    reconnect(fake);
    await tick();
    settings.remote_mac_name = 'renamed again';
    service.nameChanged();
    await tick();
    expect(asked(fake)).toHaveLength(4);
  });

  it('a linked member the roster holds live becomes a paired device once; any other id is ignored', async () => {
    const { service, fake, db } = build();
    const [server] = withMembers(db, { name: 'vps', os: 'linux' });
    const [removed] = withMembers(db, { removedAt: NOW });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unknown = phoneId();
    fake.emit('control', { type: 'linked', peer: unknown });
    fake.emit('control', { type: 'linked', peer: removed });
    warn.mockRestore();
    expect(service.status().devices).toEqual([]);
    // A device the group does not name is not left half linked: its pair goes at once.
    expect(fake.posts.filter((p) => p.path === '/pair/revoke').map((p) => (p.payload as { phone: string }).phone))
      .toEqual([unknown, removed]);
    // Both the post's answer and the control say so; the device is added once.
    fake.answers['/pair/mutual'] = { status: 200, body: { linked: true } };
    reconnect(fake);
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
    expect(service.status().joining).toMatchObject({ device: other, name: long.slice(0, PAIR_NAME_MAX_CHARS) });
    fake.emit('control', { type: 'paired', mac: other });
    expect(service.status().devices).toEqual([expect.objectContaining({ id: other, name: long.slice(0, PAIR_NAME_MAX_CHARS) })]);
  });
});

describe('RemoteService join and the group', () => {
  const redeems = (fake: FakeClient) => fake.posts.filter((p) => p.path === '/pair/redeem');
  /** A code another device shows, on this service's relay unless named otherwise. */
  const codeFrom = (over: Partial<QrPayload> = {}) => {
    const qr: QrPayload = {
      v: 1, relay: 'https://relay.test', mac: phoneId(), name: 'studio', token: 'tok',
      secret: toBase64Url(new Uint8Array(PAIRING_SECRET_BYTES)), kind: 'desktop', expiresAt: NOW + 90_000, group: true, ...over,
    };
    return JSON.stringify(qr);
  };

  it('refuses to join another group while this device is in one', async () => {
    const { service, fake, db } = build();
    withMembers(db, {});
    expect(await service.join(codeFrom())).toEqual({ error: 'in_group' });
    expect(redeems(fake)).toHaveLength(0);
    expect(service.status().joining).toBeNull();
  });

  it('a phone paired here makes no group: the relay stays open and a join goes ahead', async () => {
    const { service, devices, db } = build();
    const [phone] = withMembers(db, { kind: 'phone', links: false });
    devices.add({ id: phone, name: 'iPhone', platform: 'ios', kind: 'phone', pairedAt: NOW, notifications: parseNotificationSettings({}) });
    expect(service.inGroup()).toBe(false);
    expect(service.status().group.relayLocked).toBe(false);
    expect(await service.join(codeFrom())).toMatchObject({ code: expect.any(String) });
  });

  it('a member that links makes a group even when it is paired here', async () => {
    const { service, devices, db } = build();
    const [desktop] = withMembers(db, {});
    devices.add({ id: desktop, name: 'studio', platform: 'linux', kind: 'desktop', pairedAt: NOW, notifications: parseNotificationSettings({}) });
    expect(service.status().group.relayLocked).toBe(true);
    expect(await service.join(codeFrom())).toEqual({ error: 'in_group' });
  });

  it('a phone paired with another member makes a group; a removed member does not', async () => {
    const { service, db } = build();
    const [phone] = withMembers(db, { kind: 'phone', links: false });
    expect(await service.join(codeFrom())).toEqual({ error: 'in_group' });
    await service.remove(phone);
    expect(await service.join(codeFrom())).toMatchObject({ code: expect.any(String) });
  });

  it('a member of this device\'s own group may still be paired by hand; a stranger\'s code is refused', async () => {
    const { service, fake, db } = build();
    const [member] = withMembers(db, {});
    expect(await service.join(codeFrom())).toEqual({ error: 'in_group' });
    expect(await service.join(codeFrom({ mac: member }))).toMatchObject({ device: member, code: expect.any(String) });
    expect(redeems(fake)).toHaveLength(1);
  });

  it('a join whose code ran out before the primary\'s roster came is dropped, and the status says so until read', async () => {
    const { service, fake, advance } = build();
    const joined = await service.join(codeFrom({ group: undefined }));
    if (!('device' in joined)) throw new Error('join failed');
    fake.emit('control', { type: 'paired', mac: joined.device });
    expect(service.status().group).toMatchObject({ pendingJoin: { primary: joined.device }, joinExpired: null });
    advance(90_000);
    expect(service.status().group).toMatchObject({
      pendingJoin: null, joinExpired: { id: joined.device, name: 'studio' },
    });
    // The pair made for the join ended, here and at the relay, as a cancel's does.
    expect(service.status().devices.map((d) => d.id)).not.toContain(joined.device);
    await tick();
    expect(fake.posts.filter((p) => p.path === '/pair/revoke').map((p) => p.payload)).toEqual([{ phone: joined.device }]);
    service.acknowledgeExpiredJoin();
    expect(service.status().group.joinExpired).toBeNull();
    // So pairing with that primary again works: a new code from it is redeemed, not refused as already paired.
    const again = await service.join(codeFrom({ mac: joined.device, group: undefined, expiresAt: NOW + 200_000 }));
    expect(again).toMatchObject({ device: joined.device, code: expect.any(String) });
    fake.emit('control', { type: 'paired', mac: joined.device });
    expect(service.status().group.pendingJoin).toMatchObject({ primary: joined.device });
    expect(service.status().devices.map((d) => d.id)).toContain(joined.device);
  });

  it('a join under way shows in the status, blocks a code of its own, and is cancelled by cancelJoin', async () => {
    const { service, fake } = build();
    const joined = await service.join(codeFrom({ group: undefined }));
    if (!('device' in joined)) throw new Error('join failed');
    fake.emit('control', { type: 'paired', mac: joined.device });
    expect(service.status().group.pendingJoin).toEqual({ primary: joined.device, expiresAt: NOW + 90_000 });
    expect(await service.startPairing()).toEqual({ error: 'joining' });
    expect(service.cancelJoin()).toBe(true);
    expect(service.status().group.pendingJoin).toBeNull();
    // Given up by the user, not by the clock: no card says it was dropped.
    expect(service.status().group.joinExpired).toBeNull();
    await tick();
    expect(fake.posts.filter((p) => p.path === '/pair/revoke').map((p) => p.payload)).toEqual([{ phone: joined.device }]);
    expect(service.cancelJoin()).toBe(false);
  });

  it('no code waits longer than PAIRING_TOKEN_TTL_MS, whatever it says', async () => {
    const { service } = build();
    await service.join(codeFrom({ expiresAt: NOW + PAIRING_TOKEN_TTL_MS * 10 }));
    expect(service.status().joining?.expiresAt).toBe(NOW + PAIRING_TOKEN_TTL_MS);
    service.cancelJoin();
    await service.join(codeFrom({ expiresAt: undefined }));
    expect(service.status().joining?.expiresAt).toBe(NOW + PAIRING_TOKEN_TTL_MS);
  });

  it('a join confirmed on the other device after it was cancelled here is revoked, and the device never added', async () => {
    const { service, fake, db, devices, advance } = build();
    const revoked = () => fake.posts.filter((p) => p.path === '/pair/revoke').map((p) => (p.payload as { phone: string }).phone);
    const first = await service.join(codeFrom());
    if (!('device' in first)) throw new Error('join failed');
    service.cancelJoin();
    fake.emit('control', { type: 'paired', mac: first.device });
    await tick();
    expect(revoked()).toEqual([first.device]);
    expect(devices.get(first.device)).toBeNull();
    expect(memberIds(new RosterStore(db).read())).not.toContain(first.device);
    // Once the code has expired, nothing is left to revoke.
    const second = await service.join(codeFrom());
    if (!('device' in second)) throw new Error('join failed');
    service.cancelJoin();
    advance(90_000);
    fake.emit('control', { type: 'paired', mac: second.device });
    await tick();
    expect(revoked()).toEqual([first.device]);
    expect(devices.get(second.device)).toBeNull();
  });

  it('names the code relay when it is another one, and the code expiry when the member is offline', async () => {
    const { service, fake } = build();
    expect(await service.join(codeFrom({ relay: 'https://relay.lab.internal' })))
      .toEqual({ error: 'other_relay', relay: 'https://relay.lab.internal' });
    expect(redeems(fake)).toHaveLength(0);
    fake.answers['/pair/redeem'] = { status: 409, body: {} };
    expect(await service.join(codeFrom())).toEqual({ error: 'peer_offline', expiresAt: NOW + 90_000 });
    // A code from before it carried its expiry.
    expect(await service.join(codeFrom({ expiresAt: undefined }))).toEqual({ error: 'peer_offline' });
    expect(service.status().joining).toBeNull();
  });

  it('the waiting join carries the code to type, the code\'s expiry and the kind it named', async () => {
    const { service } = build();
    const code = codeFrom();
    const res = await service.join(code);
    if (!('code' in res)) throw new Error('join failed');
    expect(service.status().joining).toEqual({
      device: res.device, name: 'studio', kind: 'desktop', code: res.code, expiresAt: NOW + 90_000,
      manager: { by: 'there', newGroup: false },
    });
  });

  it('cancels a join', async () => {
    const { service, hub } = build();
    await service.join(codeFrom());
    expect(service.status().joining).not.toBeNull();
    const published = vi.spyOn(hub, 'publish');
    expect(service.cancelJoin()).toBe(true);
    expect(service.status().joining).toBeNull();
    expect(published).toHaveBeenCalledWith('remote', expect.objectContaining({ event: 'status', joining: null }));
    published.mockRestore();
    expect(service.cancelJoin()).toBe(false);
  });

  it('derives each member display state', async () => {
    const { service, fake, db, devices } = build();
    const add = (id: string) => devices.add({
      id, name: 'm', platform: 'linux', kind: 'desktop', pairedAt: NOW, notifications: parseNotificationSettings({}),
    });
    const [byHand] = withMembers(db, {});
    // The relay has no `/pair/mutual`: the member asked at this `ok` can only be paired by hand.
    fake.answers['/pair/mutual'] = { status: 404, body: {} };
    reconnect(fake);
    await tick();
    const [rowOnline, rowOffline, linking, phoneOnline, phoneOffline, removed] = withMembers(
      db, {}, {}, {}, { kind: 'phone', links: false }, { kind: 'phone', links: false }, { removedAt: NOW },
    );
    add(rowOnline);
    add(rowOffline);
    devices.touch(rowOffline, NOW - 5_000);
    fake.peersOnline.add(rowOnline);
    fake.peersOnline.add(phoneOnline);
    const { members, relayLocked } = service.status().group;
    const states = Object.fromEntries(members.map((m) => [m.id, { state: m.state, seenAt: m.seenAt }]));
    expect(states).toEqual({
      [service.status().macId!]: { state: 'self', seenAt: null },
      [byHand]: { state: 'notLinked', seenAt: null },
      [rowOnline]: { state: 'online', seenAt: null },
      [rowOffline]: { state: 'offline', seenAt: NOW - 5_000 },
      [linking]: { state: 'linking', seenAt: null },
      [phoneOnline]: { state: 'online', seenAt: null },
      [phoneOffline]: { state: 'offline', seenAt: null },
    });
    expect(members.some((m) => m.id === removed)).toBe(false);
    expect(relayLocked).toBe(true);
  });

  it('the relay is locked only while another member is live', () => {
    const { service, db } = build();
    expect(service.status().group.relayLocked).toBe(false);
    const [other] = withMembers(db, { removedAt: NOW });
    expect(other).toBeDefined();
    expect(service.status().group.relayLocked).toBe(false);
    withMembers(db, {});
    expect(service.status().group.relayLocked).toBe(true);
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

  it('a Mac from before groups founds its group with its phone; removing it signs a version without it, and the device goes even when the relay revoke fails', async () => {
    const phone = phoneId();
    const { service, fake, db, devices } = build((d) => d.add({
      id: phone, name: 'iPhone', platform: 'ios', kind: 'phone', pairedAt: 1, notifications: parseNotificationSettings({}),
    }));
    expect(service.status().group).toMatchObject({ isPrimary: true, primary: { id: service.status().macId } });
    expect(service.status().group.members.find((m) => m.id === phone)).toMatchObject({ kind: 'phone', name: 'iPhone', os: 'ios', links: false });
    fake.answers['/pair/revoke'] = { status: 0, body: { error: 'network' } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await service.remove(phone)).toEqual({ ok: true });
    warn.mockRestore();
    expect(devices.get(phone)).toBeNull();
    expect(fake.posts.map((p) => p.path)).toEqual(['/pair/revoke']);
    expect(new RosterStore(db).read().roster).toMatchObject({ version: 2 });
    expect(memberIds(new RosterStore(db).read())).not.toContain(phone);
    expect(service.status().group.members.some((m) => m.id === phone)).toBe(false);
  });

  it('a live member with no pair here is removed and still revoked at the relay, which drops a waiting half', async () => {
    const { service, fake, db } = build();
    const [member] = withMembers(db, {});
    expect(await service.remove(member)).toEqual({ ok: true });
    expect(revoked(fake)).toEqual([member]);
    expect(memberIds(new RosterStore(db).read())).not.toContain(member);
  });

  it('is false for an id neither in the roster nor paired, and for a member already removed', async () => {
    const { service, fake, db } = build();
    const [removed] = withMembers(db, { removedAt: NOW });
    expect(await service.remove(phoneId())).toEqual({ error: 'not_found' });
    expect(await service.remove(removed)).toEqual({ error: 'not_found' });
    expect(revoked(fake)).toEqual([]);
  });

  it('the primary leaving dissolves the group: pairs that cannot hear it end at once, and it holds no roster', async () => {
    const paired = [phoneId(), phoneId()];
    const { service, fake, db, devices } = build((d) => {
      for (const id of paired) {
        d.add({ id, name: 'p', platform: 'ios', kind: 'phone', pairedAt: 1, notifications: parseNotificationSettings({}) });
      }
    });
    // The second is a member that links and is not paired here: its waiting half goes too.
    const [, unpaired] = withMembers(db, { id: paired[0], kind: 'phone', links: false }, {});
    const self = service.status().macId!;
    expect(await service.leave()).toEqual({ ok: true });
    expect(revoked(fake).sort()).toEqual([...paired, unpaired].sort());
    expect(devices.list()).toEqual([]);
    expect(service.status().group).toMatchObject({
      members: [expect.objectContaining({ id: self, self: true, primary: false })], primary: null, isPrimary: false,
    });
    expect(service.rosterState().roster).toBeNull();
  });

  it('leave while the relay is not online is refused and changes nothing', async () => {
    const phone = phoneId();
    const { service, fake, db, devices } = build((d) => d.add({
      id: phone, name: 'iPhone', platform: 'ios', kind: 'phone', pairedAt: 1, notifications: parseNotificationSettings({}),
    }));
    withMembers(db, {});
    fake.status = 'connecting';
    const before = service.rosterDigest();
    expect(await service.leave()).toEqual({ error: 'offline' });
    expect(service.rosterDigest()).toBe(before);
    expect(devices.get(phone)).not.toBeNull();
    expect(fake.posts).toEqual([]);
  });

  it('removing this device\'s own id is leaving: refused while the relay is not online, with the remote on or off', async () => {
    const phone = phoneId();
    const { service, fake, db, devices, settings } = build((d) => d.add({
      id: phone, name: 'iPhone', platform: 'ios', kind: 'phone', pairedAt: 1, notifications: parseNotificationSettings({}),
    }));
    withMembers(db, {});
    const self = service.status().macId!;
    const before = service.rosterDigest();
    fake.status = 'connecting';
    expect(await service.remove(self)).toEqual({ error: 'offline' });
    settings.remote_enabled = 'false';
    service.settingsChanged();
    expect(await service.remove(self)).toEqual({ error: 'offline' });
    expect(service.rosterDigest()).toBe(before);
    expect(devices.get(phone)).not.toBeNull();
    expect(fake.posts).toEqual([]);
  });

  it('removing this device\'s own id online leaves the group, as leave does', async () => {
    const { service, fake, db } = build();
    const [member] = withMembers(db, {});
    const self = service.status().macId!;
    expect(await service.remove(self)).toEqual({ ok: true });
    expect(revoked(fake)).toEqual([member]);
    expect(service.status().group.members).toEqual([expect.objectContaining({ id: self, self: true })]);
  });

  it('leave answers failed when the roster cannot be written', async () => {
    const { service, db } = build();
    withMembers(db, {});
    const replace = vi.spyOn(RosterStore.prototype, 'replace').mockImplementation(() => { throw new Error('disk full'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await service.leave()).toEqual({ error: 'failed' });
    } finally {
      replace.mockRestore();
      warn.mockRestore();
    }
  });

  it('a removal made while the relay is offline is revoked at the next ok, until the relay answers it', async () => {
    const { service, fake, db, settings } = build();
    const [member] = withMembers(db, {});
    settings.remote_enabled = 'false';
    service.settingsChanged();
    expect(await service.remove(member)).toEqual({ ok: true });
    settings.remote_enabled = 'true';
    service.settingsChanged();
    expect(revoked(fake)).toEqual([]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fake.answers['/pair/revoke'] = { status: 500, body: {} };
    reconnect(fake);
    await tick();
    warn.mockRestore();
    expect(revoked(fake)).toEqual([member]);
    // Not answered: still waiting. A 404 answers it — the relay had no such pair.
    fake.answers['/pair/revoke'] = { status: 404, body: {} };
    reconnect(fake);
    await tick();
    expect(revoked(fake)).toEqual([member, member]);
    reconnect(fake);
    await tick();
    expect(revoked(fake)).toEqual([member, member]);
  });

  it('a device paired afresh drops a revoke still waiting for it', async () => {
    const { service, fake, db, settings } = build();
    const [member] = withMembers(db, {});
    settings.remote_enabled = 'false';
    service.settingsChanged();
    await service.remove(member);
    settings.remote_enabled = 'true';
    service.settingsChanged();
    // Added again through a ceremony, at the next version, before the relay heard of the removal.
    withMembers(db, { id: member });
    expect(memberIds(new RosterStore(db).read())).toContain(member);
    fake.emit('control', { type: 'linked', peer: member });
    reconnect(fake);
    await tick();
    expect(revoked(fake)).toEqual([]);
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
    vi.useFakeTimers();
    try {
      hub.publish('sessions', { event: 'upsert', session: { id: 's1', title: 'one', status: 'working' } });
      hub.publish('sessions', { event: 'status', sessionId: 's1', status: 'needs_input' });
      // A stop wakes the phone only once it has settled.
      expect(fake.sent).toHaveLength(0);
      vi.advanceTimersByTime(NEEDS_INPUT_SETTLE_MS);
    } finally {
      vi.useRealTimers();
    }
    expect(fake.sent).toHaveLength(1);
    const frame = decodeFrame(fake.sent[0])!;
    expect(deviceId(frame.peer)).toBe(deviceId(phone.publicKey));
    expect(frame.flags).toBe(FLAG_WAKE | FLAG_STATE);
    expect(frame.wake).toHaveLength(WAKE_BYTES);
    expect(frame.wake.some((b) => b !== 0)).toBe(true);
    expect(frame.body).toHaveLength(0);
  });

  it('no wake while the user is at another member of the group', async () => {
    const phone = generateIdentity();
    let elsewhere = true;
    const { fake, hub } = build((d) => d.add({
      id: deviceId(phone.publicKey), name: 'iPhone', platform: 'ios', kind: 'phone', pairedAt: 1, notifications: parseNotificationSettings({ notify_needs_input: 'true' }),
    }), { groupPresence: () => elsewhere });
    await tick();
    vi.useFakeTimers();
    try {
      hub.publish('sessions', { event: 'upsert', session: { id: 's1', title: 'one', status: 'working' } });
      hub.publish('sessions', { event: 'status', sessionId: 's1', status: 'needs_input' });
      vi.advanceTimersByTime(NEEDS_INPUT_SETTLE_MS);
      expect(fake.sent).toHaveLength(0);
      elsewhere = false;
      hub.publish('sessions', { event: 'status', sessionId: 's1', status: 'working' });
      hub.publish('sessions', { event: 'status', sessionId: 's1', status: 'needs_input' });
      vi.advanceTimersByTime(NEEDS_INPUT_SETTLE_MS);
    } finally {
      vi.useRealTimers();
    }
    expect(fake.sent).toHaveLength(1);
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
