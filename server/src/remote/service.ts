/**
 * The Mac side of the mobile remote, assembled: identity, the relay
 * connection, pairing, one `DeviceWatcher` per paired phone (alive while the
 * service runs) and one `Channel` per connected device (alive per
 * connection). Off is the default and off means nothing here is constructed
 * (spec 2026-09-30-mobile-remote-design § 3).
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  deviceId, fingerprint, formatFingerprint, fromBase64Url, normalizePairingCode, publicKeyOf, toBase64Url,
  type Identity,
} from '@orbital/shared/remote/keys';
import { FLAG_STATE, FLAG_WAKE, ZERO_WAKE, decodeFrame, encodeFrame } from '@orbital/shared/remote/frame';
import {
  PAIRING_SECRET_BYTES, PAIRING_TOKEN_TTL_MS, PAIR_NAME_MAX_CHARS, openPairingDevice, pairingProof, parsePairingCode, sealPairingDevice,
  verifyPairingProof, type QrPayload, type RelayToDevice,
} from '@orbital/shared/remote/relayApi';
import { initiates, osName } from '@orbital/shared/remote/device';
import type { Role } from '@orbital/shared/remote/handshake';
import { parseNotificationSettings } from '@orbital/shared/notifications';
import type { Channel } from '@orbital/shared/remote/channel';
import type { GroupMessage, HelloMessage } from '@orbital/shared/remote/messages';
import {
  addMember, describeMember, isLive, mergeRosters, removeMember, rosterDigest, type RosterEntry,
} from '@orbital/shared/remote/roster';
import type { RelayTooOld } from '@orbital/shared/remote/version';
import type { Hub } from '../api/hub.js';
import { CONFIG } from '../config.js';
import type { OrbitalDb } from '../db/database.js';
import type { ImageStore } from '../images/store.js';
import { DeviceStore, type RemoteDevice } from './devices.js';
import { DeviceWatcher } from './deviceWatcher.js';
import { loadOrCreateIdentity, macDisplayName, readIdentity, serverDeviceKind, serverHello } from './identity.js';
import { createPhoneFileReader, type PhoneFileReader } from './phoneFiles.js';
import { RosterStore } from './rosterStore.js';
import type { WorkingTrees } from '../git/workingTrees.js';
import { openDeviceChannel, type PhoneTooOld } from './deviceChannel.js';
import type { InjectFn } from './servingHalf.js';
import { RelayClient, type RelayClientOptions, type RelayRefusal } from './relayClient.js';
import { wakeSecret, wakeToken } from './wake.js';
import type { Presence } from './presence.js';

/** A phone refused at `hello` for an app too old: both versions, and when it was last refused. */
export type PhoneRefusal = PhoneTooOld & { at: number };

/**
 * How long a relay refused as too old is left alone before the Mac knocks
 * again by itself. Whoever runs the relay updates it out of the Mac's sight,
 * so the Mac comes back on its own (canvas 11b); "Try again" checks at once.
 */
export const RELAY_TOO_OLD_RECHECK_MS = 5 * 60_000;

/**
 * Wrong pairing codes a request may be sent before it is rejected as if the
 * user had pressed Reject: enough for a typo, too few to guess 30 bits
 * (spec 2026-10-06-pairing-code-and-app-lock-design § 1).
 */
export const PAIR_CODE_ATTEMPTS = 3;

/**
 * What a phone is called whose name did not come sealed with its request:
 * a phone from before sealed devices, or a blob that does not open. It never
 * blocks the pairing — the code typed here is what authenticates (spec
 * 2026-10-08-relay-knows-no-names-design § 3).
 */
export const UNKNOWN_PHONE_NAME = 'Unknown phone';

/**
 * The answer to a pairing request. `no_pending`: nothing to answer, or a
 * different phone than the one asked about. `code_mismatch`: a wrong code,
 * the request still waits. `code_rejected`: the last wrong code, the request
 * was rejected. `relay_error`: the relay did not take the answer.
 */
export type PairConfirmResult =
  | { ok: true }
  | { error: 'no_pending' | 'code_rejected' | 'relay_error' }
  | { error: 'code_mismatch'; attemptsLeft: number };

/**
 * The answer to joining another device by its code: that device and the
 * code the user types on it, or why not. `peer_offline`: the device that
 * showed the code is not on the relay. `other_relay`: the code names a
 * relay this server is not on.
 */
export type JoinResult =
  | { device: string; name: string; code: string }
  | { error: 'bad_code' | 'disabled' | 'offline' | 'already_paired' | 'other_relay' | 'peer_offline' | 'relay_error' | 'relay_too_old' };

export type RemoteStatus = {
  enabled: boolean;
  /**
   * `too_old`: the relay is below `MIN_RELAY_VERSION`; the remote stays down
   * until the user tries again or `RELAY_TOO_OLD_RECHECK_MS` passes.
   */
  relay: 'off' | 'connecting' | 'online' | 'too_old';
  /** Both versions while `relay` is `too_old` (`relayVersion` null: the relay announced none); null otherwise. */
  relayTooOld: RelayTooOld | null;
  /** The relay client's consecutive failed connection attempts; 0 with no client. */
  relayAttempts: number;
  relayUrl: string;
  macId: string | null;
  macName: string;
  /**
   * `needsUpdate`: this Mac refused the phone's app as below
   * `MIN_PHONE_VERSION` when it last connected, and when (`at`, epoch ms);
   * null once it connects with a version that will do (or before it has
   * said hello since the Mac started).
   */
  devices: (RemoteDevice & { online: boolean; needsUpdate: PhoneRefusal | null })[];
  /**
   * A phone asking to pair, and how many wrong codes it may still be sent
   * before it is rejected. The code itself never leaves the server: the
   * user types it from the phone and the server compares (spec
   * 2026-10-06-pairing-code-and-app-lock-design § 1).
   */
  pendingPair: { phone: string; name: string; platform: string; kind: string; attemptsLeft: number } | null;
  pairing: { expiresAt: number } | null;
  /** A device whose code this server redeemed and which has not confirmed yet. */
  joining: { device: string; name: string } | null;
  /** Why the last `start` failed; null while it is fine. */
  error: string | null;
  /**
   * The group's roster (spec 2026-10-16-device-group-design § 2), removed
   * entries included. `self`: this device; `linked`: paired with this device
   * directly; `online`: on the relay as this device sees it; `pairByHand`:
   * the relay has no `/pair/mutual`, so only a pairing code links the two.
   */
  group: { members: (RosterEntry & { self: boolean; linked: boolean; online: boolean; pairByHand: boolean })[] };
};

