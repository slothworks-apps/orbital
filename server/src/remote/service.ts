/**
 * The Mac side of the mobile remote, assembled: identity, the relay
 * connection, pairing, one `DeviceWatcher` per paired phone (alive while the
 * service runs) and one `PhoneSession` per connected phone (alive per
 * connection). Off is the default and off means nothing here is constructed
 * (spec 2026-09-30-mobile-remote-design § 3).
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  deviceId, fingerprint, normalizePairingCode, publicKeyOf, toBase64Url, type Identity,
} from '@orbital/shared/remote/keys';
import { FLAG_STATE, FLAG_WAKE, ZERO_WAKE, decodeFrame, encodeFrame } from '@orbital/shared/remote/frame';
import {
  PAIRING_SECRET_BYTES, verifyPairingProof, type QrPayload, type RelayToDevice,
} from '@orbital/shared/remote/relayApi';
import { parseNotificationSettings } from '@orbital/shared/notifications';
import type { RelayTooOld } from '@orbital/shared/remote/version';
import type { Hub } from '../api/hub.js';
import { CONFIG } from '../config.js';
import type { OrbitalDb } from '../db/database.js';
import type { ImageStore } from '../images/store.js';
import { DeviceStore, type RemoteDevice } from './devices.js';
import { DeviceWatcher } from './deviceWatcher.js';
import { loadOrCreateIdentity, macDisplayName } from './identity.js';
import { createPhoneFileReader, type PhoneFileReader } from './phoneFiles.js';
import type { WorkingTrees } from '../git/workingTrees.js';
import { PhoneSession, type InjectFn, type PhoneTooOld } from './phoneSession.js';
import { RelayClient, type RelayClientOptions, type RelayRefusal } from './relayClient.js';
import { wakeSecret, wakeToken } from './wake.js';

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
 * The answer to a pairing request. `no_pending`: nothing to answer, or a
 * different phone than the one asked about. `code_mismatch`: a wrong code,
 * the request still waits. `code_rejected`: the last wrong code, the request
 * was rejected. `relay_error`: the relay did not take the answer.
 */
export type PairConfirmResult =
  | { ok: true }
  | { error: 'no_pending' | 'code_rejected' | 'relay_error' }
  | { error: 'code_mismatch'; attemptsLeft: number };

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
  pendingPair: { phone: string; name: string; platform: string; attemptsLeft: number } | null;
  pairing: { expiresAt: number } | null;
  /** Why the last `start` failed; null while it is fine. */
  error: string | null;
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
  clientFactory?: (opts: RelayClientOptions) => RelayClient;
};

export class RemoteService {
  private identity: Identity | null = null;
  private client: RelayClient | null = null;
  private readonly devices: DeviceStore;
  private readonly watchers = new Map<string, DeviceWatcher>();
  private readonly sessions = new Map<string, PhoneSession>();
  /** `code` is the fingerprint the phone shows; `attemptsLeft` counts down in place, so the object stays the one a confirm in flight compares against. */
  private pendingPair: (NonNullable<RemoteStatus['pendingPair']> & { code: string }) | null = null;
  /** `secret` went into the QR and only there; a `pair_request` must prove it (`verifyPairingProof`). */
  private pairing: { expiresAt: number; secret: Uint8Array } | null = null;
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
  private readonly now: () => number;
  /** One for every phone, so its named-path cache serves them all. */
  private readonly files: PhoneFileReader;

