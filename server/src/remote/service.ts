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
import type { HelloMessage } from '@orbital/shared/remote/messages';
import { ROSTER_KIND_MAX_CHARS, isLive, type RosterEntry } from '@orbital/shared/remote/roster';
import {
  GroupMember, type GroupStorage, type MemberState, type RemoveResult, type SelfAbout,
} from '@orbital/shared/remote/group';
import type { RelayTooOld } from '@orbital/shared/remote/version';
import type { Hub } from '../api/hub.js';
import { CONFIG } from '../config.js';
import type { OrbitalDb } from '../db/database.js';
import type { ImageStore } from '../images/store.js';
import { DeviceStore, type RemoteDevice } from './devices.js';
import { DeviceWatcher } from './deviceWatcher.js';
import { loadOrCreateIdentity, macDisplayName, readIdentity, serverDeviceKind, serverHello } from './identity.js';
import { createPhoneFileReader, type PhoneFileReader } from './phoneFiles.js';
import { PendingRevokes, RosterStore } from './rosterStore.js';
import type { WorkingTrees } from '../git/workingTrees.js';
import { openDeviceChannel, type PhoneTooOld } from './deviceChannel.js';
import type { InjectFn } from './servingHalf.js';
import { RelayClient, type RelayClientOptions, type RelayRefusal } from './relayClient.js';
import { wakeSecret, wakeToken } from './wake.js';
import type { Presence } from './presence.js';
import { memberTooOld } from './memberGate.js';

/** A phone refused at `hello` for an app too old: both versions, and when it was last refused. */
export type PhoneRefusal = PhoneTooOld & { at: number };

/**
 * How long a relay refused as too old is left alone before the Mac knocks
 * again by itself. Whoever runs the relay updates it out of the Mac's sight,
 * so the Mac comes back on its own (canvas 11b); "Try again" checks at once.
 */
export const RELAY_TOO_OLD_RECHECK_MS = 5 * 60_000;

export { MUTUAL_RETRY_MS, type MemberState, type RemoveResult } from '@orbital/shared/remote/group';

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
 * code the user types on it, or why not. `in_group`: this device is in a
 * group already and leaves it first. `peer_offline`: the device that showed
 * the code is not on the relay; `expiresAt` is the code's, when it says.
 * `other_relay`: the code names a relay this server is not on, `relay`.
 */
