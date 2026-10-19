/**
 * The two ceremonies in a terminal (spec 2026-10-19-headless-server-design §
 * How it is used, steps 4 and 5): `orbital join` redeems another device's
 * code and waits for its answer; `orbital devices add` shows a code, waits
 * for a request and asks for the code the requester shows. Both read the
 * outcome from `GET /api/remote`, polled, as the screens read it from the
 * status they are sent.
 */
import type { JoinResult, Joining, PairConfirmResult, StartPairingResult } from '@orbital/shared/remote/ceremony';
import {
  CODE_REJECTED, GROUP_FULL, JOIN_REACH, REQUEST_REJECTED, attemptsLine, groupFullBody, joinSentence, managerWords,
} from '@orbital/shared/remote/groupWords';
import { encodePairingCode, parsePairingCode } from '@orbital/shared/remote/relayApi';
import type { RemoteStatus } from '../remote/service.js';
import { CliError, errorOf, type Call } from './client.js';
import type { Io } from './io.js';
import {
  NOT_A_CODE, RELAY_NO_ANSWER, codeExpiredLine, joinRefusal, otherRelayLine, pendingPrimaryName, startPairingRefusal,
} from './words.js';

/** How often a ceremony reads the status while it waits. */
export const CLI_POLL_MS = 1_000;

export type Deps = { call: Call; io: Io };

export async function readStatus(call: Call): Promise<RemoteStatus> {
  const reply = await call('GET', '/api/remote');
  if (reply.status !== 200) throw new CliError(`Orbital answered ${reply.status} to /api/remote.`);
  return reply.body as RemoteStatus;
}