  constructor(private readonly opts: RemoteServiceOptions) {
    this.devices = new DeviceStore(opts.db);
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
      const client = (this.opts.clientFactory ?? ((o) => new RelayClient(o)))({
        relayUrl: this.relayUrl, identity: this.identity, relaySecret: this.relaySecret,
      });
      this.client = client;
      client.on('status', () => {
        // A new connection means new session keys: every phone re-handshakes.
        if (client.status !== 'online') this.closeSessions();
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
    this.closeSessions();
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
  }

  /** Re-reads every setting: a toggle or a relay URL change applies now. */
  settingsChanged(): void {
    this.stop();
    this.start();
  }

  /**
   * The Mac's name changed. `macName` is read fresh for every pairing code and
   * every new phone session, so nothing restarts; the status is published so
   * every window shows the new name.
   */
  nameChanged(): void {
    this.publishStatus();
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
      error: this.error,
    };
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
    const res = await this.client.post<{ token: string; expiresAt: number }>('/pair/token', 'pair.token', { name: this.macName });
    if (res.relayTooOld) return { error: 'relay_too_old' };
    if (res.status !== 200) return { error: 'relay_error' };
    const secret = new Uint8Array(randomBytes(PAIRING_SECRET_BYTES));
    this.pairing = { expiresAt: res.body.expiresAt, secret };
    this.pendingPair = null;
    const qr: QrPayload = {
      v: 1, relay: this.relayUrl, mac: deviceId(this.identity.publicKey), name: this.macName, token: res.body.token,
      secret: toBase64Url(secret),
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
        id: pending.phone, name: pending.name, platform: pending.platform, pairedAt: this.now(),
        notifications: parseNotificationSettings(this.opts.allSettings()),
      });
      this.watch(pending.phone);
    }
    const res = await this.client.post('/pair/confirm', 'pair.confirm', { phone: pending.phone, accept });
    if (res.status !== 200) {
      // The relay never paired it: undo what was added above. A device that
      // was already paired before this confirm is not ours to remove.
      if (accept && !existed) {
        this.sessions.get(pending.phone)?.close();
        this.sessions.delete(pending.phone);
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
    this.publishStatus();
    return { ok: true };
  }

  /**
   * Local first and unconditionally: the phone loses access on this Mac the
   * moment the user asks, remote on or off. Telling the relay is best effort
   * on top — a phone it still thinks is paired can reach nothing here.
   */
  async revoke(id: string): Promise<boolean> {
    if (!this.devices.get(id)) return false;
    this.sessions.get(id)?.close('revoked');
    this.sessions.delete(id);
    this.watchers.get(id)?.stop();
    this.watchers.delete(id);
    this.devices.remove(id);
    this.phonesTooOld.delete(id);
    this.publishStatus();
    const client = this.client;
    if (client && client.status === 'online') {
      const res = await client.post('/pair/revoke', 'pair.revoke', { phone: id });
      if (res.status !== 200) console.warn(`[remote] relay revoke of ${id} failed: ${res.status}`);
    }
    return true;
  }

  /**
   * After the identity file was unreadable and replaced: every phone paired
   * with the old key verifies the Mac against that key and can never
   * handshake again, so listing them would only lie.
   */
  private forgetAllDevices(): void {
    const all = this.devices.list();
    if (all.length === 0) return;
    for (const d of all) this.devices.remove(d.id);
    console.warn(`[remote] the Mac's identity was regenerated; removed ${all.length} paired phone(s), which must pair again`);
  }

  private onControl(msg: RelayToDevice): void {
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
      this.pendingPair = {
        phone: msg.phone, name: msg.name, platform: msg.platform,
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
      this.sessions.get(msg.peer)?.close();
      this.sessions.delete(msg.peer);
      if (msg.online) this.devices.touch(msg.peer, this.now());
      this.publishStatus();
    }
  }

  private onData(buf: Uint8Array): void {
    const frame = decodeFrame(buf);
    if (!frame || !this.identity || !this.client) return;
    const from = deviceId(frame.peer);
    const device = this.devices.get(from);
    if (!device || frame.body.length === 0) return;
    let session = this.sessions.get(from);
    if (!session) {
      const phonePublicKey = new Uint8Array(frame.peer);
      const client = this.client;
      session = new PhoneSession({
        deviceId: from, identity: this.identity, phonePublicKey, hub: this.opts.hub,
        inject: this.opts.inject, images: this.opts.images, imagesDir: this.opts.imagesDir, files: this.files,
        serverVersion: this.opts.serverVersion, macName: this.macName,
        notifications: {
          get: () => this.devices.get(from)?.notifications ?? device.notifications,
          set: (s) => this.devices.setNotifications(from, s),
        },
        send: (body) => client.sendData(encodeFrame({ peer: phonePublicKey, flags: 0, wake: ZERO_WAKE, body })),
        onSeen: (sessionId) => this.watchers.get(from)?.seen(sessionId),
        onClose: () => {
          if (this.sessions.get(from) === session) this.sessions.delete(from);
        },
        onAppVersion: (refusal) => this.markPhoneVersion(from, refusal),
      });
      this.sessions.set(from, session);
    }
    session.receive(frame.body);
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

  private watch(id: string): void {
    if (this.watchers.has(id) || !this.identity) return;
    const secret = wakeSecret(this.identity);
    const phoneKey = publicKeyOf(id);
    if (!phoneKey) return;
    const watcher = new DeviceWatcher({
      deviceId: id, hub: this.opts.hub,
      settings: () => this.devices.get(id)?.notifications ?? parseNotificationSettings({}),
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

  private closeSessions(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }

  private publishStatus(): void {
    this.opts.hub.publish('remote', { event: 'status', ...this.status() });
  }
}
