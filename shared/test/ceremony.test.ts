import { describe, expect, it } from 'vitest';
import {
  PAIR_CODE_ATTEMPTS, PairingCeremony, devicePairingProof, type CeremonyHost, type CeremonyRelay, type PendingPair,
} from '../src/remote/ceremony.js';
import type { PairedDevice, PrimaryRef } from '../src/remote/group.js';
import {
  deviceId, fingerprint, formatFingerprint, fromBase64Url, generateIdentity, type Identity,
} from '../src/remote/keys.js';
import { pairingProof, parsePairingCode, sealPairingDevice, type QrPayload } from '../src/remote/relayApi.js';

const RELAY = 'wss://relay.example';
const EXPIRES = 600_000;

type Answer = { status: number; body: unknown };

function fakeRelay(answers: Record<string, Answer> = {}) {
  const posts: { path: string; payload: unknown }[] = [];
  const relay: CeremonyRelay = {
    status: 'online',
    async post<T>(path: string, _action: string, payload: unknown) {
      posts.push({ path, payload });
      const fallback = path === '/pair/token' ? { status: 200, body: { token: 'tok', expiresAt: EXPIRES } } : { status: 200, body: {} };
      return (answers[path] ?? fallback) as { status: number; body: T };
    },
  };
  return { relay, posts, answers };
}

function build(opts: {
  kind?: string; inGroup?: boolean; members?: string[]; paired?: PairedDevice[]; answers?: Record<string, Answer>; full?: boolean; fills?: boolean;
  /** This device is a member whose group's primary is this one. */
  primary?: PrimaryRef; byHand?: boolean;
} = {}) {
  const identity = generateIdentity();
  const r = fakeRelay(opts.answers);
  const paired = new Map((opts.paired ?? []).map((d) => [d.id, d]));
  const calls = {
    addPaired: [] as { id: string; kind: string; name: string; os: string; links: boolean }[],
    revoked: [] as string[], watched: [] as string[], opened: [] as string[], abandoned: [] as string[],
    announced: [] as PendingPair[], unrevoked: [] as string[],
  };
  let now = 1_000;
  const host: CeremonyHost = {
    enabled: () => true,
    identity: () => identity,
    relay: () => r.relay,
    relayTooOld: () => false,
    relayUrl: () => RELAY,
    relaySecret: () => '',
    self: () => ({ name: 'self', platform: 'macos', kind: opts.kind ?? 'desktop' }),
    inGroup: () => opts.inGroup ?? false,
    notPrimary: () => opts.primary ?? null,
    byHand: () => opts.byHand ?? false,
    isLiveMember: (id) => (opts.members ?? []).includes(id),
    canAdd: () => !opts.full,
    paired: {
      get: (id) => paired.get(id) ?? null,
      add: (d) => { paired.set(d.id, { ...d, lastSeenAt: null }); },
      remove: (id) => { paired.delete(id); },
    },
    pendingRevokes: { remove: (id) => { calls.unrevoked.push(id); } },
    addPaired: (d) => { calls.addPaired.push(d); return !opts.fills; },
    revokeCancelled: (id) => { calls.revoked.push(id); },
    watch: (id) => { calls.watched.push(id); },
    abandon: (id) => { calls.abandoned.push(id); },
    open: (id) => { calls.opened.push(id); },
    announce: (p) => { calls.announced.push(p); },
    changed: () => {},
    now: () => now,
    log: () => {},
  };
  const ceremony = new PairingCeremony(host);
  return {
    ceremony, identity, id: deviceId(identity.publicKey), relay: r, paired, calls,
    advance: (ms: number) => { now += ms; },
  };
}

/** A code shown by `adder`, as its QR. */
async function showCode(adder: ReturnType<typeof build>): Promise<QrPayload> {
  const res = await adder.ceremony.start();
  if (!('qr' in res)) throw new Error(`no code: ${res.error}`);
  return parsePairingCode(res.qr)!;
}