/**
 * A failed start's reason while `remote_relay_url` is empty: there is no
 * default relay, every Mac names its own.
 */
export const NO_RELAY_URL_ERROR = 'no relay URL — set one under Advanced';

/**
 * Why the remote stopped after the relay closed with `CLOSE_BAD_SECRET`: the
 * client does not retry, since only the user can change the secret.
 */
export const BAD_SECRET_ERROR = 'The relay refused the relay secret. Check it under Advanced.';

export type RemoteServiceOptions = {
  db: OrbitalDb;
  hub: Hub;
  dataDir: string;
  images: ImageStore;
  imagesDir: string;
  /**
   * A session's transcript file, under its own Claude directory's
   * `projects/`, for `file_get`'s named-path check. The server passes its
   * own; tests that never read a file leave it at the configured directory.
   */
  transcriptPath?: (sessionId: string, projectDir: string, claudeDirId: number) => string;
  /** Where each session works now, for `file_get`'s `cwd`; without it the home alone confines. */
  trees?: Pick<WorkingTrees, 'sandboxes'>;
  serverVersion: string;
  inject: InjectFn;
  settings: { get(key: string): string };
  allSettings: () => Record<string, string>;
  now?: () => number;
  /** Whether the user is at the Mac; absent, they never are (spec 2026-10-15-the-phone-is-quiet-while-you-are-at-the-mac-design). */
  presence?: Pick<Presence, 'atMac'>;
  clientFactory?: (opts: RelayClientOptions) => RelayClient;
};

export class RemoteService {
  private identity: Identity | null = null;
  private client: RelayClient | null = null;
  private readonly devices: DeviceStore;
  private readonly roster: RosterStore;
  private readonly watchers = new Map<string, DeviceWatcher>();
  private readonly channels = new Map<string, Channel>();
  /** `code` is the fingerprint the phone shows; `attemptsLeft` counts down in place, so the object stays the one a confirm in flight compares against. */
  private pendingPair: (NonNullable<RemoteStatus['pendingPair']> & { code: string }) | null = null;
  /** `secret` went into the QR and only there; a `pair_request` must prove it (`verifyPairingProof`). */
  private pairing: { expiresAt: number; secret: Uint8Array } | null = null;
  /** A device whose code this server redeemed, until it confirms or refuses (`paired`, `rejected`). */
  private joining: { device: string; name: string; kind: string | null; expiresAt: number } | null = null;
  private error: string | null = null;
  /** Set when the relay client stopped on a relay below `MIN_RELAY_VERSION`; cleared by the next start. */
  private relayRefusal: RelayTooOld | null = null;
  /** The knock `RELAY_TOO_OLD_RECHECK_MS` after a relay was refused as too old; cleared by any start or stop. */
  private relayRecheck: NodeJS.Timeout | null = null;
  /**
   * Phones refused at `hello` for an app too old, by device id. In memory:
   * the next hello decides again, and a restart only loses the mark until then.
   */
  private readonly phonesTooOld = new Map<string, PhoneRefusal>();
  /**
   * Members a mutual pair was asked for on this relay connection, and those
   * the relay could not pair (a relay from before `/pair/mutual`). Both are
   * replaced at every relay `ok`, so a reconnect, or an updated relay, asks again.
   */
  private mutualAsked = new Set<string>();
  private pairByHand = new Set<string>();
  /** Revokes posted to the relay and not answered yet; a removal waits for them before it answers. */
  private readonly revoking = new Set<Promise<void>>();
  private readonly now: () => number;
  /** One for every phone, so its named-path cache serves them all. */
  private readonly files: PhoneFileReader;

  constructor(private readonly opts: RemoteServiceOptions) {
    this.devices = new DeviceStore(opts.db);
    this.roster = new RosterStore(opts.db);
    this.now = opts.now ?? Date.now;
    this.files = createPhoneFileReader(
      opts.db,
      opts.transcriptPath ?? ((id, projectDir) => join(CONFIG.projectsDir, projectDir, `${id}.jsonl`)),
      opts.trees,
    );
  }

  private get enabled(): boolean {
    return this.opts.settings.get('remote_enabled') === 'true';
  }

  /** Empty while the user has not set one; the remote cannot start then. */
  private get relayUrl(): string {
    return this.opts.settings.get('remote_relay_url').trim();
  }

  /** Empty while the user has not set one: an open relay needs none. */
  private get relaySecret(): string {
    return this.opts.settings.get('remote_relay_secret').trim();
  }

  private get macName(): string {
    return macDisplayName(this.opts.settings.get('remote_mac_name'));
  }

