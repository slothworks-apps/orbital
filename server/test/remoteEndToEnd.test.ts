import { describe, it, expect, afterEach } from 'vitest';
import { chunkBlob } from '@orbital/shared/remote/messages';
import { FakePhone } from './remoteFakePhone.js';
import { pairingCode, startMacAndRelay, until, wrongCode } from './remoteHarness.js';

describe('mobile remote, end to end', () => {
  const closers: (() => unknown)[] = [];
  afterEach(async () => { for (const c of closers.splice(0).reverse()) await c(); });

  it('pairs, tunnels the api and hub, moves an image both ways, and revokes', async () => {
    const { relayUrl, app, api } = await startMacAndRelay(closers);

    // Pair: QR on the Mac, redeem from the phone, the phone's code typed on the Mac.
    const pair = await api('POST', '/api/remote/pair');
    expect(pair.statusCode).toBe(200);
    const phone = new FakePhone();
    closers.push(() => phone.close());
    await phone.connect(pair.json().qr);
    const redeemed = await phone.redeem();
    expect(redeemed).toMatchObject({ status: 200, body: { name: 'studio' } });
    await until(async () => (await api('GET', '/api/remote')).json().pendingPair !== null);
    const status = (await api('GET', '/api/remote')).json();
    // The code is the phone's to show and the user's to type; the status never carries it.
    const code = pairingCode(status.macId, phone.identity.publicKey);
    expect(status.pendingPair).toEqual({ phone: phone.id, name: 'Pixel', platform: 'android', attemptsLeft: 3 });
    expect((await api('POST', '/api/remote/pair/confirm', { accept: true, phone: phone.id })).statusCode).toBe(400);
    const wrong = await api('POST', '/api/remote/pair/confirm', { accept: true, phone: phone.id, code: wrongCode(code) });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json()).toEqual({ error: 'code_mismatch', attemptsLeft: 2 });
    // A real phone handshakes the moment it hears `paired`, which the relay
    // sends before it answers the Mac's confirm — so the confirm is not awaited first.
    const confirm = api('POST', '/api/remote/pair/confirm', { accept: true, phone: phone.id, code: code.toLowerCase() });
    expect(await phone.nextControl('paired')).toMatchObject({ type: 'paired', name: 'studio' });
    await phone.handshake();
    expect((await confirm).statusCode).toBe(200);
    await until(async () => (await api('GET', '/api/remote')).json().devices.some((d: any) => d.id === phone.id && d.online));

    // Tunnel: hello, hub subscriptions, an allowed and a denied call.
    expect(await phone.hello()).toMatchObject({ t: 'hello', macName: 'studio' });
    phone.send({ t: 'ws', type: 'subscribe', topic: 'sessions' });
    phone.send({ t: 'ws', type: 'subscribe', topic: 'errors' });
    // Messages are handled in order, so this answer also means both subscriptions are in.
    phone.send({ t: 'http', id: 1, method: 'GET', path: '/api/sessions' });
    const sessions = await phone.next('http_res', (m) => m.id === 1);
    expect(sessions.status).toBe(200);
    // Recorded on the Mac directly (the phone may not post errors); the hub frame reaches the phone.
    const recorded = await app.inject({ method: 'POST', url: '/api/errors', payload: { kind: 'render_crash', message: 'e2e boom' } });
    expect(recorded.statusCode).toBe(200);
    const errorFrame = await phone.next('ws', (m) => (m.frame as any)?.topic === 'errors');
    expect(errorFrame.frame).toMatchObject({ topic: 'errors', event: 'error', error: { message: 'e2e boom' } });
    phone.send({ t: 'http', id: 2, method: 'GET', path: '/api/files?path=/etc/passwd' });
    expect(await phone.next('http_res', (m) => m.id === 2)).toMatchObject({ status: 403 });

    // An image up, then the same image down.
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(70_000, 7)]);
    phone.send({ t: 'blob_put', id: 10, mediaType: 'image/png', bytes: png.length });
    for (const chunk of chunkBlob(10, new Uint8Array(png))) phone.sendBlob(chunk);
    const done = await phone.next('blob_put_done', (m) => m.id === 10);
    expect(done.entry?.bytes).toBe(png.length);
    phone.send({ t: 'blob_get', id: 11, ref: done.entry!.ref });
    expect(await phone.next('blob_meta', (m) => m.id === 11)).toMatchObject({ status: 200, bytes: png.length });
    const parts: Uint8Array[] = [];
    for (;;) {
      const chunk = await phone.nextBlob();
      parts.push(chunk.bytes);
      if (chunk.last) break;
    }
    expect(Buffer.concat(parts)).toEqual(png);

    // The phone's own notification rows.
    phone.send({ t: 'notifications_set', settings: { needsInput: true, sessionEnded: false, sessionFailed: true, onlyWhenBackground: true, sound: false } });
    expect((await phone.next('notifications')).settings.sessionEnded).toBe(false);
    // Stored on the Mac, not only echoed back.
    const stored = (await api('GET', '/api/remote')).json().devices.find((d: any) => d.id === phone.id);
    expect(stored.notifications.sessionEnded).toBe(false);

    // The same phone back on a new socket, as after an app restart: the relay
    // supersedes the old socket without an `offline`, and the fresh
    // handshake must still be answered.
    const again = new FakePhone(phone.identity);
    closers.push(() => again.close());
    await again.connectStored({ relay: relayUrl, mac: status.macId });
    await again.handshake();
    expect(await again.hello()).toMatchObject({ t: 'hello', macName: 'studio' });
    again.send({ t: 'http', id: 20, method: 'GET', path: '/api/sessions' });
    expect(await again.next('http_res', (m) => m.id === 20)).toMatchObject({ status: 200 });
    await phone.close();

    // Revoke on the Mac: the tunnel says bye, the relay says unpaired, the device is gone.
    expect((await api('DELETE', `/api/remote/devices/${again.id}`)).statusCode).toBe(200);
    expect(await again.next('bye')).toEqual({ t: 'bye', reason: 'revoked' });
    expect(await again.nextControl('unpaired')).toMatchObject({ type: 'unpaired' });
    expect((await api('GET', '/api/remote')).json().devices).toEqual([]);
  }, 20_000);

  it('rejects the phone after the last wrong code, as Reject would', async () => {
    const { api } = await startMacAndRelay(closers);
    const phone = new FakePhone();
    closers.push(() => phone.close());
    await phone.connect((await api('POST', '/api/remote/pair')).json().qr);
    await phone.redeem();
    await until(async () => (await api('GET', '/api/remote')).json().pendingPair !== null);
    const macId = (await api('GET', '/api/remote')).json().macId;
    const wrong = wrongCode(pairingCode(macId, phone.identity.publicKey));
    const send = () => api('POST', '/api/remote/pair/confirm', { accept: true, phone: phone.id, code: wrong });
    expect((await send()).statusCode).toBe(422);
    expect((await send()).statusCode).toBe(422);
    const last = await send();
    expect(last.statusCode).toBe(409);
    expect(last.json()).toEqual({ error: 'code_rejected' });
    expect(await phone.nextControl('rejected')).toMatchObject({ type: 'rejected' });
    expect((await api('GET', '/api/remote')).json()).toMatchObject({ pendingPair: null, pairing: null, devices: [] });
  }, 20_000);
});