/** The relay's `pair_request` for `qr`, as a phone of this release with `identity` redeems it. */
function request(qr: QrPayload, identity: Identity, secret = fromBase64Url(qr.secret), kind = 'phone') {
  return {
    type: 'pair_request' as const, phone: deviceId(identity.publicKey),
    proof: devicePairingProof(secret, identity.publicKey),
    device: sealPairingDevice(secret, identity.publicKey, { name: 'Pixel', platform: 'android', kind }),
  };
}

/** The code the user types on the adder: what the newcomer shows. */
const codeFor = (adder: Identity, newcomer: Identity) => formatFingerprint(fingerprint(adder.publicKey, newcomer.publicKey));

describe('PairingCeremony as the adder', () => {
  it('ignores a request whose proof was not made with the code’s secret', async () => {
    const a = build();
    const qr = await showCode(a);
    a.ceremony.onPairRequest(request(qr, generateIdentity(), new Uint8Array(16)));
    expect(a.ceremony.state().pendingPair).toBeNull();
    expect(a.calls.announced).toEqual([]);
  });

  it('keeps the first request: a second while one is pending is ignored', async () => {
    const a = build();
    const qr = await showCode(a);
    const first = generateIdentity();
    a.ceremony.onPairRequest(request(qr, first));
    a.ceremony.onPairRequest(request(qr, generateIdentity()));
    expect(a.ceremony.state().pendingPair).toEqual({
      phone: deviceId(first.publicKey), name: 'Pixel', platform: 'android', kind: 'phone', attemptsLeft: PAIR_CODE_ATTEMPTS,
    });
    expect(a.calls.announced).toHaveLength(1);
  });

  it('counts wrong codes down and rejects at the last one', async () => {
    const a = build();
    const qr = await showCode(a);
    const phone = generateIdentity();
    a.ceremony.onPairRequest(request(qr, phone));
    const id = deviceId(phone.publicKey);
    for (let left = PAIR_CODE_ATTEMPTS - 1; left > 0; left--) {
      expect(await a.ceremony.confirm(true, id, 'AAA-AAA')).toEqual({ error: 'code_mismatch', attemptsLeft: left });
    }
    expect(await a.ceremony.confirm(true, id, 'AAA-AAA')).toEqual({ error: 'code_rejected' });
    expect(a.relay.posts.at(-1)).toEqual({ path: '/pair/confirm', payload: { phone: id, accept: false } });
    expect(a.ceremony.state()).toMatchObject({ pendingPair: null, pairing: null });
    expect(a.paired.size).toBe(0);
  });

  it('clears the request with an expired code', async () => {
    const a = build();
    const qr = await showCode(a);
    const phone = generateIdentity();
    a.ceremony.onPairRequest(request(qr, phone));
    a.advance(EXPIRES);
    expect(a.ceremony.state()).toMatchObject({ pendingPair: null, pairing: null });
    expect(await a.ceremony.confirm(true, deviceId(phone.publicKey), codeFor(a.identity, phone))).toEqual({ error: 'no_pending' });
  });

  it('accepts with the right code: the device is paired, joins the group and its channel is opened', async () => {
    const a = build();
    const qr = await showCode(a);
    const phone = generateIdentity();
    const id = deviceId(phone.publicKey);
    a.ceremony.onPairRequest(request(qr, phone));
    expect(await a.ceremony.confirm(true, id, codeFor(a.identity, phone))).toEqual({ ok: true });
    expect(a.paired.get(id)).toMatchObject({ name: 'Pixel', platform: 'android', kind: 'phone' });
    expect(a.calls.addPaired).toEqual([{ id, kind: 'phone', name: 'Pixel', os: 'android', links: true }]);
    expect(a.calls).toMatchObject({ watched: [id], opened: [id], unrevoked: [id] });
    expect(a.ceremony.state()).toMatchObject({ pendingPair: null, pairing: null });
  });

  it('a request whose proof binds a sealed kind is ignored when the relay stripped the device', async () => {
    const a = build();
    const qr = await showCode(a);
    const { device: _stripped, ...stripped } = request(qr, generateIdentity(), undefined, 'desktop');
    a.ceremony.onPairRequest(stripped);
    expect(a.ceremony.state().pendingPair).toBeNull();
  });

  it('a shipped phone (the plain proof) is a phone that does not link, whatever its sealed blob says', async () => {
    const a = build();
    const qr = await showCode(a);
    const secret = fromBase64Url(qr.secret);
    const phone = generateIdentity();
    const id = deviceId(phone.publicKey);
    a.ceremony.onPairRequest({
      type: 'pair_request', phone: id, proof: pairingProof(secret, phone.publicKey),
      device: sealPairingDevice(secret, phone.publicKey, { name: 'Pixel', platform: 'android', kind: 'desktop' }),
    });
    expect(a.ceremony.state().pendingPair).toMatchObject({ kind: 'phone', name: 'Pixel' });
    expect(await a.ceremony.confirm(true, id, codeFor(a.identity, phone))).toEqual({ ok: true });
    expect(a.calls.addPaired).toEqual([{ id, kind: 'phone', name: 'Pixel', os: 'android', links: false }]);
  });

  it('a full group rejects the request at the relay and adds nothing', async () => {
    const a = build({ full: true });
    const qr = await showCode(a);
    const phone = generateIdentity();
    const id = deviceId(phone.publicKey);
    a.ceremony.onPairRequest(request(qr, phone));
    expect(await a.ceremony.confirm(true, id, codeFor(a.identity, phone))).toEqual({ error: 'group_full' });
    expect(a.relay.posts.at(-1)).toEqual({ path: '/pair/confirm', payload: { phone: id, accept: false } });
    expect(a.paired.size).toBe(0);
    expect(a.calls.addPaired).toEqual([]);
    expect(a.ceremony.state()).toMatchObject({ pendingPair: null, pairing: null });
  });

  it('a group that fills while the accept is out drops the pair again: not half added', async () => {
    const a = build({ fills: true });
    const qr = await showCode(a);
    const phone = generateIdentity();
    const id = deviceId(phone.publicKey);
    a.ceremony.onPairRequest(request(qr, phone));
    expect(await a.ceremony.confirm(true, id, codeFor(a.identity, phone))).toEqual({ error: 'group_full' });
    expect(a.paired.size).toBe(0);
    expect(a.calls).toMatchObject({ abandoned: [id], revoked: [id], opened: [] });
  });

  it('undoes the pair when the relay does not take the accept', async () => {
    const a = build({ answers: { '/pair/confirm': { status: 500, body: {} } } });
    const qr = await showCode(a);
    const phone = generateIdentity();
    const id = deviceId(phone.publicKey);
    a.ceremony.onPairRequest(request(qr, phone));
    expect(await a.ceremony.confirm(true, id, codeFor(a.identity, phone))).toEqual({ error: 'relay_error' });
    expect(a.paired.size).toBe(0);
    expect(a.calls.abandoned).toEqual([id]);
    expect(a.calls.addPaired).toEqual([]);
  });
});

