/**
 * The Mac side of the mobile remote, assembled: identity, the relay
 * connection, pairing, one `DeviceWatcher` per paired phone (alive while the
 * service runs) and one `Channel` per connected device (alive per
 * connection). Off is the default and off means nothing here is constructed
 * (spec 2026-09-30-mobile-remote-design § 3).
 */
import { join } from 'node:path';
import { deviceId, publicKeyOf, type Identity } from '@orbital/shared/remote/keys';
import { FLAG_STATE, FLAG_WAKE, ZERO_WAKE, decodeFrame, encodeFrame } from '@orbital/shared/remote/frame';
import { PAIR_NAME_MAX_CHARS, type RelayToDevice } from '@orbital/shared/remote/relayApi';
import { initiates, osName } from '@orbital/shared/remote/device';
import type { Role } from '@orbital/shared/remote/handshake';
import { parseNotificationSettings } from '@orbital/shared/notifications';
import type { Channel } from '@orbital/shared/remote/channel';
import type { HelloMessage } from '@orbital/shared/remote/messages';
import { ROSTER_KIND_MAX_CHARS, isLive, type RosterEntry } from '@orbital/shared/remote/roster';
import {
  GroupMember, type GroupStorage, type MemberState, type RemoveResult, type SelfAbout,
} from '@orbital/shared/remote/group';
import {
  PairingCeremony, type JoinResult, type PairConfirmResult, type StartPairingResult,
} from '@orbital/shared/remote/ceremony';
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

export {
  PAIR_CODE_ATTEMPTS, UNKNOWN_PHONE_NAME, type JoinResult, type PairConfirmResult,
} from '@orbital/shared/remote/ceremony';

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
  /**
   * The pairing ceremonies: a code shown here and the device that redeemed
   * it, and a code of another device redeemed here. One for the service's
   * life; a stop forgets what was in progress (`reset`).
   */
  private readonly ceremony: PairingCeremony;
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
    this.ceremony = new PairingCeremony({
      enabled: () => this.enabled,
      identity: () => this.identity,
      relay: () => this.client,
      relayTooOld: () => this.relayRefusal !== null,
      relayUrl: () => this.relayUrl,
      relaySecret: () => this.relaySecret,
      self: () => ({ name: this.macName, platform: osName(process.platform), kind: serverDeviceKind() }),
      inGroup: () => this.group.inGroup(),
      isLiveMember: (id) => this.group.isLiveMember(id),
      paired: {
        get: (id) => this.devices.get(id),
        add: (d) => this.devices.add({ ...d, notifications: parseNotificationSettings(this.opts.allSettings()) }),
        remove: (id) => this.devices.remove(id),
      },
      pendingRevokes: this.pendingRevokes,
      addPaired: (device) => this.group.addPaired(device),
      revokeCancelled: (id) => this.group.tryRoster('revoke a cancelled join', () => this.group.revokeAtRelay(id)),
      watch: (id) => this.watch(id),
      abandon: (id) => {
        this.channels.get(id)?.close();
        this.channels.delete(id);
        this.watchers.get(id)?.stop();
        this.watchers.delete(id);
      },
      open: (id) => this.open(id),
      announce: (pending) => this.opts.hub.publish('remote', { event: 'pair_request', ...pending }),
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
    this.ceremony.reset();
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
    const ceremony = this.ceremony.state();
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
      pendingPair: ceremony.pendingPair,
      pairing: ceremony.pairing,
      joining: ceremony.joining,
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

  /** See `PairingCeremony.start`. */
  startPairing(): Promise<StartPairingResult> {
    return this.ceremony.start();
  }

  /** See `PairingCeremony.confirm`. */
  confirmPairing(accept: boolean, phone: string, code?: string): Promise<PairConfirmResult> {
    return this.ceremony.confirm(accept, phone, code);
  }

  /** See `PairingCeremony.join`. */
  join(code: string): Promise<JoinResult> {
    return this.ceremony.join(code);
  }

  /** See `PairingCeremony.cancelJoin`. */
  cancelJoin(): boolean {
    return this.ceremony.cancelJoin();
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
    // A pairing this device is in; any other `paired` or `rejected` is not for it.
    if (msg.type === 'paired' && this.ceremony.onPaired(msg.mac)) return;
    if (msg.type === 'rejected' && this.ceremony.onRejected(msg.mac)) return;
    if (msg.type === 'pair_request') {
      this.ceremony.onPairRequest(msg);
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