/** A relay URL as two devices compare it: a trailing slash does not make it another relay. */
function sameRelay(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/**
 * Where a join stands, read from one status (the screens' `useJoin`):
 * `waiting` for the other device to confirm; `paired`, waiting for the
 * primary's first roster; `joined`; `rejected` by the other device;
 * `expired`, its code ran out; `neverSent`, paired but the roster never
 * came before the code ran out; `relayDown`, the join ended while the relay
 * was not there to carry an answer.
 */
export type JoinVerdict = 'waiting' | 'paired' | 'joined' | 'rejected' | 'expired' | 'neverSent' | 'relayDown';

export function joinVerdict(status: RemoteStatus, target: { device: string; expiresAt: number }, now: number): JoinVerdict {
  if (status.joining?.device === target.device) return now >= target.expiresAt ? 'expired' : 'waiting';
  if (status.group.pendingJoin) return 'paired';
  if (status.group.joinExpired) return 'neverSent';
  // Paired: in the roster now, or paired by hand with a member it already was.
  if (status.devices.some((d) => d.id === target.device)) return 'joined';
  if (now >= target.expiresAt) return 'expired';
  // Only a relay that is still up can have carried a rejection.
  return status.enabled && status.relay === 'online' ? 'rejected' : 'relayDown';
}

/** `orbital join [code]`: 0 once in, 1 otherwise. Ctrl-C while waiting cancels the join. */
export async function joinFlow({ call, io }: Deps, codeArg: string | null): Promise<number> {
  const typed = codeArg ?? (await io.ask('The code the other device shows: '));
  if (typed === null || typed.trim() === '') {
    io.err('No code given.');
    return 1;
  }
  const qr = parsePairingCode(typed);
  if (!qr) {
    io.err(NOT_A_CODE);
    return 1;
  }
  let status = await readStatus(call);
  if (status.macId !== null && qr.mac === status.macId) {
    io.err("That's this device's own code.");
    return 1;
  }
  // The relay rides inside the code, so this is caught before any request (canvas 50d B).
  if (!sameRelay(qr.relay, status.relayUrl)) {
    io.err(otherRelayLine(qr.name, qr.relay, status));
    return 1;
  }
  if (qr.expiresAt !== undefined && qr.expiresAt <= io.now()) {
    io.err(codeExpiredLine(qr.name));
    return 1;
  }
  // An old join's "never sent" notice would read as this join's end; the user starts afresh.
  if (status.group.joinExpired) await call('POST', '/api/remote/join/expired/acknowledge');

  const reply = await call('POST', '/api/remote/join', { code: typed.trim() });
  const res = reply.body as JoinResult;
  if (reply.status !== 200 || 'error' in res) {
    const error = errorOf(reply);
    if (!error) throw new CliError(`Orbital answered ${reply.status} to the join.`);
    io.err(joinRefusal(res as Extract<JoinResult, { error: string }>, qr.name, status));
    return 1;
  }
  status = await readStatus(call);
  const joining: Joining | null = status.joining?.device === res.device ? status.joining : null;
  const target = { device: res.device, expiresAt: joining?.expiresAt ?? qr.expiresAt ?? Number.POSITIVE_INFINITY };
  const manager = managerWords(joining?.manager ?? null, res.name);
  io.out(`Type this code on ${res.name}: ${res.code}`);
  if (manager.line) io.out(manager.line);
  io.out(`Waiting for ${res.name}… Ctrl-C cancels.`);

  let saidPaired = false;
  for (;;) {
    if ((await io.wait(CLI_POLL_MS)) === 'interrupt') {
      const cancelled = await call('DELETE', '/api/remote/join');
      io.out(cancelled.status === 200 ? 'Join cancelled.' : 'Nothing to cancel: the join had ended.');
      return 1;
    }
    status = await readStatus(call);
    switch (joinVerdict(status, target, io.now())) {
      case 'waiting':
        continue;
      case 'paired':
        if (!saidPaired) io.out(`Paired. Waiting for the group from ${pendingPrimaryName(status)}…`);
        saidPaired = true;
        continue;
      case 'joined':
        io.out(`Joined: ${res.name}.`);
        if (manager.done) io.out(manager.done);
        return 0;
      case 'rejected':
        io.err(`${REQUEST_REJECTED}. ${res.name} didn't let this device in. Make a new code on ${res.name} and run orbital join again.`);
        return 1;
      case 'expired':
        io.err(codeExpiredLine(res.name));
        return 1;
      case 'neverSent': {
        const primary = status.group.joinExpired?.name ?? res.name;
        io.err(`${primary} never sent the group before the code ran out. This device is still standalone. Pair it with ${primary} again when ${primary} is online.`);
        // Said here, so the notice is read.
        await call('POST', '/api/remote/join/expired/acknowledge');
        return 1;
      }
      case 'relayDown':
        io.err('The join ended while the relay was not connected. Run orbital join again once orbital status shows it online.');
        return 1;
    }
  }
}

/**
 * Where a shown code stands, read from one status: a `request` to answer;
 * still `waiting`; `expired`; `refused`, spent on a request this device
 * could not take (the ceremony rejects those without asking); or
 * `replaced` by a code shown elsewhere (the desktop's Devices, say), which
 * takes the requests from now on.
 */
export type AddVerdict = 'request' | 'waiting' | 'expired' | 'refused' | 'replaced';

export function addVerdict(status: RemoteStatus, expiresAt: number, now: number): AddVerdict {
  if (status.pendingPair) return 'request';
  if (now >= expiresAt) return 'expired';
  if (status.pairing === null) return 'refused';
  return status.pairing.expiresAt === expiresAt ? 'waiting' : 'replaced';
}

/** The code's time left, as `1:45`. */
function left(expiresAt: number, now: number): string {
  const s = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** `orbital devices add`: 0 once the device is in, or the request declined; 1 otherwise. */
export async function addFlow({ call, io }: Deps): Promise<number> {
  let status = await readStatus(call);
  // A request is waiting already (on a code shown before): answer that one, a new code would drop it.
  if (!status.pendingPair) {
    const reply = await call('POST', '/api/remote/pair');
    const res = reply.body as StartPairingResult;
    if (reply.status !== 200 || 'error' in res) {
      if (!errorOf(reply)) throw new CliError(`Orbital answered ${reply.status} to the code.`);
      io.err(startPairingRefusal(res as Extract<StartPairingResult, { error: string }>, status));
      return 1;
    }
    io.out('Paste this code on the device that joins (orbital join on a server, Join a group on a desktop):');
    io.out('');
    io.out(encodePairingCode(res.qr));
    io.out('');
    io.out(`It works for ${left(res.expiresAt, io.now())}. Waiting for a request… Ctrl-C stops.`);
    for (;;) {
      if ((await io.wait(CLI_POLL_MS)) === 'interrupt') {
        io.out('Stopped. The code stops working when its time runs out.');
        return 1;
      }
      status = await readStatus(call);
      const verdict = addVerdict(status, res.expiresAt, io.now());
      if (verdict === 'request') break;
      if (verdict === 'waiting') continue;
      io.err({
        expired: 'The code expired before a device asked. Run orbital devices add again.',
        refused: 'The code was spent on a device that cannot join here. Run orbital devices add again.',
        replaced: 'A newer code was made on this device; it takes the requests now.',
      }[verdict]);
      return 1;
    }
  }
  return answerRequest({ call, io }, status.pendingPair!);
}

/** The request (canvas 50c): its sentence, then the code the requester shows, until it is in or out. */
async function answerRequest({ call, io }: Deps, pending: NonNullable<RemoteStatus['pendingPair']>): Promise<number> {
  const { name } = pending;
  const manager = managerWords(pending.manager ?? null, name);
  io.out(`${joinSentence(pending)}. ${JOIN_REACH}`);
  if (manager.line) io.out(manager.line);
  for (;;) {
    const answer = await io.ask(`Type the code ${name} shows (Enter or n to reject): `);
    if (answer === null || answer === '' || /^no?$/i.test(answer)) {
      const reply = await call('POST', '/api/remote/pair/confirm', { accept: false, phone: pending.phone });
      if (reply.status === 200) {
        io.out(REQUEST_REJECTED);
        return 0;
      }
      io.err(endedLine(errorOf(reply)));
      return 1;
    }
    const reply = await call('POST', '/api/remote/pair/confirm', { accept: true, phone: pending.phone, code: answer });
    if (reply.status === 200) {
      io.out(`${name} joined.`);
      io.out(manager.done ?? 'The other devices link to it on their own.');
      return 0;
    }
    const res = reply.body as Extract<PairConfirmResult, { error: string }> | { error: 'mismatch' };
    switch (res?.error) {
      case 'code_mismatch':
        io.err(attemptsLine(res.attemptsLeft));
        continue;
      case 'relay_error':
        io.err(RELAY_NO_ANSWER);
        continue;
      case 'code_rejected':
        io.err(CODE_REJECTED);
        return 1;
      case 'group_full':
        io.err(GROUP_FULL);
        io.err(groupFullBody(name));
        return 1;
      default:
        io.err(endedLine(errorOf(reply)));
        return 1;
    }
  }
}

/** `no_pending` / `mismatch`: the request is gone — its code ran out, or another window answered it. */
function endedLine(error: string | null): string {
  return error === 'no_pending' || error === 'mismatch'
    ? 'The request is gone: its code ran out, or it was answered elsewhere.'
    : `Orbital could not answer the request${error ? ` (${error})` : ''}.`;
}