describe('PairingCeremony as the newcomer', () => {
  it('refuses a code from another relay, its own, a device already paired, and from another group while in one', async () => {
    const adder = build({ inGroup: true });
    const qr = await showCode(adder);
    expect(qr.group).toBe(true);
    const code = JSON.stringify(qr);

    expect(await build().ceremony.join(JSON.stringify({ ...qr, relay: 'wss://other.example' })))
      .toEqual({ error: 'other_relay', relay: 'wss://other.example' });
    const alone = build();
    expect(await alone.ceremony.join(JSON.stringify(await showCode(alone)))).toEqual({ error: 'bad_code' });
    const pairedAlready = build({ paired: [{ id: qr.mac, name: 'x', platform: '', kind: 'desktop', pairedAt: 1, lastSeenAt: null }] });
    expect(await pairedAlready.ceremony.join(code)).toEqual({ error: 'already_paired' });
    const inOther = build({ inGroup: true });
    expect(await inOther.ceremony.join(code)).toEqual({ error: 'in_group' });
    expect(inOther.relay.posts).toEqual([]);
  });

  it('takes a code from a member of its own group', async () => {
    const adder = build();
    const qr = await showCode(adder);
    const n = build({ inGroup: true, members: [qr.mac] });
    expect(await n.ceremony.join(JSON.stringify(qr))).toEqual({ device: qr.mac, name: 'self', code: codeFor(adder.identity, n.identity) });
  });

  it('a paired for the joined device pairs it, and leaves its entry to its own roster; the code is the one the adder expects', async () => {
    const adder = build();
    const qr = await showCode(adder);
    const n = build();
    const res = await n.ceremony.join(JSON.stringify(qr));
    expect(n.relay.posts.map((p) => p.path)).toEqual(['/pair/redeem']);
    // The adder reads the redeem and compares the code typed from the newcomer.
    adder.ceremony.onPairRequest({ type: 'pair_request', phone: n.id, ...(n.relay.posts[0].payload as { proof: string; device: string }) });
    expect(adder.ceremony.state().pendingPair).toMatchObject({ phone: n.id, name: 'self', platform: 'macos', kind: 'desktop' });
    expect(await adder.ceremony.confirm(true, n.id, (res as { code: string }).code)).toEqual({ ok: true });

    expect(n.ceremony.state().joining).toMatchObject({ device: qr.mac, kind: 'desktop' });
    expect(n.ceremony.onPaired(qr.mac)).toBe(true);
    expect(n.paired.get(qr.mac)).toMatchObject({ name: 'self', platform: '', kind: 'desktop' });
    expect(n.calls.addPaired).toEqual([]);
    expect(n.calls).toMatchObject({ opened: [qr.mac], unrevoked: [qr.mac] });
    expect(n.ceremony.state().joining).toBeNull();
    // Not ours: a `paired` for any other device is left to the host.
    expect(n.ceremony.onPaired(adder.id + 'x')).toBe(false);
  });

  it('a paired after cancelJoin revokes the pair and adds nothing; after the code expired, nothing', async () => {
    const qr = await showCode(build());
    const n = build();
    await n.ceremony.join(JSON.stringify(qr));
    expect(n.ceremony.cancelJoin()).toBe(true);
    expect(n.ceremony.cancelJoin()).toBe(false);
    expect(n.ceremony.onPaired(qr.mac)).toBe(true);
    expect(n.calls.revoked).toEqual([qr.mac]);
    expect(n.paired.size).toBe(0);

    const late = build();
    await late.ceremony.join(JSON.stringify(qr));
    late.ceremony.cancelJoin();
    late.advance(EXPIRES);
    expect(late.ceremony.onPaired(qr.mac)).toBe(true);
    expect(late.calls.revoked).toEqual([]);
  });

  it('rejected clears the join', async () => {
    const qr = await showCode(build());
    const n = build();
    await n.ceremony.join(JSON.stringify(qr));
    expect(n.ceremony.onRejected('someone else')).toBe(false);
    expect(n.ceremony.onRejected(qr.mac)).toBe(true);
    expect(n.ceremony.state().joining).toBeNull();
    expect(n.ceremony.onPaired(qr.mac)).toBe(false);
  });
});