  start(): void {
    if (!this.enabled || this.client) return;
    this.relayRefusal = null;
    // Nothing to connect to: a failed start, before the identity is touched.
    if (this.relayUrl === '') {
      this.error = NO_RELAY_URL_ERROR;
      this.publishStatus();
      return;
    }
    // The server boots from `buildServer`, and a remote that cannot start (an
    // unparseable relay URL, an unreadable identity file) must not take the
    // rest of Orbital down with it: it reports the reason and stays off.
    try {
      const loaded = loadOrCreateIdentity(this.opts.dataDir);
      this.identity = loaded.identity;
      if (loaded.regenerated) this.forgetAllDevices();
      this.addSelf();
      const client = (this.opts.clientFactory ?? ((o) => new RelayClient(o)))({
        relayUrl: this.relayUrl, identity: this.identity, relaySecret: this.relaySecret,
      });
      this.client = client;
      client.on('status', () => {
        // A new connection means new session keys: every phone re-handshakes.
        if (client.status !== 'online') this.closeChannels();
        this.publishStatus();
      });
      client.on('control', (msg: RelayToDevice) => this.onControl(msg));
      client.on('data', (frame: Uint8Array) => this.onData(frame));
      // The client has stopped for good; reported like a failed start, and
      // the next settings change or restart starts afresh.
      // A relay too old is the exception: it gets updated without the Mac
      // knowing, so the Mac knocks again by itself after a while.
      client.on('refused', (reason: RelayRefusal, tooOld?: RelayTooOld) => {
        this.teardown();
        if (reason === 'relay_too_old' && tooOld) {
          this.relayRefusal = tooOld;
          this.relayRecheck = setTimeout(() => this.settingsChanged(), RELAY_TOO_OLD_RECHECK_MS);
          this.relayRecheck.unref?.();
        } else {
          this.error = BAD_SECRET_ERROR;
        }
        this.publishStatus();
      });
      for (const device of this.devices.list()) this.watch(device.id);
      client.start();
      this.error = null;
    } catch (err) {
      this.teardown();
      this.error = err instanceof Error ? err.message : String(err);
      console.warn(`[remote] could not start: ${this.error}`);
    }
    this.publishStatus();
  }

  stop(): void {
    this.teardown();
    this.error = null;
    this.relayRefusal = null;
    this.publishStatus();
  }

  /** Everything `stop` undoes, without publishing: a failed `start` publishes once, at its end. */
  private teardown(): void {
    if (this.relayRecheck) clearTimeout(this.relayRecheck);
    this.relayRecheck = null;
    this.closeChannels();
    for (const w of this.watchers.values()) w.stop();
    this.watchers.clear();
    const client = this.client;
    this.client = null;
    // Detached first, so its last `status` event does not publish mid-teardown.
    client?.removeAllListeners();
    client?.stop();
    this.identity = null;
    this.pendingPair = null;
    this.pairing = null;
    this.joining = null;
  }

  /** Re-reads every setting: a toggle or a relay URL change applies now. */
  settingsChanged(): void {
    this.stop();
    this.start();
  }

  /**
   * The Mac's name changed. `macName` is read fresh for every pairing code and
   * every new device channel, so nothing restarts; the status is published so
   * every window shows the new name.
   */
  nameChanged(): void {
    const self = this.selfId;
    const described = self !== null
      && this.setRoster(describeMember(this.roster.list(), self, { name: this.macName }, this.now()));
    if (!described) this.publishStatus();
  }

  /** This device's id while the remote runs; null while it is off. */
  private get selfId(): string | null {
    return this.identity ? deviceId(this.identity.publicKey) : null;
  }

  /** The roster's digest, for tests that check two members converged. */
  rosterDigest(): string {
    return this.roster.digest();
  }

  status(): RemoteStatus {
    this.pairingOpen();
    const online = this.client?.peersOnline ?? new Set<string>();
    return {
      enabled: this.enabled,
      relay: this.relayRefusal ? 'too_old' : this.client?.status ?? 'off',
      relayTooOld: this.relayRefusal,
      relayAttempts: this.client?.attempts ?? 0,
      relayUrl: this.relayUrl,
      macId: this.identity ? deviceId(this.identity.publicKey) : null,
      macName: this.macName,
      devices: this.listDevices().map((d) => ({
        ...d, online: online.has(d.id), needsUpdate: this.phonesTooOld.get(d.id) ?? null,
      })),
      pendingPair: this.publicPendingPair(),
      pairing: this.pairing ? { expiresAt: this.pairing.expiresAt } : null,
      joining: this.joining && this.joining.expiresAt > this.now()
        ? { device: this.joining.device, name: this.joining.name } : null,
      error: this.error,
      group: { members: this.listMembers(online) },
    };
  }

