/**
 * This Mac as a client of other Macs (spec 2026-10-06-peer-macs-design § 2):
 * one `RemoteClient` per paired Mac — the phone's own client, so the relay
 * sees a phone — that keeps the peer's sessions in memory, republishes them
 * into the local hub marked with their machine, and carries every request
 * for one of them through the tunnel. What a peer tells us about a third
 * Mac is never taken in, and nothing here is passed on to another peer.
 */
import WebSocket from 'ws';
import {
  fingerprint, formatFingerprint, fromBase64Url, generateIdentity, identityFromSecret, publicKeyOf,
  toBase64Url, type Identity,
} from '@orbital/shared/remote/keys';
import { QrPayload } from '@orbital/shared/remote/relayApi';
import {
  RemoteClient, type BlobResult, type FileResult, type HttpMethod, type SocketConstructor, type TunnelResponse,
} from '@orbital/shared/remote/client';
import type { Hub } from '../api/hub.js';
import type { FileAs } from '@orbital/shared/remote/messages';
import type { PhoneFileAnswer } from '../remote/phoneFiles.js';
import type { PeerReads } from '../remote/phoneSession.js';
import { PEER_PLATFORM } from '../remote/service.js';
import { PeerStore, type StoredPeer } from './store.js';

/** What `hello` names this client as: no version, so a host never refuses it as a phone app too old. */
export const PEER_APP = 'orbital-mac';
/** The hub topic Settings → Devices listens on for paired Macs and a pairing in progress. */
export const PEERS_TOPIC = 'peers';
/** How many sessions are asked of a peer at once; one tunnel frame has to carry the answer. */
const SEED_LIMITS = [200, 80, 30];
/** How long a pairing waits for the relay before it gives up. */
const CONNECT_WAIT_MS = 15_000;

/** Which Mac a session runs on; absent on a session of this Mac. */
export type MachineRef = { id: string; name: string; online: boolean };

export type PeerStatus = {
  id: string;
  name: string;
  /** The tunnel is up and the peer said hello. */
  online: boolean;
  pairedAt: number;
};

/** A pairing this Mac started as a client: the code to type on the other Mac. */
export type PeerPairing = { mac: string; name: string; code: string };

type Session = { id: string; tagIds?: number[]; status?: string; machine?: unknown; [key: string]: unknown };
type Tag = { id: number; name: string; hue?: number };

export type PeerServiceOptions = {
  dataDir: string;
  hub: Hub;
  /** This Mac's name, sealed into a redeem for the other Mac's confirmation. */
  macName: () => string;
  /** This Mac's tags: a peer's tags are matched to them by name. */
  localTags: () => Tag[];
  /**
   * This Mac's own pairing code, made to be redeemed without a typed code:
   * sent to a Mac just paired so it becomes a client of this one too (§ 1
   * step 4). Null when this Mac's remote is off.
   */
  offerCode: () => Promise<string | null>;
  WebSocketImpl?: SocketConstructor;
};

class PeerLink {
  readonly sessions = new Map<string, Session>();
  /** The peer's tags by id, read at every seed. */
  tags = new Map<number, Tag>();

  constructor(readonly stored: StoredPeer, readonly client: RemoteClient) {}

  get id(): string {
    return this.stored.mac;
  }

  get machine(): MachineRef {
    return { id: this.stored.mac, name: this.stored.name, online: this.client.ready };
  }
}

export class PeerService {
  private readonly store: PeerStore;
  private readonly links = new Map<string, PeerLink>();
  private pairing: (PeerPairing & { client: RemoteClient }) | null = null;
  private readonly WebSocketImpl: SocketConstructor;

  constructor(private readonly opts: PeerServiceOptions) {
    this.store = new PeerStore(opts.dataDir);
    this.WebSocketImpl = opts.WebSocketImpl ?? WebSocket;
    opts.hub.onFirstSubscriber((topic) => this.followTopic(topic, true));
    opts.hub.onLastUnsubscriber((topic) => this.followTopic(topic, false));
  }

  start(): void {
    for (const stored of this.store.list()) {
      if (this.links.has(stored.mac)) continue;
      const client = this.makeClient(stored, identityFromSecret(fromBase64Url(stored.secretKey)), true);
      this.adopt(stored, client);
      client.start();
    }
  }

  stop(): void {
    for (const link of this.links.values()) link.client.stop();
    this.links.clear();
    this.pairing?.client.stop();
    this.pairing = null;
  }

  status(): { peers: PeerStatus[]; pairing: PeerPairing | null } {
    return {
      peers: [...this.links.values()].map((l) => ({
        id: l.id, name: l.stored.name, online: l.client.ready, pairedAt: l.stored.pairedAt,
      })),
      pairing: this.pairing ? { mac: this.pairing.mac, name: this.pairing.name, code: this.pairing.code } : null,
    };
  }