describe('PairingCeremony between two phones', () => {
  it('a phone showing its code refuses another phone: rejected at the relay, never asked, the code spent', async () => {
    const shower = build({ kind: 'phone' });
    const qr = await showCode(shower);
    const phone = generateIdentity();
    shower.ceremony.onPairRequest(request(qr, phone));
    await new Promise((r) => setTimeout(r, 0));
    const state = shower.ceremony.state();
    expect(state.pendingPair).toBeNull();
    expect(state.pairing).toBeNull();
    expect(state.refused).toEqual({ phone: deviceId(phone.publicKey), name: 'Pixel', error: 'phone_to_phone' });
    expect(shower.calls.announced).toEqual([]);
    expect(shower.relay.posts).toContainEqual({ path: '/pair/confirm', payload: { phone: deviceId(phone.publicKey), accept: false } });
    // The next code starts clean.
    await showCode(shower);
    expect(shower.ceremony.state().refused).toBeNull();
  });

  it('a phone showing its code still takes a desktop', async () => {
    const shower = build({ kind: 'phone' });
    const qr = await showCode(shower);
    const mac = generateIdentity();
    const secret = fromBase64Url(qr.secret);
    shower.ceremony.onPairRequest({
      type: 'pair_request', phone: deviceId(mac.publicKey), proof: devicePairingProof(secret, mac.publicKey),
      device: sealPairingDevice(secret, mac.publicKey, { name: 'studio', platform: 'darwin', kind: 'desktop' }),
    });
    expect(shower.ceremony.state().pendingPair).toMatchObject({ kind: 'desktop' });
  });

  it("a phone refuses another phone's code before it asks the relay", async () => {
    const shower = build({ kind: 'phone' });
    const qr = await showCode(shower);
    const joiner = build({ kind: 'phone' });
    expect(await joiner.ceremony.join(JSON.stringify(qr))).toEqual({ error: 'phone_to_phone' });
    expect(joiner.relay.posts).toEqual([]);
    // A desktop takes the same code.
    expect(await build().ceremony.join(JSON.stringify(qr))).toHaveProperty('device', qr.mac);
  });
});

