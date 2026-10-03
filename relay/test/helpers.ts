import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { authSignature, RelayToDevice, type RelayToDevice as Control } from '@orbital/shared/remote/relayApi';
import { deviceId, type Identity } from '@orbital/shared/remote/keys';

export async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return `http://127.0.0.1:${addr.port}`;
}

export type Device = {
  ws: WebSocket;
  id: string;
  /** The online peers the relay listed in `ok`. */
  peers: string[];
  control: Control[];
  data: Uint8Array[];
  next(type: Control['type']): Promise<Control>;
  nextData(): Promise<Uint8Array>;
};

/** Opens a socket, answers the challenge (with `secret` when given), resolves after `ok`. */
export async function connectDevice(
  base: string, identity: Identity, mac = deviceId(identity.publicKey), query = '', secret?: string,
): Promise<Device> {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?mac=${mac}${query}`);
  const control: Control[] = [];
  const data: Uint8Array[] = [];
  const waiters: { type: string; resolve: (v: any) => void }[] = [];
  // A message either satisfies a waiter or is kept; never both, so `control`
  // and `data` hold exactly what nobody has consumed.
  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      const buf = new Uint8Array(raw as Buffer);
      const i = waiters.findIndex((w) => w.type === 'data');
      if (i >= 0) waiters.splice(i, 1)[0].resolve(buf);
      else data.push(buf);
      return;
    }
    const msg = RelayToDevice.parse(JSON.parse((raw as Buffer).toString('utf8')));
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else control.push(msg);
  });
  const next = (type: Control['type']) =>
    new Promise<Control>((resolve) => {
      const i = control.findIndex((m) => m.type === type);
      if (i >= 0) resolve(control.splice(i, 1)[0]);
      else waiters.push({ type, resolve });
    });
  const nextData = () =>
    new Promise<Uint8Array>((resolve) => {
      if (data.length) resolve(data.shift()!);
      else waiters.push({ type: 'data', resolve });
    });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const challenge = await next('challenge');
  if (challenge.type !== 'challenge') throw new Error('expected challenge');
  ws.send(JSON.stringify({ type: 'auth', pub: deviceId(identity.publicKey), sig: authSignature(identity, challenge.nonce), secret }));
  const ok = await next('ok');
  if (ok.type !== 'ok') throw new Error('expected ok');
  return { ws, id: deviceId(identity.publicKey), peers: ok.peers, control, data, next, nextData };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