  /**
   * Redeems another Mac's pairing code as its client. Answers once the
   * relay passed the redeem on, with the code the user types on that Mac;
   * the pair itself completes when that Mac confirms. `auto`: the code came
   * from a Mac this one is already a client of (§ 1 step 4), which accepts
   * without a typed code, and no code goes back to it.
   */
  async pair(code: string, opts: { auto?: boolean } = {}): Promise<PeerPairing | { error: string }> {
    const qr = parsePairingCode(code);
    if (!qr) return { error: 'bad_code' };
    if (this.links.has(qr.mac)) return { error: 'already_paired' };
    if (this.pairing && !opts.auto) {
      this.pairing.client.stop();
      this.pairing = null;
    }
    const identity = generateIdentity();
    const stored: StoredPeer = {
      mac: qr.mac, name: qr.name, relayUrl: qr.relay, secretKey: toBase64Url(identity.secretKey), pairedAt: Date.now(),
      ...(qr.relaySecret ? { relaySecret: qr.relaySecret } : {}),
    };
    const client = this.makeClient(stored, identity, false);
    client.start();
    if (!(await waitOnline(client))) {
      client.stop();
      return { error: 'relay_unreachable' };
    }
    const outcome = client.waitForPairing();
    const res = await client.redeem(qr.token, qr.secret, this.opts.macName(), PEER_PLATFORM);
    if (res.status !== 200) {
      client.stop();
      return { error: res.status === 0 ? 'relay_unreachable' : 'code_refused' };
    }
    const pairing: PeerPairing = {
      mac: qr.mac, name: qr.name, code: formatFingerprint(fingerprint(publicKeyOf(qr.mac)!, identity.publicKey)),
    };
    if (!opts.auto) {
      this.pairing = { ...pairing, client };
      this.publish();
    }
    void outcome.then((result) => {
      if (this.pairing?.client === client) this.pairing = null;
      if (result !== 'paired') {
        client.stop();
        this.publish();
        return;
      }
      this.store.put(stored);
      const link = this.adopt(stored, client);
      this.publish();
      if (!opts.auto) void this.offerBack(link);
    });
    return pairing;
  }

  /** Forgets a paired Mac here; its sessions leave the map. */
  remove(mac: string): boolean {
    const link = this.links.get(mac);
    if (!link) return false;
    link.client.stop();
    this.links.delete(mac);
    this.store.remove(mac);
    for (const id of link.sessions.keys()) this.opts.hub.publish('sessions', { event: 'remove', sessionId: id });
    this.publish();
    return true;
  }

  /** The peer a session belongs to; null for this Mac's own and for one nobody knows. */
  linkOf(sessionId: string): PeerLink | null {
    for (const link of this.links.values()) if (link.sessions.has(sessionId)) return link;
    return null;
  }

  link(mac: string): PeerLink | null {
    return this.links.get(mac) ?? null;
  }

  /** Every peer's sessions as this Mac shows them. */
  sessions(): Session[] {
    return [...this.links.values()].flatMap((l) => [...l.sessions.values()].map((s) => this.localize(l, s)));
  }

  async request(link: PeerLink, method: HttpMethod, path: string, body?: unknown): Promise<TunnelResponse> {
    if (!link.client.ready) return { status: 409, body: { error: 'peer_offline' } };
    try {
      const res = await link.client.request(method, path, body);
      const payload = res.body as { session?: Session } | null;
      if (payload && typeof payload === 'object' && payload.session && typeof payload.session.id === 'string') {
        return { status: res.status, body: { ...payload, session: this.localize(link, payload.session) } };
      }
      return res;
    } catch {
      return { status: 502, body: { error: 'peer_unreachable' } };
    }
  }

  /** `PUT /api/sessions/:id/tags` on a peer: this Mac's tag ids become the peer's, by name. */
  async setTags(link: PeerLink, sessionId: string, localIds: number[]): Promise<TunnelResponse> {
    const peerIds: number[] = [];
    for (const id of localIds) {
      const peerId = await this.peerTagId(link, id);
      if (peerId !== null) peerIds.push(peerId);
    }
    return this.request(link, 'PUT', `/api/sessions/${sessionId}/tags`, { tagIds: peerIds });
  }

  /** The peer's tag of the same name as this Mac's tag `localId`, made there when it has none. */
  async peerTagId(link: PeerLink, localId: number): Promise<number | null> {
    const tag = this.opts.localTags().find((t) => t.id === localId);
    if (!tag) return null;
    for (const t of link.tags.values()) if (t.name === tag.name) return t.id;
    const made = await this.request(link, 'POST', '/api/tags', { name: tag.name, hue: tag.hue ?? 0 });
    const madeId = (made.body as { id?: unknown } | null)?.id;
    if (made.status !== 201 || typeof madeId !== 'number') return null;
    link.tags.set(madeId, { id: madeId, name: tag.name, hue: tag.hue });
    return madeId;
  }

