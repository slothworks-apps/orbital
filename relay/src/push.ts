/**
 * The one thing the relay says to a phone that is not connected: a generic
 * push, through Firebase Cloud Messaging, that a session needs input without
 * saying which (spec 2026-09-30-mobile-remote-design § 5).
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { log, short } from './log.js';
import type { RelayStore } from './store.js';
import type { WakeHook } from './ws.js';

/**
 * The wake token, as hex, and nothing else: no device name crosses the relay
 * or the push services (spec 2026-10-08-relay-knows-no-names-design). The
 * token is the Mac's per-session HMAC, which the relay cannot read; as the
 * notification's tag it makes a later push for the same session replace the
 * earlier one (spec 2026-10-15-the-phone-is-quiet-while-you-are-at-the-mac-design § 3).
 */
export type PushPayload = { tag: string };

export interface PushSender {
  send(token: string, payload: PushPayload): Promise<void>;
}

export class LogPushSender implements PushSender {
  send(token: string, payload: PushPayload): Promise<void> {
    log(`push not sent (no FCM configured) to ${short(token)}, tag ${short(payload.tag)}`);
    return Promise.resolve();
  }
}

/** A phone pairs with one Mac, so the title names none: it would tell the user nothing, and tell FCM and APNs a name. */
export const PUSH_TEXT = { title: 'Orbital', body: 'A session needs your input' } as const;

export function wakeHook(store: RelayStore, sender: PushSender): WakeHook {
  return async (_from, to, wake) => {
    let token: string | null = null;
    const tag = Buffer.from(wake).toString('hex');
    try {
      const phone = await store.device(to);
      if (!phone?.pushToken) return;
      token = phone.pushToken;
      await sender.send(token, { tag });
      log(`push sent to ${short(token)}, tag ${short(tag)}`);
    } catch (err) {
      log(`push failed to ${token ? short(token) : '?'}, tag ${short(tag)}: ${err instanceof Error ? err.message : String(err)}`);
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
    const message = JSON.stringify({
      message: {
        token,
        notification: PUSH_TEXT,
        android: { collapse_key: 'needs-input', priority: 'high', notification: { channel_id: 'needs_input', tag: payload.tag } },
        apns: { headers: { 'apns-collapse-id': payload.tag } },
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
