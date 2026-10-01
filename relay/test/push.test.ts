import { describe, it, expect, vi } from 'vitest';
import {
  FcmPushSender, WAKE_TRACKER_MAX_PER_PHONE, WAKE_TRACKER_MAX_PHONES, WakeTracker, pushText, wakeHook,
} from '../src/push.js';
import { openRelayStore } from '../src/store.js';

describe('WakeTracker', () => {
  it('counts distinct wake tokens per phone until cleared', () => {
    const t = new WakeTracker();
    const a = new Uint8Array(16).fill(1);
    const b = new Uint8Array(16).fill(2);
    expect(t.add('p', a)).toBe(1);
    expect(t.add('p', a)).toBe(1);
    expect(t.add('p', b)).toBe(2);
    expect(t.add('q', a)).toBe(1);
    t.clear('p');
    expect(t.add('p', a)).toBe(1);
  });

  it('caps distinct wakes per phone, dropping the oldest', () => {
    const t = new WakeTracker();
    let last = 0;
    for (let i = 0; i < WAKE_TRACKER_MAX_PER_PHONE + 1; i++) {
      const wake = new Uint8Array(16).fill(0);
      new DataView(wake.buffer).setUint32(0, i);
      last = t.add('p', wake);
    }
    expect(last).toBe(WAKE_TRACKER_MAX_PER_PHONE);
  });

  it('caps the number of phones pending at once, evicting the least recently added', () => {
    const t = new WakeTracker();
    for (let i = 0; i < WAKE_TRACKER_MAX_PHONES + 1; i++) {
      t.add(`phone-${i}`, new Uint8Array(16).fill(1));
    }
    expect(t.add('phone-0', new Uint8Array(16).fill(1))).toBe(1);
  });
});

describe('pushText', () => {
  it('names the Mac and pluralises', () => {
    expect(pushText('studio', 1)).toEqual({ title: 'Orbital · studio', body: 'A session needs your input' });
    expect(pushText('studio', 3)).toEqual({ title: 'Orbital · studio', body: '3 sessions need your input' });
  });
});

describe('wakeHook', () => {
  it('sends to the phone token with the running count, and skips a phone without a token', async () => {
    const store = await openRelayStore(':memory:');
    await store.upsertDevice({ id: 'mac', kind: 'mac', name: 'studio' });
    await store.upsertDevice({ id: 'phone', kind: 'phone', name: 'Pixel' });
    await store.setPushToken('phone', 'fcm-1');
    await store.upsertDevice({ id: 'mute', kind: 'phone', name: 'NoToken' });
    const sender = { send: vi.fn(async () => {}) };
    const hook = wakeHook(store, new WakeTracker(), sender);
    await hook('mac', 'phone', new Uint8Array(16).fill(1));
    await hook('mac', 'phone', new Uint8Array(16).fill(2));
    await hook('mac', 'mute', new Uint8Array(16).fill(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(sender.send.mock.calls).toEqual([
      ['fcm-1', { macName: 'studio', count: 1 }],
      ['fcm-1', { macName: 'studio', count: 2 }],
    ]);
  });
});

describe('FcmPushSender', () => {
  it('exchanges a service-account JWT for a bearer and posts the message', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
      return new Response('{}', { status: 200 });
    });
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const sender = new FcmPushSender(
      { project_id: 'proj', client_email: 'svc@proj.iam', private_key: pem, token_uri: 'https://oauth2.googleapis.com/token' },
      fetchImpl as any,
      () => 1_700_000_000_000,
    );
    await sender.send('fcm-1', { macName: 'studio', count: 1 });
    await sender.send('fcm-1', { macName: 'studio', count: 2 });
    expect(calls.map((c) => c.url)).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://fcm.googleapis.com/v1/projects/proj/messages:send',
      'https://fcm.googleapis.com/v1/projects/proj/messages:send',
    ]);
    const sent = JSON.parse(calls[1].init.body as string);
    expect(sent.message.token).toBe('fcm-1');
    expect(sent.message.notification).toEqual({ title: 'Orbital · studio', body: 'A session needs your input' });
    expect(sent.message.android.collapse_key).toBe('needs-input');
    expect((calls[1].init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('drops a rejected bearer and resends once with a fresh one', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let tokenCalls = 0;
    let sendCalls = 0;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('oauth2')) {
        tokenCalls++;
        return new Response(JSON.stringify({ access_token: `tok${tokenCalls}`, expires_in: 3600 }));
      }
      sendCalls++;
      return new Response('{}', { status: sendCalls === 1 ? 401 : 200 });
    });
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const sender = new FcmPushSender(
      { project_id: 'proj', client_email: 'svc@proj.iam', private_key: pem, token_uri: 'https://oauth2.googleapis.com/token' },
      fetchImpl as any,
      () => 1_700_000_000_000,
    );
    await sender.send('fcm-1', { macName: 'studio', count: 1 });
    expect(calls.map((c) => c.url)).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://fcm.googleapis.com/v1/projects/proj/messages:send',
      'https://oauth2.googleapis.com/token',
      'https://fcm.googleapis.com/v1/projects/proj/messages:send',
    ]);
    expect((calls[3].init.headers as Record<string, string>).authorization).toBe('Bearer tok2');
  });

  it('throws when the resend after a rejected bearer also fails', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
      return new Response('{}', { status: 401 });
    });
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const sender = new FcmPushSender(
      { project_id: 'proj', client_email: 'svc@proj.iam', private_key: pem, token_uri: 'https://oauth2.googleapis.com/token' },
      fetchImpl as any,
      () => 1_700_000_000_000,
    );
    await expect(sender.send('fcm-1', { macName: 'studio', count: 1 })).rejects.toThrow('fcm 401');
  });
});