/**
 * A whole pairing between `shower` (shows its code) and `typer` (redeems it):
 * the request, the confirm with the right code, the `paired` on the typer.
 * Answers what each side added.
 */
async function pairThrough(shower: ReturnType<typeof build>, typer: ReturnType<typeof build>) {
  const qr = await showCode(shower);
  const res = await typer.ceremony.join(JSON.stringify(qr));
  if (!('code' in res)) return { joined: res, shower: shower.calls.addPaired, typer: typer.calls.addPaired };
  const redeem = typer.relay.posts.find((p) => p.path === '/pair/redeem')!.payload as { proof: string; device: string };
  shower.ceremony.onPairRequest({ type: 'pair_request', phone: typer.id, ...redeem });
  const confirmed = shower.ceremony.state().pendingPair
    ? await shower.ceremony.confirm(true, typer.id, res.code) : { refused: shower.ceremony.state().refused };
  typer.ceremony.onPaired(shower.id);
  return { joined: confirmed, shower: shower.calls.addPaired, typer: typer.calls.addPaired };
}

describe('PairingCeremony: who adds whom', () => {
  it('both alone: the desktop showing the code founds the group', async () => {
    const res = await pairThrough(build(), build());
    expect(res.joined).toEqual({ ok: true });
    expect(res.shower.map((d) => [d.kind, d.links])).toEqual([['desktop', true]]);
    expect(res.typer).toEqual([]);
  });

  it('both alone, a phone showing the code: the device that typed it founds the group', async () => {
    const res = await pairThrough(build({ kind: 'phone' }), build());
    expect(res.joined).toEqual({ ok: true });
    expect(res.shower).toEqual([]);
    expect(res.typer.map((d) => [d.kind, d.links])).toEqual([['phone', true]]);
  });

  it('the side in a group stays its primary and adds the other, whichever shows the code', async () => {
    const shown = await pairThrough(build({ inGroup: true }), build());
    expect([shown.shower.length, shown.typer.length]).toEqual([1, 0]);
    const typed = await pairThrough(build(), build({ inGroup: true }));
    expect([typed.shower.length, typed.typer.length]).toEqual([0, 1]);
    expect(typed.typer[0]).toMatchObject({ kind: 'desktop', links: true });
  });

  it('two groups never pair: refused on both sides of the code', async () => {
    const typed = await pairThrough(build({ inGroup: true }), build({ inGroup: true }));
    expect(typed.joined).toEqual({ error: 'in_group' });
    // A typer that says it is in a group, at a primary: rejected at the relay without asking.
    const shower = build({ inGroup: true });
    const qr = await showCode(shower);
    const other = generateIdentity();
    const secret = fromBase64Url(qr.secret);
    shower.ceremony.onPairRequest({
      type: 'pair_request', phone: deviceId(other.publicKey), proof: devicePairingProof(secret, other.publicKey),
      device: sealPairingDevice(secret, other.publicKey, { name: 'studio', platform: 'darwin', kind: 'desktop', group: true }),
    });
    expect(shower.ceremony.state().refused).toMatchObject({ error: 'in_group' });
    expect(shower.calls.announced).toEqual([]);
  });

  it('a device alone that types the code of a Mac from before groups adds it; a phone adds no one', async () => {
    const qr = { ...(await showCode(build())) };
    delete qr.kind;
    const desktop = build();
    await desktop.ceremony.join(JSON.stringify(qr));
    desktop.ceremony.onPaired(qr.mac);
    expect(desktop.calls.addPaired).toMatchObject([{ id: qr.mac, kind: 'desktop', links: false }]);
    const phone = build({ kind: 'phone' });
    await phone.ceremony.join(JSON.stringify(qr));
    phone.ceremony.onPaired(qr.mac);
    expect(phone.calls.addPaired).toEqual([]);
    expect(phone.paired.has(qr.mac)).toBe(true);
  });

  it('a typer that would add to a full roster refuses before the relay; one that fills meanwhile drops the pair', async () => {
    const full = await pairThrough(build({ kind: 'phone' }), build({ full: true }));
    expect(full.joined).toEqual({ error: 'group_full' });
    const shower = build({ kind: 'phone' });
    const typer = build({ fills: true });
    await pairThrough(shower, typer);
    expect(typer.paired.has(shower.id)).toBe(false);
    expect(typer.calls).toMatchObject({ abandoned: [shower.id], revoked: [shower.id] });
  });
});