  /**
   * A composer's images go to the peer's own store before the message that
   * names them; the store names an image by its hash, so the refs come back
   * as they went. Null when one could not be sent.
   */
  async upload(link: PeerLink, refs: string[], read: (ref: string) => { bytes: Uint8Array; mediaType: string } | null): Promise<string[] | null> {
    const out: string[] = [];
    for (const ref of refs) {
      const image = read(ref);
      if (!image || !link.client.ready) return null;
      try {
        const res = await link.client.putBlob(image.bytes, image.mediaType);
        if (res.kind !== 'ok') return null;
        out.push(res.entry.ref);
      } catch {
        return null;
      }
    }
    return out;
  }

  /** A stored image of some peer's session, by ref: asked of every peer that is up. */
  async blob(ref: string, edge?: number): Promise<BlobResult | null> {
    for (const link of this.links.values()) {
      if (!link.client.ready) continue;
      try {
        const res = await link.client.getBlob(ref, edge !== undefined ? { edge } : {});
        if (res.status === 200) return res;
      } catch {
        /* the next peer */
      }
    }
    return null;
  }

  async file(link: PeerLink, sessionId: string, path: string, as: FileAs, cwd?: string): Promise<FileResult | null> {
    if (!link.client.ready) return null;
    try {
      return await link.client.getFile(sessionId, path, as, cwd ? { cwd } : {});
    } catch {
      return null;
    }
  }

  /** What a phone on this Mac reads of a peer's session, through this Mac. */
  readsForPhones(): PeerReads {
    return {
      owns: (id) => this.linkOf(id) !== null,
      blob: (ref, edge) => this.blob(ref, edge),
      file: async (session, path, as, cwd) => {
        const link = this.linkOf(session);
        const res = link ? await this.file(link, session, path, as, cwd) : null;
        if (!res) return { status: 404 };
        return {
          status: res.status as PhoneFileAnswer['status'],
          ...(res.status === 200 ? { bytes: res.bytes } : {}),
          ...(res.mediaType ? { mediaType: res.mediaType } : {}),
          ...(res.size !== null ? { size: res.size } : {}),
          ...(res.w !== null && res.h !== null ? { w: res.w, h: res.h } : {}),
        };
      },
    };
  }

  private makeClient(stored: StoredPeer, identity: Identity, expectPaired: boolean): RemoteClient {
    return new RemoteClient({
      relayUrl: stored.relayUrl, mac: stored.mac, identity, WebSocketImpl: this.WebSocketImpl, app: PEER_APP,
      expectPaired, ...(stored.relaySecret ? { relaySecret: stored.relaySecret } : {}),
    });
  }

  private adopt(stored: StoredPeer, client: RemoteClient): PeerLink {
    const link = new PeerLink(stored, client);
    this.links.set(stored.mac, link);
    client.subscribe('sessions');
    client.on((event) => {
      if (this.links.get(stored.mac) !== link) return;
      switch (event.type) {
        case 'ready':
          if (event.ready) void this.seed(link);
          else this.republish(link);
          this.publish();
          return;
        case 'hub':
          this.onHub(link, event.frame);
          return;
        case 'unpaired':
        case 'bye':
          if (event.type === 'unpaired' || event.reason === 'revoked') this.remove(stored.mac);
          return;
      }
    });
    return link;
  }

  /** The peer's sessions and tags, read afresh whenever its tunnel comes up. */
  private async seed(link: PeerLink): Promise<void> {
    const tags = await this.request(link, 'GET', '/api/tags');
    const tagList = (tags.body as { tags?: Tag[] } | null)?.tags;
    if (tags.status === 200 && Array.isArray(tagList)) link.tags = new Map(tagList.map((t) => [t.id, t]));
    for (const limit of SEED_LIMITS) {
      const res = await this.request(link, 'GET', `/api/sessions?limit=${limit}`);
      if (res.status === 413) continue;
      const list = (res.body as { sessions?: Session[] } | null)?.sessions;
      if (res.status !== 200 || !Array.isArray(list)) return;
      const fresh = new Map(list.filter((s) => s.machine === undefined).map((s) => [s.id, s]));
      for (const id of link.sessions.keys()) {
        if (!fresh.has(id)) this.opts.hub.publish('sessions', { event: 'remove', sessionId: id });
      }
      link.sessions.clear();
      for (const [id, s] of fresh) {
        link.sessions.set(id, s);
        // A window that subscribed before this peer's list came in.
        if (this.opts.hub.subscriberCount(`session:${id}`) > 0) link.client.subscribe(`session:${id}`);
      }
      this.republish(link);
      return;
    }
  }

