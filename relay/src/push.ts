/**
 * The one thing the relay says to a phone that is not connected: a generic
 * push, through Firebase Cloud Messaging, counting how many sessions wait
 * without knowing which (spec 2026-09-30-mobile-remote-design § 5).
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { log, short } from './log.js';
import type { RelayStore } from './store.js';
import type { WakeHook } from './ws.js';

export type PushPayload = { macName: string; count: number };

export interface PushSender {
  send(token: string, payload: PushPayload): Promise<void>;
}

export class LogPushSender implements PushSender {
  send(token: string, payload: PushPayload): Promise<void> {
    // Metadata only, like every relay line: no Mac name.
    log(`push not sent (no FCM configured) to ${short(token)}, count ${payload.count}`);
    return Promise.resolve();
  }
}

/** Caps on `WakeTracker`'s memory: a wedged phone must not grow it without bound. */
export const WAKE_TRACKER_MAX_PER_PHONE = 64;
export const WAKE_TRACKER_MAX_PHONES = 1024;

/** Distinct wake tokens per phone since it was last online. */
export class WakeTracker {
  private pending = new Map<string, Set<string>>();

  add(phone: string, wake: Uint8Array): number {
    let set = this.pending.get(phone);
    if (set) {
      // Re-insert: Maps iterate in insertion order, so this keeps the first
      // key equal to the least recently touched phone (see WAKE_TRACKER_MAX_PHONES below).
      this.pending.delete(phone);
    } else if (this.pending.size >= WAKE_TRACKER_MAX_PHONES) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    if (!set) set = new Set();
    this.pending.set(phone, set);
    set.add(Buffer.from(wake).toString('hex'));
    if (set.size > WAKE_TRACKER_MAX_PER_PHONE) {
      // Sets also keep insertion order; drop the oldest wake for this phone.
      const oldest = set.values().next().value;
      if (oldest !== undefined) set.delete(oldest);
    }
    return set.size;
  }

  clear(phone: string): void {
    this.pending.delete(phone);
  }
}

export function pushText(macName: string, count: number): { title: string; body: string } {
  return {
    title: `Orbital · ${macName}`,
    body: count === 1 ? 'A session needs your input' : `${count} sessions need your input`,
  };
}

export function wakeHook(store: RelayStore, tracker: WakeTracker, sender: PushSender): WakeHook {
  return async (from, to, wake) => {
    let token: string | null = null;
    let count = 0;
    try {
      const phone = await store.device(to);
      if (!phone?.pushToken) return;
      token = phone.pushToken;
      count = tracker.add(to, wake);
      const macName = (await store.device(from))?.name || 'your Mac';
      await sender.send(token, { macName, count });
      log(`push sent to ${short(token)}, count ${count}`);
    } catch (err) {
      log(`push failed to ${token ? short(token) : '?'}, count ${count}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

export type ServiceAccount = {
  project_id: string; client_email: string; private_key: string; token_uri: string;
};

export function loadServiceAccount(path: string): ServiceAccount {
  return JSON.parse(readFileSync(path, 'utf8')) as ServiceAccount;
}

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

export class FcmPushSender implements PushSender {
  private bearer: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly account: ServiceAccount,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async send(token: string, payload: PushPayload): Promise<void> {
    const { title, body } = pushText(payload.macName, payload.count);
    const message = JSON.stringify({
      message: {
        token,
        notification: { title, body },
        android: { collapse_key: 'needs-input', priority: 'high', notification: { channel_id: 'needs_input' } },
        apns: { headers: { 'apns-collapse-id': 'needs-input' } },
      },
    });
    const res = await this.post(message);
    if (res.ok) return;
    if (res.status !== 401 && res.status !== 403) throw new Error(`fcm ${res.status}`);
    // The bearer was rejected: drop it, get a fresh one, and resend exactly once.
    this.bearer = null;
    const retry = await this.post(message);
    if (!retry.ok) throw new Error(`fcm ${retry.status}`);
  }

  private async post(message: string): Promise<Response> {
    return this.fetchImpl(
      `https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
        body: message,
      },
    );
  }

  private async accessToken(): Promise<string> {
    const now = this.now();
    if (this.bearer && this.bearer.expiresAt > now + 60_000) return this.bearer.token;
    const iat = Math.floor(now / 1000);
    const header = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64(JSON.stringify({
      iss: this.account.client_email, scope: FCM_SCOPE, aud: this.account.token_uri, iat, exp: iat + 3600,
    }));
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const jwt = `${header}.${claims}.${signer.sign(this.account.private_key, 'base64url')}`;
    const res = await this.fetchImpl(this.account.token_uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
    });
    if (!res.ok) {
      // Never cache a bearer that came from a failed exchange.
      this.bearer = null;
      throw new Error(`oauth ${res.status}`);
    }
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.bearer = { token: json.access_token, expiresAt: now + json.expires_in * 1000 };
    return json.access_token;
  }
}

function b64(text: string): string {
  return Buffer.from(text).toString('base64url');
}