  /** As `listDevices`: a database already gone reads as an empty roster. */
  private listMembers(online: Set<string>): RemoteStatus['group']['members'] {
    try {
      const self = this.selfId;
      const linked = new Set(this.devices.list().map((d) => d.id));
      return this.roster.list().map((e) => ({
        ...e, self: e.id === self, linked: linked.has(e.id), online: online.has(e.id), pairByHand: this.pairByHand.has(e.id),
      }));
    } catch (err) {
      console.warn(`[remote] could not list the roster: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** The request as the status shows it: everything but the code. */
  private publicPendingPair(): RemoteStatus['pendingPair'] {
    if (!this.pendingPair) return null;
    const { code: _code, ...shown } = this.pendingPair;
    return shown;
  }

  /**
   * `status()` runs inside `stop()`, which runs inside the server's close
   * hook: a database that is already gone (or a table a stale migration set
   * never created) must read as no devices, not throw through shutdown.
   */
  private listDevices(): RemoteDevice[] {
    try {
      return this.devices.list();
    } catch (err) {
      console.warn(`[remote] could not list devices: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * Also clears an expired code and the request made with it: neither may
   * outlive the code — the relay prunes the pending row past its expiry, so
   * a confirm would only fail there.
   */
  private pairingOpen(): boolean {
    if (this.pairing && this.pairing.expiresAt <= this.now()) {
      this.pairing = null;
      this.pendingPair = null;
    }
    return this.pairing !== null;
  }

  /** No code while the relay is too old: a phone could not pair through it anyway. */
  async startPairing(
  ): Promise<{ qr: string; expiresAt: number } | { error: 'disabled' | 'offline' | 'relay_error' | 'relay_too_old' }> {
    if (this.relayRefusal) return { error: 'relay_too_old' };
    if (!this.enabled || !this.client || !this.identity) return { error: 'disabled' };
    if (this.client.status !== 'online') return { error: 'offline' };
    // No name: the relay knows none. The phone reads it from the QR.
    const res = await this.client.post<{ token: string; expiresAt: number }>('/pair/token', 'pair.token', {});
    if (res.relayTooOld) return { error: 'relay_too_old' };
    if (res.status !== 200) return { error: 'relay_error' };
    const secret = new Uint8Array(randomBytes(PAIRING_SECRET_BYTES));
    this.pairing = { expiresAt: res.body.expiresAt, secret };
    this.pendingPair = null;
    const qr: QrPayload = {
      v: 1, relay: this.relayUrl, mac: deviceId(this.identity.publicKey), name: this.macName, token: res.body.token,
      secret: toBase64Url(secret), kind: serverDeviceKind(),
    };
    if (this.relaySecret) qr.relaySecret = this.relaySecret;
    this.publishStatus();
    return { qr: JSON.stringify(qr), expiresAt: res.body.expiresAt };
  }

  /**
   * `phone` is the request the user actually looked at, so a confirm never
   * applies to any other phone. An accept carries the `code` the user typed
   * from the phone; only that phone can show the code this request expects.
   * A wrong one tells the relay nothing until it is the last
   * (`PAIR_CODE_ATTEMPTS`): then the request is rejected, as Reject would.
   */
  async confirmPairing(accept: boolean, phone: string, code?: string): Promise<PairConfirmResult> {
    const pending = this.pairingOpen() ? this.pendingPair : null;
    if (!pending || pending.phone !== phone || !this.client) return { error: 'no_pending' };
    if (accept && normalizePairingCode(code ?? '') !== pending.code) {
      pending.attemptsLeft -= 1;
      if (pending.attemptsLeft > 0) {
        this.publishStatus();
        return { error: 'code_mismatch', attemptsLeft: pending.attemptsLeft };
      }
      // The request is over here whatever the relay answers: the device was
      // never added, and a phone the relay still holds as pending is dropped
      // there when the code expires.
      this.pendingPair = null;
      this.pairing = null;
      this.publishStatus();
      const res = await this.client.post('/pair/confirm', 'pair.confirm', { phone: pending.phone, accept: false });
      if (res.status !== 200) console.warn(`[remote] relay reject of ${pending.phone.slice(0, 8)} after wrong codes failed: ${res.status}`);
      return { error: 'code_rejected' };
    }
    // The relay tells the phone `paired` before it answers this post, and a
    // phone handshakes the moment it hears that — so the device must exist
    // here first, or its handshake frame is dropped as from a stranger.
    const existed = this.devices.get(pending.phone) !== null;
    if (accept) {
      this.devices.add({
        id: pending.phone, name: pending.name, platform: pending.platform, kind: pending.kind, pairedAt: this.now(),
        notifications: parseNotificationSettings(this.opts.allSettings()),
      });
      this.watch(pending.phone);
    }
    const res = await this.client.post('/pair/confirm', 'pair.confirm', { phone: pending.phone, accept });
    if (res.status !== 200) {
      // The relay never paired it: undo what was added above. A device that
      // was already paired before this confirm is not ours to remove.
      if (accept && !existed) {
        this.channels.get(pending.phone)?.close();
        this.channels.delete(pending.phone);
        this.watchers.get(pending.phone)?.stop();
        this.watchers.delete(pending.phone);
        this.devices.remove(pending.phone);
      }
      return { error: 'relay_error' };
    }
    // A stop/start during the post replaced the state; leave the new one be.
    if (this.pendingPair === pending) {
      this.pendingPair = null;
      this.pairing = null;
    }
    if (accept) {
      this.tryRoster('add a paired device', () => this.addPaired({
        id: pending.phone, kind: pending.kind, name: pending.name, os: osName(pending.platform),
      }));
    }
    this.publishStatus();
    // A guard: the relay's `presence` for the new device, sent before it
    // answered the post, has normally opened the channel already (if this
    // side is the one that opens it); `open` does nothing then.
    if (accept) this.open(pending.phone);
    return { ok: true };
  }

  /**
   * Redeems another device's pairing code, as a phone does (spec
   * 2026-10-16-device-group-design § 3): the answer is the code the user
   * types on that device. The pair exists once it confirms (`paired`).
   */
  async join(code: string): Promise<JoinResult> {
    const qr = parsePairingCode(code);
    if (!qr) return { error: 'bad_code' };
    if (this.relayRefusal) return { error: 'relay_too_old' };
    if (!this.enabled || !this.client || !this.identity) return { error: 'disabled' };
    if (this.client.status !== 'online') return { error: 'offline' };
    const self = deviceId(this.identity.publicKey);
    if (qr.mac === self) return { error: 'bad_code' };
    if (this.devices.get(qr.mac)) return { error: 'already_paired' };
    // One relay per group (§ 4), and this server's socket is on its own.
    if (qr.relay.replace(/\/+$/, '') !== this.relayUrl.replace(/\/+$/, '')) return { error: 'other_relay' };
    const secret = fromBase64Url(qr.secret);
    const payload = {
      token: qr.token,
      proof: pairingProof(secret, this.identity.publicKey),
      device: sealPairingDevice(secret, this.identity.publicKey, {
        name: this.macName, platform: osName(process.platform), kind: serverDeviceKind(),
      }),
    };
    // Cut as a pairing cuts a phone's name: the QR's is whatever that device was called.
    const name = qr.name.slice(0, PAIR_NAME_MAX_CHARS);
    this.joining = { device: qr.mac, name, kind: qr.kind ?? null, expiresAt: this.now() + PAIRING_TOKEN_TTL_MS };
    this.publishStatus();
    const res = await this.client.post('/pair/redeem', 'pair.redeem', payload);
    if (res.status !== 200) {
      this.joining = null;
      this.publishStatus();
      if (res.relayTooOld) return { error: 'relay_too_old' };
      return { error: res.status === 409 ? 'peer_offline' : res.status === 404 ? 'bad_code' : 'relay_error' };
    }
    return {
      device: qr.mac, name,
      code: formatFingerprint(fingerprint(publicKeyOf(qr.mac)!, this.identity.publicKey)),
    };
  }

  /** The channel to a paired device, while one is open. */
  channel(id: string): Channel | null {
    return this.channels.get(id) ?? null;
  }

  /**
   * Removes a member from the group, on every member (ADR
   * joining-one-member-joins-the-group): the roster marks it removed and
   * the removal is applied here at once, remote on or off. A device paired
   * before the roster existed gets its entry first. Telling the relay is
   * best effort on top — a device it still thinks is paired can reach
   * nothing here. False when `id` is neither a live member nor paired.
   */
  async remove(id: string): Promise<boolean> {
    const known = this.roster.entry(id);
    const device = this.devices.get(id);
    if (!(known && isLive(known)) && !device) return false;
    const self = this.ownId();
    if (self !== null) {
      this.tryRoster('remove a member', () => {
        const now = this.now();
        let roster = this.roster.list();
        if (!known && device) {
          roster = addMember(roster, {
            id, kind: device.kind ?? 'phone', name: device.name, os: osName(device.platform), links: false,
            addedBy: self, addedAt: device.pairedAt, describedAt: now,
          });
        }
        this.setRoster(removeMember(roster, id, self, now));
      });
    }
    // Still paired: no identity to write the roster with, or an entry that was removed already.
    if (this.devices.get(id)) {
      this.dropMember(id);
      this.publishStatus();
    }
    await Promise.all([...this.revoking]);
    return true;
  }

  /** This device leaves its group: removing it, from itself. */
  async leave(): Promise<void> {
    const self = this.ownId();
    if (self !== null) await this.remove(self);
  }

  /** This device's id, read from the data dir while the remote is off; null when it never had one. */
  private ownId(): string | null {
    if (this.selfId !== null) return this.selfId;
    const identity = readIdentity(this.opts.dataDir);
    return identity ? deviceId(identity.publicKey) : null;
  }

  /**
   * A member removed from the group, on this device: told so while its
   * channel is open, then its channel, watcher and row go, and its pair at
   * the relay — posted even with no row, so the relay also drops a mutual
   * half waiting between the two.
   */
  private dropMember(id: string): void {
    const channel = this.channels.get(id);
    channel?.sendGroup({ t: 'removed' });
    channel?.close('revoked');
    this.channels.delete(id);
    this.watchers.get(id)?.stop();
    this.watchers.delete(id);
    this.devices.remove(id);
    this.phonesTooOld.delete(id);
    this.revokeAtRelay(id);
  }

  /**
   * This device was removed from its group: the members it still talks to
   * get the roster that says so (a `removed` would tell them they were
   * removed) and `bye revoked`, while the channels exist; then every pair
   * goes at the relay, then every paired device here; then this device
   * starts a group of one at its next epoch, which the others' removal
   * does not reach.
   */
  private leaveGroup(self: string): void {
    const entries = this.roster.list();
    for (const channel of this.channels.values()) {
      channel.sendGroup({ t: 'roster', entries });
      channel.close('revoked');
    }
    this.channels.clear();
    const paired = this.devices.list();
    for (const d of paired) this.revokeAtRelay(d.id);
    for (const w of this.watchers.values()) w.stop();
    this.watchers.clear();
    for (const d of paired) this.devices.remove(d.id);
    this.phonesTooOld.clear();
    const now = this.now();
    this.setRoster(addMember(entries.filter((e) => e.id === self), {
      id: self, ...this.selfAbout(), addedBy: self, addedAt: now, describedAt: now,
    }));
  }

  /** Best effort: the device is gone here whatever the relay answers; 404 is a pair the relay no longer had. */
  private revokeAtRelay(id: string): void {
    const client = this.client;
    if (!client || client.status !== 'online') return;
    const done = client.post('/pair/revoke', 'pair.revoke', { phone: id }).then((res) => {
      if (res.status !== 200 && res.status !== 404) console.warn(`[remote] relay revoke of ${id.slice(0, 8)} failed: ${res.status}`);
    });
    this.revoking.add(done);
    void done.finally(() => this.revoking.delete(done));
  }

  /**
   * After the identity file was unreadable and replaced: every phone paired
   * with the old key verifies the Mac against that key and can never
   * handshake again, so listing them would only lie. The old self entry
   * stays in the roster: the old key is gone, and with it the old id.
   */
  private forgetAllDevices(): void {
    const all = this.devices.list();
    if (all.length === 0) return;
    for (const d of all) this.devices.remove(d.id);
    console.warn(`[remote] the Mac's identity was regenerated; removed ${all.length} paired phone(s), which must pair again`);
  }

  private onControl(msg: RelayToDevice): void {
    if (msg.type === 'ok') {
      for (const device of this.devices.list()) this.open(device.id);
      const hadByHand = this.pairByHand.size > 0;
      this.mutualAsked = new Set();
      this.pairByHand = new Set();
      if (hadByHand) this.publishStatus();
      this.tryRoster('link the group', () => this.link());
      return;
    }
    if (msg.type === 'linked') {
      this.tryRoster('add a linked member', () => this.onLinked(msg.peer));
      return;
    }
    // The other side revoked the pair; the roster hears of a removal from the group.
    if (msg.type === 'unpaired') {
      if (!this.devices.get(msg.mac)) return;
      this.channels.get(msg.mac)?.close();
      this.channels.delete(msg.mac);
      this.watchers.get(msg.mac)?.stop();
      this.watchers.delete(msg.mac);
      this.devices.remove(msg.mac);
      this.phonesTooOld.delete(msg.mac);
      this.publishStatus();
      return;
    }
    // The relay sends `paired` before it answers the other side's confirm,
    // and a `presence` for that side right after. If this side opens the
    // channel, it does so at that `presence` (here, only if the relay already
    // counted the peer online); if the confirming side does, it opens from
    // the `presence` the relay sends it for this side.
    if (msg.type === 'paired' && this.joining && msg.mac === this.joining.device) {
      const joined = this.joining;
      this.joining = null;
      this.devices.add({
        id: joined.device, name: joined.name, platform: '', kind: joined.kind, pairedAt: this.now(),
        notifications: parseNotificationSettings(this.opts.allSettings()),
      });
      // A code without a kind came from a Mac from before kinds. Its OS is
      // not known until its hello.
      this.tryRoster('add a paired device', () => this.addPaired({
        id: joined.device, kind: joined.kind ?? 'desktop', name: joined.name, os: '',
      }));
      this.publishStatus();
      this.open(joined.device);
      return;
    }
    if (msg.type === 'rejected' && this.joining && msg.mac === this.joining.device) {
      this.joining = null;
      this.publishStatus();
      return;
    }
    if (msg.type === 'pair_request' && this.identity) {
      // Only while the user has a code on screen, and only the first phone
      // to redeem it: a second request must not swap the code the
      // user is typing from their phone.
      if (!this.pairingOpen() || !this.pairing || this.pendingPair) return;
      const phoneKey = publicKeyOf(msg.phone);
      if (!phoneKey) return;
      // The relay could otherwise substitute a key of its own whose 30-bit
      // fingerprint it ground to match; only the phone that scanned the QR
      // holds the secret the proof is made with.
      if (!verifyPairingProof(this.pairing.secret, phoneKey, msg.proof)) {
        console.warn(`[remote] ignored a pairing request from ${msg.phone.slice(0, 8)}: its proof does not match this code`);
        return;
      }
      // Only what the phone sealed with this code's secret: a plain name came from the relay.
      const device = msg.device === undefined ? null : openPairingDevice(this.pairing.secret, phoneKey, msg.device);
      this.pendingPair = {
        phone: msg.phone, name: device?.name || UNKNOWN_PHONE_NAME, platform: device?.platform ?? '',
        kind: device?.kind ?? 'phone',
        code: fingerprint(this.identity.publicKey, phoneKey), attemptsLeft: PAIR_CODE_ATTEMPTS,
      };
      this.opts.hub.publish('remote', { event: 'pair_request', ...this.publicPendingPair() });
      this.publishStatus();
      return;
    }
    if (msg.type === 'presence') {
      // Online or offline, the phone's previous session is over: a phone
      // that reconnects on a new socket supersedes the old one without the
      // relay ever saying `offline`, and it handshakes afresh. The relay
      // sends this presence before any frame from the new socket, so the
      // new handshake meets no stale cipher.
      this.channels.get(msg.peer)?.close();
      this.channels.delete(msg.peer);
      if (msg.online) this.devices.touch(msg.peer, this.now());
      this.publishStatus();
      if (msg.online) this.open(msg.peer);
    }
  }

  private onData(buf: Uint8Array): void {
    const frame = decodeFrame(buf);
    if (!frame || !this.identity || !this.client) return;
    const from = deviceId(frame.peer);
    const device = this.devices.get(from);
    if (!device || frame.body.length === 0) return;
    const channel = this.channels.get(from) ?? this.makeChannel(device, 'responder');
    channel.receive(frame.body);
  }

  /** Opens the channel to `id` when this server is the side that opens it (§ 5) and the peer is online. */
  private open(id: string): void {
    const device = this.devices.get(id);
    if (!device || !this.identity || !this.client || this.client.status !== 'online') return;
    if (!this.client.peersOnline.has(id) || this.channels.has(id)) return;
    const self = { id: deviceId(this.identity.publicKey), kind: serverDeviceKind() };
    if (!initiates(self, { id, kind: device.kind })) return;
    this.makeChannel(device, 'initiator').start();
  }

  /** A channel to a paired device, mapped until it closes; the caller starts it or feeds it. */
  private makeChannel(device: RemoteDevice, role: Role): Channel {
    const identity = this.identity!;
    const client = this.client!;
    const from = device.id;
    const peerKey = publicKeyOf(from)!;
    const opened = openDeviceChannel({
      deviceId: from, identity, peerKey, role,
      hello: serverHello({ serverVersion: this.opts.serverVersion, name: this.macName, kind: serverDeviceKind() }),
      hub: this.opts.hub, inject: this.opts.inject, images: this.opts.images, imagesDir: this.opts.imagesDir,
      files: this.files,
      notifications: {
        get: () => this.devices.get(from)?.notifications ?? device.notifications,
        set: (s) => this.devices.setNotifications(from, s),
      },
      send: (body) => client.sendData(encodeFrame({ peer: peerKey, flags: 0, wake: ZERO_WAKE, body })),
      onSeen: (sessionId) => this.watchers.get(from)?.seen(sessionId),
      atMac: () => this.opts.presence?.atMac ?? false,
      onAppVersion: (refusal) => this.markPhoneVersion(from, refusal),
    });
    opened.on((event) => {
      // A closed channel is terminal: the next frame from this device builds a fresh one.
      if (event.type === 'closed' && this.channels.get(from) === opened) this.channels.delete(from);
      // The peer ended these keys; closing takes the channel out of the map, so
      // its next handshake (or the next `presence`) builds a fresh one.
      if (event.type === 'bye') opened.close();
      if (event.type === 'silent') {
        // A peer that serves went quiet: drop the channel. A responder's peer
        // opens a new one with its next handshake; an initiator opens it again.
        opened.close();
        if (role === 'initiator') this.open(from);
      }
      if (event.type === 'hello') this.tryRoster('describe a peer', () => this.onPeerHello(from, opened, event.hello));
      // Each side sends its digest as the channel opens; a difference is answered with the roster.
      if (event.type === 'ready' && event.ready && opened.groups) opened.sendGroup({ t: 'roster_digest', digest: this.roster.digest() });
      if (event.type === 'group') this.onGroup(from, opened, event.msg);
    });
    this.channels.set(from, opened);
    return opened;
  }

  /**
   * The only way the roster changes. Unchanged, it does nothing: that is
   * what ends an exchange between two members once they agree. Changed, it
   * applies what the change removed, publishes the status and offers the
   * new digest on every group channel but `from`, the one the change came in on.
   */
  private setRoster(next: RosterEntry[], from?: string): boolean {
    const before = new Map(this.roster.list().map((e) => [e.id, e]));
    if (!this.roster.replace(next)) return false;
    this.applyRemovals(before);
    this.publishStatus();
    const digest = this.roster.digest();
    for (const [id, channel] of this.channels) {
      if (id !== from) channel.sendGroup({ t: 'roster_digest', digest });
    }
    this.link();
    return true;
  }

  /**
   * Every entry this write removed: this device's own makes it leave the
   * group; another's drops that member here. An entry first heard of as
   * removed is dropped only when this device is paired with it.
   */
  private applyRemovals(before: Map<string, RosterEntry>): void {
    const self = this.ownId();
    const removed = this.roster.list().filter((e) => {
      const was = before.get(e.id);
      return !isLive(e) && (was === undefined || isLive(was));
    });
    if (self !== null && removed.some((e) => e.id === self)) {
      this.leaveGroup(self);
      return;
    }
    for (const e of removed) {
      if (before.has(e.id) || this.devices.get(e.id)) this.dropMember(e.id);
    }
  }

  /**
   * Asks the relay for a mutual pair with every live member that links and
   * is not paired with this device yet, each once per relay connection (ADR
   * the-relay-pairs-two-devices-that-both-sign). The pair forms when the
   * member asks too; the relay then says `linked`, and so may this answer.
   */
  private link(): void {
    const self = this.selfId;
    const client = this.client;
    if (self === null || !client || client.status !== 'online') return;
    const asked = this.mutualAsked;
    for (const e of this.roster.list()) {
      if (!isLive(e) || !e.links || e.id === self || asked.has(e.id) || this.devices.get(e.id)) continue;
      const id = e.id;
      asked.add(id);
      void client.post<{ linked?: boolean }>('/pair/mutual', 'pair.mutual', { peer: id }).then((res) => {
        // A relay `ok` in between started a new connection's asking; this answer is the old one's.
        if (this.client !== client || this.mutualAsked !== asked) return;
        if (res.status === 200) {
          if (res.body.linked === true) this.tryRoster('add a linked member', () => this.onLinked(id));
          return;
        }
        if (res.status === 404) {
          this.pairByHand.add(id);
          this.publishStatus();
          return;
        }
        // A refusal (a bad id, a rate limit) waits for the next relay `ok`;
        // a network failure or a relay error is asked again at the next roster change.
        if (res.status === 0 || res.status >= 500) asked.delete(id);
        console.warn(`[remote] relay mutual pair with ${id.slice(0, 8)} failed: ${res.status}`);
      });
    }
  }

  /**
   * The relay paired this device with `peer`. Only a member the roster holds
   * live, and that links, becomes a paired device — never one on the relay's word alone. Both
   * the control and the post's answer can say so; the second changes nothing.
   */
  private onLinked(peer: string): void {
    const entry = this.roster.entry(peer);
    if (!this.identity || peer === this.selfId) return;
    // A removed member asked before its removal reached the relay: the pair goes again.
    if (entry && !isLive(entry)) {
      console.warn(`[remote] revoked a link with ${peer.slice(0, 8)}: removed from the group`);
      this.revokeAtRelay(peer);
      return;
    }
    // A member that does not link (a phone) is never asked for, so a `linked` for one is not ours.
    if (!entry || !entry.links) {
      console.warn(`[remote] ignored a link with ${peer.slice(0, 8)}: no live member of the group that links`);
      return;
    }
    if (!this.devices.get(peer)) {
      this.devices.add({
        id: peer, name: entry.name, platform: entry.os, kind: entry.kind, pairedAt: this.now(),
        notifications: parseNotificationSettings(this.opts.allSettings()),
      });
      this.watch(peer);
      this.publishStatus();
    }
    this.open(peer);
  }

  /**
   * This device, once, as the first member of its own group; a removed entry
   * for it stays removed. A live one is described afresh: a rename made while
   * the remote was off reached no roster.
   */
  private addSelf(): void {
    const self = this.selfId!;
    const known = this.roster.entry(self);
    const now = this.now();
    const about = this.selfAbout();
    if (!known) {
      this.setRoster(addMember(this.roster.list(), { id: self, ...about, addedBy: self, addedAt: now, describedAt: now }));
    } else if (isLive(known)) {
      this.setRoster(describeMember(this.roster.list(), self, about, now));
    }
  }

  /** What this device says about itself in the roster. */
  private selfAbout(): Pick<RosterEntry, 'kind' | 'name' | 'os' | 'links'> {
    return { kind: serverDeviceKind(), name: this.macName, os: osName(process.platform), links: true };
  }

  /**
   * A roster write on the way to something else — a confirm already
   * accepted, a hello inside the channel — that must not fail it: the
   * roster catches up at the next exchange.
   */
  private tryRoster(what: string, write: () => void): void {
    try {
      write();
    } catch (err) {
      console.warn(`[remote] could not ${what}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * A device this one just paired with, at the next epoch. A live entry is
   * kept: the device is a member already, perhaps written by its first
   * hello, which can arrive before the pairing finishes here.
   */
  private addPaired(device: Pick<RosterEntry, 'id' | 'kind' | 'name' | 'os'>): void {
    const self = this.selfId;
    if (self === null) return;
    const known = this.roster.entry(device.id);
    if (known && isLive(known)) return;
    const now = this.now();
    this.setRoster(addMember(this.roster.list(), {
      ...device, links: false, addedBy: self, addedAt: now, describedAt: now,
    }));
  }

  /**
   * What a peer's hello says about it, written onto its live entry; only the
   * fields the hello names. A device paired before the roster existed has
   * no entry yet and gets one here.
   */
  private onPeerHello(from: string, channel: Channel, hello: HelloMessage): void {
    const self = this.selfId;
    if (self === null) return;
    const name = hello.name ?? hello.macName;
    const patch = {
      ...(name !== undefined ? { name } : {}),
      ...(hello.os !== undefined ? { os: hello.os } : {}),
      links: channel.groups,
    };
    const known = this.roster.entry(from);
    const now = this.now();
    // `from` is skipped: the channel's own `ready` follows with the digest.
    if (known) {
      if (isLive(known)) this.setRoster(describeMember(this.roster.list(), from, patch, now), from);
      return;
    }
    const device = this.devices.get(from);
    if (!device) return;
    this.setRoster(addMember(this.roster.list(), {
      id: from, kind: device.kind ?? hello.kind ?? 'desktop', name: patch.name ?? device.name, os: patch.os ?? '',
      links: patch.links, addedBy: self, addedAt: now, describedAt: now,
    }), from);
  }

  private onGroup(from: string, channel: Channel, msg: GroupMessage): void {
    if (msg.t === 'roster_digest') {
      if (msg.digest !== this.roster.digest()) channel.sendGroup({ t: 'roster', entries: this.roster.list() });
      return;
    }
    if (msg.t === 'roster') {
      this.setRoster(mergeRosters(this.roster.list(), msg.entries), from);
      // The sender may still lack what only this side knew.
      if (this.roster.digest() !== rosterDigest(msg.entries)) channel.sendGroup({ t: 'roster', entries: this.roster.list() });
      return;
    }
    // A member says this device was removed; its roster says so too, and the removal comes with it.
    const self = this.selfId;
    if (self !== null) this.tryRoster('leave the group', () => this.setRoster(removeMember(this.roster.list(), self, from, this.now()), from));
  }

  /**
   * Every refusal publishes, since it moves the time the list shows ("refused
   * · …"); a hello that will do publishes only when it clears a mark, or every
   * hello of a phone that is fine would republish the status.
   */
  private markPhoneVersion(id: string, refusal: PhoneTooOld | null): void {
    if (refusal) {
      this.phonesTooOld.set(id, { ...refusal, at: this.now() });
      this.publishStatus();
    } else if (this.phonesTooOld.delete(id)) {
      this.publishStatus();
    }
  }

  /** Only a phone takes wake pushes: a desktop or headless member reads the map itself. */
  private watch(id: string): void {
    if (this.watchers.has(id) || !this.identity) return;
    if (this.devices.get(id)?.kind !== 'phone') return;
    const secret = wakeSecret(this.identity);
    const phoneKey = publicKeyOf(id);
    if (!phoneKey) return;
    const watcher = new DeviceWatcher({
      deviceId: id, hub: this.opts.hub,
      settings: () => this.devices.get(id)?.notifications ?? parseNotificationSettings({}),
      quiet: () => this.opts.presence?.atMac ?? false,
      // Sent whether or not the phone is connected: the relay forwards to a
      // connected phone (which ignores an empty body) and pushes otherwise.
      onWake: (sessionId) => this.client?.sendData(encodeFrame({
        peer: phoneKey, flags: FLAG_WAKE | FLAG_STATE, wake: wakeToken(secret, sessionId), body: new Uint8Array(0),
      })),
    });
    void this.opts.inject({ method: 'GET', url: '/api/sessions?limit=200' }).then((res) => {
      let initial: unknown[] = [];
      try {
        // The route answers `{ sessions: [...] }` (routes.ts, GET /api/sessions).
        const parsed = JSON.parse(res.body) as { sessions?: unknown };
        if (Array.isArray(parsed.sessions)) initial = parsed.sessions;
      } catch {
        /* an empty seed only means the first sighting of each session is not news */
      }
      if (this.watchers.get(id) === watcher) watcher.start(initial);
    }).catch((err: unknown) => {
      // No seed is a lesser loss than no watcher: start it anyway.
      console.warn(`[remote] could not seed the watcher for ${id}: ${err instanceof Error ? err.message : String(err)}`);
      if (this.watchers.get(id) === watcher) watcher.start([]);
    });
    this.watchers.set(id, watcher);
  }

  private closeChannels(): void {
    for (const c of this.channels.values()) c.close();
    this.channels.clear();
  }

  private publishStatus(): void {
    this.opts.hub.publish('remote', { event: 'status', ...this.status() });
  }
}
