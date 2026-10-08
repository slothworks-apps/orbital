import WebSocket from 'ws';
import { generateIdentity, deviceId, fromBase64Url, publicKeyOf, type Identity } from '@orbital/shared/remote/keys';
import { startHandshake, type Handshake, type SessionCipher } from '@orbital/shared/remote/handshake';
import { ZERO_WAKE, decodeFrame, encodeFrame } from '@orbital/shared/remote/frame';
import {
  MacMessage, PROTOCOL_VERSION, decodeInner, encodeInner, type Inner, type PhoneMessage,
} from '@orbital/shared/remote/messages';
import {
  QrPayload, RelayToDevice, authSignature, pairingProof, relayWsUrl, sealPairingDevice, signRequest,
} from '@orbital/shared/remote/relayApi';

type Waiter = { match: (x: unknown) => boolean; resolve: (x: any) => void; timer: ReturnType<typeof setTimeout> };

/** What a paired phone keeps from the QR to reconnect later, without the one-time token. */
export type StoredPair = { relay: string; mac: string };

export class FakePhone {
  readonly control: RelayToDevice[] = [];
  readonly messages: MacMessage[] = [];
  readonly blobs: Extract<Inner, { kind: 'blob' }>[] = [];
  private ws: WebSocket | null = null;
  private hs: Handshake | null = null;
  private cipher: SessionCipher | null = null;
  private macKey: Uint8Array | null = null;
  private waiters: Waiter[] = [];
  private relayUrl = '';
  private token = '';
  private secret: Uint8Array | null = null;

  /** Pass an identity to play the same phone again, as after an app restart. */
  constructor(readonly identity: Identity = generateIdentity()) {}

  get id(): string {
    return deviceId(this.identity.publicKey);
  }

  /** Reads the QR, then connects anchored to that Mac — the order a real phone follows. */
  async connect(qrText: string): Promise<void> {
    const qr = QrPayload.parse(JSON.parse(qrText));
    this.token = qr.token;
    this.secret = fromBase64Url(qr.secret);
    await this.connectStored({ relay: qr.relay, mac: qr.mac });
  }

  /** Reconnects a phone that paired before: the relay and Mac it kept, no token. */
  async connectStored(pair: StoredPair): Promise<void> {
    this.relayUrl = pair.relay;
    this.macKey = publicKeyOf(pair.mac);
    const ws = new WebSocket(relayWsUrl(pair.relay, pair.mac));
    this.ws = ws;
    ws.on('message', (raw, isBinary) => (isBinary ? this.onData(new Uint8Array(raw as Buffer)) : this.onControl((raw as Buffer).toString('utf8'))));
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const challenge = await this.nextControl('challenge');
    ws.send(JSON.stringify({ type: 'auth', pub: this.id, sig: authSignature(this.identity, (challenge as any).nonce) }));
    await this.nextControl('ok');
  }