  private republish(link: PeerLink): void {
    for (const s of link.sessions.values()) {
      this.opts.hub.publish('sessions', { event: 'upsert', session: this.localize(link, s) });
    }
  }

  private onHub(link: PeerLink, raw: unknown): void {
    const frame = raw as { topic?: unknown; event?: unknown; [key: string]: unknown } | null;
    if (!frame || typeof frame.topic !== 'string') return;
    const { topic, ...rest } = frame;
    if (topic !== 'sessions') {
      if (this.opts.hub.subscriberCount(topic) > 0) this.opts.hub.publish(topic, rest);
      return;
    }
    if (frame.event === 'upsert') {
      const session = frame.session as Session | undefined;
      // Another Mac's session, passed on by this peer: not ours to show (no chaining).
      if (!session || typeof session.id !== 'string' || session.machine !== undefined) return;
      if (!link.sessions.has(session.id) && this.opts.hub.subscriberCount(`session:${session.id}`) > 0) {
        // Spawned from here: the window subscribed before the peer knew the id.
        link.client.subscribe(`session:${session.id}`);
      }
      link.sessions.set(session.id, session);
      this.opts.hub.publish('sessions', { event: 'upsert', session: this.localize(link, session) });
    } else if (frame.event === 'remove') {
      const id = frame.sessionId as string;
      if (link.sessions.delete(id)) this.opts.hub.publish('sessions', { event: 'remove', sessionId: id });
    } else if (frame.event === 'status') {
      const id = frame.sessionId as string;
      const session = link.sessions.get(id);
      if (!session) return;
      session.status = frame.status as string;
      this.opts.hub.publish('sessions', rest);
    }
  }

  /** A peer's session as this Mac shows it: its machine named, its tags this Mac's of the same name. */
  private localize(link: PeerLink, session: Session): Session {
    const local = new Map(this.opts.localTags().map((t) => [t.name, t.id]));
    const tagIds = (session.tagIds ?? [])
      .map((id) => local.get(link.tags.get(id)?.name ?? ''))
      .filter((id): id is number => id !== undefined);
    return { ...session, tagIds, machine: link.machine };
  }

  private followTopic(topic: string, on: boolean): void {
    const sessionId = sessionOfTopic(topic);
    if (!sessionId) return;
    const link = this.linkOf(sessionId);
    if (!link) return;
    if (on) link.client.subscribe(topic);
    else link.client.unsubscribe(topic);
  }

  private async offerBack(link: PeerLink): Promise<void> {
    if (!(await waitReady(link.client))) return;
    const code = await this.opts.offerCode();
    if (code) await this.request(link, 'POST', '/api/peers/offer', { code });
  }

  private publish(): void {
    this.opts.hub.publish(PEERS_TOPIC, { event: 'status', ...this.status() });
  }
}

/** The session a per-session topic is about: `session:<id>`, `subagent:<id>:…`, `task-output:<id>:…`. */
export function sessionOfTopic(topic: string): string | null {
  const m = /^(?:session|subagent|task-output):([^:]+)/.exec(topic);
  return m ? m[1] : null;
}

/**
 * A pairing code as one Mac shows it to another: the QR's JSON, either
 * as is or base64url-encoded so it pastes as one word.
 */
export function parsePairingCode(code: string): QrPayload | null {
  const text = code.trim();
  const candidates = [text];
  try {
    candidates.push(new TextDecoder().decode(fromBase64Url(text)));
  } catch {
    /* not base64url */
  }
  for (const candidate of candidates) {
    try {
      const parsed = QrPayload.safeParse(JSON.parse(candidate));
      if (parsed.success && publicKeyOf(parsed.data.mac)) return parsed.data;
    } catch {
      /* the next form */
    }
  }
  return null;
}

/** The QR's JSON as one word to copy (`parsePairingCode` reads it back). */
export function encodePairingCode(qr: string): string {
  return toBase64Url(new TextEncoder().encode(qr));
}

function waitOnline(client: RemoteClient): Promise<boolean> {
  return waitFor(client, () => client.status === 'online');
}

function waitReady(client: RemoteClient): Promise<boolean> {
  return waitFor(client, () => client.ready);
}

function waitFor(client: RemoteClient, cond: () => boolean): Promise<boolean> {
  if (cond()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(false);
    }, CONNECT_WAIT_MS);
    const off = client.on(() => {
      if (!cond()) return;
      clearTimeout(timer);
      off();
      resolve(true);
    });
  });
}