describe('PairingCeremony on a member that is not the primary', () => {
  const primary = { id: 'P'.repeat(43), name: 'studio' };

  it('shows no code and redeems none, naming the primary', async () => {
    const m = build({ inGroup: true, primary });
    expect(await m.ceremony.start()).toEqual({ error: 'not_primary', primary });
    const qr = await showCode(build());
    expect(await m.ceremony.join(JSON.stringify(qr))).toEqual({ error: 'not_primary', primary });
    expect(m.relay.posts).toEqual([]);
  });

  it('pairs by hand with a member of its own group, adding no one', async () => {
    const showerMembers: string[] = [];
    const typerMembers: string[] = [];
    const shower = build({ inGroup: true, primary, byHand: true, members: showerMembers });
    const m = build({ inGroup: true, primary, members: typerMembers });
    showerMembers.push(m.id);
    typerMembers.push(shower.id);
    const res = await pairThrough(shower, m);
    expect(res.joined).toEqual({ ok: true });
    expect([res.shower, res.typer]).toEqual([[], []]);
    // A device that is no member, at a member showing a code by hand: refused, naming nothing more.
    const other = build({ inGroup: true, primary, byHand: true });
    const qr = await showCode(other);
    const stranger = generateIdentity();
    other.ceremony.onPairRequest(request(qr, stranger, fromBase64Url(qr.secret), 'desktop'));
    expect(other.ceremony.state().refused).toMatchObject({ error: 'not_primary' });
  });
});