  async redeem(name = 'Pixel', platform = 'android'): Promise<{ status: number; body: any }> {
    if (!this.secret) throw new Error('connect from a QR first');
    const proof = pairingProof(this.secret, this.identity.publicKey);
    const res = await fetch(new URL('/pair/redeem', this.relayUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signRequest(this.identity, 'pair.redeem', {
        token: this.token, proof, device: sealPairingDevice(this.secret, this.identity.publicKey, { name, platform }),
      })),
    });
    return { status: res.status, body: await res.json() };
  }

  /** Sends the initiator half and waits for the responder half. */
  async handshake(): Promise<void> {
    if (!this.macKey) throw new Error('redeem first');
    this.hs = startHandshake(this.identity, this.macKey, 'initiator');
    this.sendFrame(this.hs.message!);
    await this.wait((x) => x === 'cipher');
  }

  async hello(app = 'orbital-mobile/test'): Promise<MacMessage> {
    this.send({ t: 'hello', protocol: PROTOCOL_VERSION, app });
    return this.next('hello');
  }

  send(msg: PhoneMessage): void {
    this.sendInner(encodeInner({ kind: 'json', value: msg }));
  }

  /** Takes any `Inner` because `chunkBlob` returns `Inner[]`; it only encodes. */
  sendBlob(chunk: Inner): void {
    this.sendInner(encodeInner(chunk));
  }

  next<T extends MacMessage['t']>(t: T, pred: (m: Extract<MacMessage, { t: T }>) => boolean = () => true): Promise<Extract<MacMessage, { t: T }>> {
    const i = this.messages.findIndex((m) => m.t === t && pred(m as any));
    if (i >= 0) return Promise.resolve(this.messages.splice(i, 1)[0] as any);
    return this.wait((x) => typeof x === 'object' && x !== null && (x as any).t === t && pred(x as any));
  }

  nextControl(type: RelayToDevice['type']): Promise<RelayToDevice> {
    const i = this.control.findIndex((m) => m.type === type);
    if (i >= 0) return Promise.resolve(this.control.splice(i, 1)[0]);
    return this.wait((x) => typeof x === 'object' && x !== null && (x as any).type === type);
  }

  nextBlob(): Promise<Extract<Inner, { kind: 'blob' }>> {
    if (this.blobs.length) return Promise.resolve(this.blobs.shift()!);
    return this.wait((x) => typeof x === 'object' && x !== null && (x as any).kind === 'blob');
  }

  /** Resolves once the socket is closed, so a test's teardown leaves no handle behind. */
  close(): Promise<void> {
    // Pending waits are abandoned, not failed: nothing awaits them after teardown.
    for (const w of this.waiters.splice(0)) clearTimeout(w.timer);
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
      ws.close();
    });
  }

  private sendInner(plain: Uint8Array): void {
    if (!this.cipher) throw new Error('no cipher');
    this.sendFrame(this.cipher.seal(plain));
  }

  private sendFrame(body: Uint8Array): void {
    this.ws!.send(encodeFrame({ peer: this.macKey!, flags: 0, wake: ZERO_WAKE, body }), { binary: true });
  }

  private onControl(text: string): void {
    const msg = RelayToDevice.parse(JSON.parse(text));
    this.control.push(msg);
    this.offer(msg);
  }

  private onData(buf: Uint8Array): void {
    const frame = decodeFrame(buf);
    if (!frame || frame.body.length === 0) return;
    if (!this.cipher) {
      this.cipher = this.hs?.complete(frame.body) ?? null;
      if (this.cipher) this.offer('cipher');
      return;
    }
    const plain = this.cipher.open(frame.body);
    if (!plain) return;
    const inner = decodeInner(plain);
    if (!inner) return;
    if (inner.kind === 'blob') {
      this.blobs.push(inner);
      this.offer(inner);
      return;
    }
    const msg = MacMessage.parse(inner.value);
    this.messages.push(msg);
    this.offer(msg);
  }

  private offer(x: unknown): void {
    const i = this.waiters.findIndex((w) => w.match(x));
    if (i < 0) return;
    const [w] = this.waiters.splice(i, 1);
    if (typeof x === 'object' && x !== null) {
      const list: unknown[] = (x as any).kind === 'blob' ? this.blobs : 't' in (x as any) ? this.messages : this.control;
      const at = list.indexOf(x);
      if (at >= 0) list.splice(at, 1);
    }
    w.resolve(x);
  }

  private wait<T>(match: (x: unknown) => boolean, ms = 5000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = {
        match,
        resolve: (x) => { clearTimeout(waiter.timer); resolve(x); },
        // Dropped on timeout, so a late message is kept for the next reader
        // instead of going to a promise nobody awaits any more.
        timer: setTimeout(() => {
          const at = this.waiters.indexOf(waiter);
          if (at >= 0) this.waiters.splice(at, 1);
          reject(new Error('fake phone timed out'));
        }, ms),
      };
      this.waiters.push(waiter);
    });
  }
}