export type JoinResult =
  | { device: string; name: string; code: string }
  | { error: 'bad_code' | 'disabled' | 'offline' | 'already_paired' | 'in_group' | 'relay_error' | 'relay_too_old' }
  | { error: 'other_relay'; relay: string }
  | { error: 'peer_offline'; expiresAt?: number };

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
  /**
   * A device whose code this server redeemed and which has not confirmed
   * yet: `code` is what the user types on it, `expiresAt` when its code stops working,
   * `kind` its kind as its code named it (null from a code without one).
   */
  joining: { device: string; name: string; kind: string | null; code: string; expiresAt: number } | null;
  /** Why the last `start` failed; null while it is fine. */
  error: string | null;
  /**
   * The group's live members (spec 2026-10-16-device-group-design § 2); the
   * removed ones stay in the store only. `self`: this device; `linked`:
   * paired with this device directly; `online`: on the relay as this device
   * sees it; `pairByHand`: the relay has no `/pair/mutual`, so only a
   * pairing code links the two; `state`: how Settings shows it; `seenAt`:
   * when a member paired here was last on the relay, null for any other.
   * `tooOld`: a member too old to take part in the group (`memberTooOld`), by its last hello.
   * `relayLocked`: this device is in a group (`inGroup`), so the relay URL and secret cannot change.
   */
  group: {
    members: (RosterEntry & {
      self: boolean; linked: boolean; online: boolean; pairByHand: boolean; state: MemberState; seenAt: number | null;
      tooOld: boolean;
    })[];
    relayLocked: boolean;
  };
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
  /**
   * Whether the user is at another member of the group that has `presence`:
   * the phone keeps quiet then too (spec 2026-10-16-device-group-design § 10).
   * Absent, never.
   */
  groupPresence?: () => boolean;
  clientFactory?: (opts: RelayClientOptions) => RelayClient;
  /**
   * Whether a session is another member's, federated into this hub: a
   * channel never passes one on (no chaining, spec
   * 2026-10-16-device-group-design § 7), and a phone is never woken for one
   * (§ 10). Absent, none is.
   */
  foreign?: (sessionId: string) => boolean;
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
  private joining: { device: string; name: string; kind: string | null; code: string; expiresAt: number } | null = null;
  /**
   * A join the user cancelled, until its code expires: the other device may
   * still confirm it, and the pair the relay then makes is revoked here.
   */
  private cancelledJoin: { device: string; expiresAt: number } | null = null;
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
  private readonly pendingRevokes: PendingRevokes;
  /**
   * This device as a member of its group: the roster, linking, removal and
   * leaving. One for the service's life, so what it knows of the relay
   * (members it cannot pair) reads the same while the remote is off.
   */
  private readonly group: GroupMember;
  /** `ownId`'s answer once known; undefined until then. */
  private knownId: string | null | undefined = undefined;
  private readonly now: () => number;
  /** One for every phone, so its named-path cache serves them all. */
  private readonly files: PhoneFileReader;
  /**
   * The last hello of every device, kept after its channel closes so a
   * member's capabilities are known while it is offline; gone when the
   * device leaves the group or is forgotten.
   */
  private readonly hellos = new Map<string, HelloMessage>();
  private readonly channelListeners = new Set<(id: string, channel: Channel) => void>();
  private readonly statusListeners = new Set<() => void>();

  constructor(private readonly opts: RemoteServiceOptions) {
    this.devices = new DeviceStore(opts.db);
    this.roster = new RosterStore(opts.db);
    this.pendingRevokes = new PendingRevokes(opts.db);
    this.now = opts.now ?? Date.now;
    this.group = new GroupMember(this.groupStorage(), {
      selfId: () => this.runningId,
      about: () => this.selfAbout(),
      knownId: () => this.ownId(),
      relay: () => this.client,
      channels: () => this.channels,
      channel: (id) => this.channels.get(id) ?? null,
      open: (id) => this.open(id),
      paired: (id) => this.watch(id),
      forget: (id) => this.forget(id),
      forgetAll: () => this.forgetAll(),
      changed: () => this.publishStatus(),
      now: () => this.now(),
      log: (message) => console.warn(`[remote] ${message}`),
    });
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
      this.group.addSelf();
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
    this.group.stop();
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
    this.cancelledJoin = null;
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
    if (!this.group.nameChanged()) this.publishStatus();
  }

  /** This device's id, known whether or not the remote runs; null when it never had one. */
  selfId(): string | null {
    return this.ownId();
  }

  /** The roster's live members, this device included; none when the roster cannot be read. */
  liveMembers(): RosterEntry[] {
    try {
      return this.roster.list().filter(isLive);
    } catch (err) {
      console.warn(`[remote] could not read the roster: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** The last hello `id` sent this device, on any channel since it started; null before one. */
  peerHello(id: string): HelloMessage | null {
    return this.hellos.get(id) ?? null;
  }

  /** Called with every channel as it is made, before it starts or is fed. */
  onChannel(listener: (id: string, channel: Channel) => void): () => void {
    this.channelListeners.add(listener);
    return () => { this.channelListeners.delete(listener); };
  }

  /** Called after every status publish: a roster change, a device added or removed, presence. */
  onStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }

  /** This device's id while the remote runs; null while it is off. */
  private get runningId(): string | null {
    return this.identity ? deviceId(this.identity.publicKey) : null;
  }

  /** The roster's digest, for tests that check two members converged. */
  rosterDigest(): string {
    return this.roster.digest();
  }

  /** The whole roster, removed entries included, for tests: the status lists only live members. */
  rosterEntries(): RosterEntry[] {
    return this.roster.list();
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
        ? {
          device: this.joining.device, name: this.joining.name, kind: this.joining.kind, code: this.joining.code,
          expiresAt: this.joining.expiresAt,
        } : null,
      error: this.error,
      group: this.listGroup(online),
    };
  }

  /** As `listDevices`: a database already gone reads as an empty roster. */
  private listGroup(online: Set<string>): RemoteStatus['group'] {
    try {
      const members = this.group.members(online).map((m) => ({
        ...m, tooOld: !m.self && memberTooOld(m.kind, this.hellos.get(m.id) ?? null),
      }));
      return { members, relayLocked: this.group.inGroup() };
    } catch (err) {
      console.warn(`[remote] could not list the roster: ${err instanceof Error ? err.message : String(err)}`);
      return { members: [], relayLocked: false };
    }
  }

  /** See `GroupMember.inGroup`: it cannot join another group then, nor move to another relay. */
  inGroup(): boolean {
    return this.group.inGroup();
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
      secret: toBase64Url(secret), kind: serverDeviceKind(), expiresAt: res.body.expiresAt,
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
    // Paired afresh: a revoke still waiting from an earlier removal must not undo it.
    if (accept) this.pendingRevokes.remove(pending.phone);
    // A stop/start during the post replaced the state; leave the new one be.
    if (this.pendingPair === pending) {
      this.pendingPair = null;
      this.pairing = null;
    }
    if (accept) {
      this.group.addPaired({ id: pending.phone, kind: pending.kind, name: pending.name, os: osName(pending.platform) });
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
    // Groups do not merge (§ 3): a device in one leaves it before it joins
    // another group. A code from a member of its own group is pairing by hand.
    if (this.inGroup() && !this.group.isLiveMember(qr.mac)) return { error: 'in_group' };
    if (!this.enabled || !this.client || !this.identity) return { error: 'disabled' };
    if (this.client.status !== 'online') return { error: 'offline' };
    const self = deviceId(this.identity.publicKey);
    if (qr.mac === self) return { error: 'bad_code' };
    if (this.devices.get(qr.mac)) return { error: 'already_paired' };
    // One relay per group (§ 4), and this server's socket is on its own.
    if (qr.relay.replace(/\/+$/, '') !== this.relayUrl.replace(/\/+$/, '')) return { error: 'other_relay', relay: qr.relay };
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
    const typed = formatFingerprint(fingerprint(publicKeyOf(qr.mac)!, this.identity.publicKey));
    // No code lives longer than `PAIRING_TOKEN_TTL_MS`, whatever it says;
    // one from before it carried its expiry is good for that long.
    const longest = this.now() + PAIRING_TOKEN_TTL_MS;
    const joining = {
      device: qr.mac, name, kind: qr.kind ?? null, code: typed, expiresAt: Math.min(qr.expiresAt ?? longest, longest),
    };
    this.joining = joining;
    // Joining that device again: its confirm is wanted now.
    if (this.cancelledJoin?.device === qr.mac) this.cancelledJoin = null;
    this.publishStatus();
    const res = await this.client.post('/pair/redeem', 'pair.redeem', payload);
    if (res.status !== 200) {
      // A cancel, or a stop/start, during the post replaced the state; leave the new one be.
      if (this.joining === joining) this.joining = null;
      this.publishStatus();
      if (res.relayTooOld) return { error: 'relay_too_old' };
      if (res.status === 409) return qr.expiresAt === undefined ? { error: 'peer_offline' } : { error: 'peer_offline', expiresAt: qr.expiresAt };
      return { error: res.status === 404 ? 'bad_code' : 'relay_error' };
    }
    return { device: qr.mac, name, code: typed };
  }

  /**
   * Stops waiting for the device being joined; false when none was. The
   * relay is not told: the request it holds expires with the code. If the
   * other device confirms it before then, the pair is revoked (`cancelledJoin`).
   */
  cancelJoin(): boolean {
    if (!this.joining) return false;
    this.cancelledJoin = { device: this.joining.device, expiresAt: this.joining.expiresAt };
    this.joining = null;
    this.publishStatus();
    return true;
  }

  /** The channel to a paired device, while one is open. */
  channel(id: string): Channel | null {
    return this.channels.get(id) ?? null;
  }

  /** See `GroupMember.remove`: this device's own id is `leave`. */
  remove(id: string): Promise<RemoveResult> {
    return this.group.remove(id);
  }

  /** See `GroupMember.leave`: only while the relay is online. */
  leave(): Promise<RemoveResult> {
    return this.group.leave();
  }

  /** This device's id, read once from the data dir while the remote is off; null when it never had one. */
  private ownId(): string | null {
    if (this.runningId !== null) this.knownId = this.runningId;
    if (this.knownId === undefined) {
      const identity = readIdentity(this.opts.dataDir);
      this.knownId = identity ? deviceId(identity.publicKey) : null;
    }
    return this.knownId;
  }

  /**
   * A member dropped from the group (`GroupMember`), after it was told so:
   * its channel, watcher and marks go. Its row and its pair at the relay
   * are the group's to remove.
   */
  private forget(id: string): void {
    this.channels.get(id)?.close('revoked');
    this.channels.delete(id);
    this.watchers.get(id)?.stop();
    this.watchers.delete(id);
    this.phonesTooOld.delete(id);
    this.hellos.delete(id);
  }

  /** This device left its group (`GroupMember`): every channel, watcher and mark goes. */
  private forgetAll(): void {
    for (const channel of this.channels.values()) channel.close('revoked');
    this.channels.clear();
    for (const w of this.watchers.values()) w.stop();
    this.watchers.clear();
    this.phonesTooOld.clear();
    this.hellos.clear();
  }

  /** The device rows as the group reads and writes them; a pair it adds gets the default notifications. */
  private groupStorage(): GroupStorage {
    return {
      roster: this.roster,
      pendingRevokes: this.pendingRevokes,
      paired: {
        list: () => this.devices.list(),
        get: (id) => this.devices.get(id),
        add: (d) => this.devices.add({ ...d, notifications: parseNotificationSettings(this.opts.allSettings()) }),
        remove: (id) => this.devices.remove(id),
      },
    };
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
    this.hellos.clear();
    console.warn(`[remote] the Mac's identity was regenerated; removed ${all.length} paired phone(s), which must pair again`);
  }

  private onControl(msg: RelayToDevice): void {
    if (msg.type === 'ok') {
      for (const device of this.devices.list()) this.open(device.id);
      this.group.relayOk();
      return;
    }
    if (msg.type === 'linked') {
      this.group.relayLinked(msg.peer);
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
      this.hellos.delete(msg.mac);
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
      // Paired afresh: a revoke still waiting from an earlier removal must not undo it.
      this.pendingRevokes.remove(joined.device);
      // A code without a kind came from a Mac from before kinds. Its OS is
      // not known until its hello.
      this.group.addPaired({ id: joined.device, kind: joined.kind ?? 'desktop', name: joined.name, os: '' });
      this.publishStatus();
      this.open(joined.device);
      return;
    }
    // Confirmed on the other device after the user cancelled here: the pair goes again, the device is never added.
    if (msg.type === 'paired' && this.cancelledJoin && msg.mac === this.cancelledJoin.device) {
      const cancelled = this.cancelledJoin;
      this.cancelledJoin = null;
      if (cancelled.expiresAt > this.now()) this.group.tryRoster('revoke a cancelled join', () => this.group.revokeAtRelay(cancelled.device));
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
      ...(this.opts.foreign ? { foreign: this.opts.foreign } : {}),
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
      if (event.type === 'hello') {
        this.hellos.set(from, event.hello);
        this.group.onPeerHello(from, opened, event.hello);
      }
      if (event.type === 'ready' && event.ready) this.group.channelReady(opened);
      if (event.type === 'group') this.group.onGroup(from, opened, event.msg);
    });
    this.channels.set(from, opened);
    for (const listener of [...this.channelListeners]) {
      try {
        listener(from, opened);
      } catch (err) {
        console.warn(`[remote] a channel listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return opened;
  }

  /**
   * What this device says about itself in the roster, cut to the bounds a
   * roster entry is read within: an entry past them would refuse the whole
   * roster on every other member.
   */
  private selfAbout(): SelfAbout {
    return {
      kind: serverDeviceKind(), name: this.macName.slice(0, PAIR_NAME_MAX_CHARS),
      os: osName(process.platform).slice(0, ROSTER_KIND_MAX_CHARS), links: true,
    };
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
      quiet: () => (this.opts.presence?.atMac ?? false) || (this.opts.groupPresence?.() ?? false),
      ...(this.opts.foreign ? { foreign: this.opts.foreign } : {}),
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
    for (const listener of [...this.statusListeners]) {
      try {
        listener();
      } catch (err) {
        console.warn(`[remote] a status listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
