import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GroupMember, MUTUAL_RETRY_MS, RELAY_POST_TIMEOUT_MS, type GroupChannel, type GroupHost, type GroupRelay,
  type PairedDevice, type SelfAbout,
} from '../src/remote/group.js';
import { deviceId, generateIdentity, type Identity } from '../src/remote/keys.js';
import type { GroupMessage, HelloMessage } from '../src/remote/messages.js';
import {
  addMember, describeMember, foundingEntry, isLive, removeMember, rosterDigest, rosterKey, type RosterEntry,
} from '../src/remote/roster.js';

const SELF_KEY = generateIdentity();
const MAC_KEY = generateIdentity();
const PHONE_KEY = generateIdentity();
const OTHER_KEY = generateIdentity();
const SELF = deviceId(SELF_KEY.publicKey);
const MAC = deviceId(MAC_KEY.publicKey);
const PHONE = deviceId(PHONE_KEY.publicKey);
const OTHER = deviceId(OTHER_KEY.publicKey);
const NOW = 1_000;

const keyOf = new Map<string, Identity>([[SELF, SELF_KEY], [MAC, MAC_KEY], [PHONE, PHONE_KEY], [OTHER, OTHER_KEY]]);

/** `roster` with `id` added by `by` (the Mac, unless it is the Mac), signed. */
function add(roster: RosterEntry[], id: string, over: { by?: string; kind?: string; links?: boolean } = {}): RosterEntry[] {
  const by = over.by ?? (id === MAC ? SELF : MAC);
  return addMember(roster, { id, kind: over.kind ?? 'desktop', name: id.slice(0, 4), os: 'macos', links: over.links ?? true }, keyOf.get(by)!, 1);
}

/** A group: this device and the Mac, and whatever else is named, each added by the Mac (the Mac by this device). */
function roster(...more: (string | [string, { by?: string; kind?: string; links?: boolean }])[]): RosterEntry[] {
  let out = add(add([], SELF), MAC);
  for (const m of more) out = typeof m === 'string' ? add(out, m) : add(out, m[0], m[1]);
  return out;
}

const removed = (entries: RosterEntry[], id: string, by = SELF) => removeMember(entries, id, keyOf.get(by)!, 5);
const one = (entries: RosterEntry[], id: string) => entries.find((e) => e.id === id)!;

type Answer = { status: number; body: unknown; unsupported?: boolean };

/** A relay connection that records what is posted and answers from `answers`; `hold` keeps every answer back. */
function fakeRelay(answers: Record<string, Answer> = {}) {
  const posts: { path: string; payload: unknown }[] = [];
  const held: (() => void)[] = [];
  const state = { hold: false };
  const relay: GroupRelay & { status: string } = {
    status: 'online',
    post<T>(path: string, _action: string, payload: unknown) {
      posts.push({ path, payload });
      const answer = (answers[path] ?? { status: 200, body: {} }) as { status: number; body: T };
      if (!state.hold) return Promise.resolve(answer);
      return new Promise<typeof answer>((resolve) => { held.push(() => resolve(answer)); });
    },
  };
  return { relay, posts, answers, held, state };
}

function fakeChannel(groups = true) {
  const sent: GroupMessage[] = [];
  const channel: GroupChannel = { groups, sendGroup: (msg) => { sent.push(msg); return true; } };
  return { channel, sent };
}

function build(opts: {
  roster?: RosterEntry[]; paired?: PairedDevice[]; relay?: ReturnType<typeof fakeRelay> | null; kind?: string;
  identity?: Identity; about?: Partial<SelfAbout>;
} = {}) {
  const identity = opts.identity ?? SELF_KEY;
  const self = deviceId(identity.publicKey);
  let entries = opts.roster ?? roster();
  const paired = new Map((opts.paired ?? []).map((d) => [d.id, d]));
  const pending = new Set<string>();
  let relay: GroupRelay | null = opts.relay === null ? null : (opts.relay ?? fakeRelay()).relay;
  const channels = new Map<string, GroupChannel>();
  const forgotten: string[] = [];
  const opened: string[] = [];
  const logs: string[] = [];
  const host: GroupHost = {
    identity: () => identity,
    about: () => ({ kind: opts.kind ?? 'desktop', name: 'self', os: 'macos', links: true, ...opts.about }),
    knownId: () => self,
    relay: () => relay,
    channels: () => channels,
    channel: (id) => channels.get(id) ?? null,
    open: (id) => { opened.push(id); },
    paired: () => {},
    forget: (id) => { forgotten.push(id); channels.delete(id); },
    forgetAll: () => { forgotten.push('*'); channels.clear(); },
    changed: () => {},
    now: () => NOW,
    log: (m) => { logs.push(m); },
  };
  const group = new GroupMember({
    roster: {
      list: () => entries,
      entry: (id) => entries.find((e) => e.id === id) ?? null,
      replace: (next) => {
        if (rosterKey(next) === rosterKey(entries)) return false;
        entries = [...next].sort((a, b) => (a.id < b.id ? -1 : 1));
        return true;
      },
      digest: () => rosterDigest(entries),
    },
    paired: {
      list: () => [...paired.values()],
      get: (id) => paired.get(id) ?? null,
      add: (d) => { paired.set(d.id, { ...d, lastSeenAt: null }); },
      remove: (id) => { paired.delete(id); },
    },
    pendingRevokes: { list: () => [...pending], add: (id) => { pending.add(id); }, remove: (id) => { pending.delete(id); } },
  }, host);
  return {
    group, channels, forgotten, opened, pending, paired, logs, self,
    roster: () => entries,
    setRelay: (r: GroupRelay | null) => { relay = r; },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const mutualAsks = (posts: { path: string }[]) => posts.filter((p) => p.path === '/pair/mutual').length;
const hello = (over: Partial<HelloMessage> = {}): HelloMessage => ({
  t: 'hello', protocol: 1, app: 'orbital', server: '1', name: 'studio', os: 'macos', capabilities: ['group'], ...over,
});

afterEach(() => { vi.useRealTimers(); });

describe('GroupMember linking', () => {
  it('asks the relay for a mutual pair with a new live member that links, once per relay connection', async () => {
    const r = fakeRelay();
    const g = build({ relay: r, roster: add([], SELF) });
    g.group.setRoster(roster());
    await flush();
    expect(r.posts).toEqual([{ path: '/pair/mutual', payload: { peer: MAC } }]);
    // Another roster change on the same connection asks only for the member it brought.
    g.group.setRoster(roster(PHONE));
    await flush();
    expect(r.posts.map((p) => p.payload)).toEqual([{ peer: MAC }, { peer: PHONE }]);
    // A new connection asks again.
    g.group.relayLost();
    g.group.relayOk();
    await flush();
    expect(mutualAsks(r.posts)).toBe(4);
  });

  it('a relay that repeats ok on one connection is asked nothing more', async () => {
    const r = fakeRelay();
    const g = build({ relay: r, roster: roster() });
    g.pending.add(OTHER);
    g.group.relayOk();
    await flush();
    const asked = r.posts.length;
    expect(asked).toBe(2);
    for (let i = 0; i < 5; i++) g.group.relayOk();
    await flush();
    expect(r.posts).toHaveLength(asked);
  });

  it('never posts twice at once for one peer, and gives up on a post past RELAY_POST_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    const r = fakeRelay();
    r.state.hold = true;
    const g = build({ relay: r, roster: roster() });
    g.group.relayOk();
    g.group.relayLost();
    g.group.relayOk();
    g.group.revokeAtRelay(OTHER);
    g.group.revokeAtRelay(OTHER);
    await vi.advanceTimersByTimeAsync(0);
    expect(mutualAsks(r.posts)).toBe(1);
    expect(r.posts.filter((p) => p.path === '/pair/revoke')).toHaveLength(1);
    // The relay never answers: past the timeout the post is given up, and the connection it was
    // asked for an earlier one asks again; the next connection posts the revoke again.
    await vi.advanceTimersByTimeAsync(RELAY_POST_TIMEOUT_MS);
    expect(mutualAsks(r.posts)).toBe(2);
    g.group.relayLost();
    g.group.relayOk();
    await vi.advanceTimersByTimeAsync(0);
    expect(mutualAsks(r.posts)).toBe(2);
    expect(r.posts.filter((p) => p.path === '/pair/revoke')).toHaveLength(2);
  });

  it('a relay without /pair/mutual (404) leaves the member to pair by hand until the next relay ok', async () => {
    const r = fakeRelay({ '/pair/mutual': { status: 404, body: {} } });
    const g = build({ relay: r, roster: add([], SELF) });
    g.group.setRoster(roster());
    await flush();
    expect(g.group.members(new Set()).find((m) => m.id === MAC)).toMatchObject({ pairByHand: true, state: 'notLinked' });
    r.answers['/pair/mutual'] = { status: 200, body: {} };
    g.group.relayOk();
    expect(g.group.members(new Set()).find((m) => m.id === MAC)).toMatchObject({ pairByHand: false, state: 'linking' });
  });

  it('a rate-limited ask (429) is asked again after MUTUAL_RETRY_MS', async () => {
    vi.useFakeTimers();
    const r = fakeRelay({ '/pair/mutual': { status: 429, body: {} } });
    const g = build({ relay: r, roster: add([], SELF) });
    g.group.setRoster(roster());
    await vi.advanceTimersByTimeAsync(0);
    expect(mutualAsks(r.posts)).toBe(1);
    await vi.advanceTimersByTimeAsync(MUTUAL_RETRY_MS - 1);
    expect(mutualAsks(r.posts)).toBe(1);
    r.answers['/pair/mutual'] = { status: 200, body: {} };
    await vi.advanceTimersByTimeAsync(1);
    expect(mutualAsks(r.posts)).toBe(2);
  });

  it('a stopped member does not ask again after a rate limit', async () => {
    vi.useFakeTimers();
    const r = fakeRelay({ '/pair/mutual': { status: 429, body: {} } });
    const g = build({ relay: r, roster: add([], SELF) });
    g.group.setRoster(roster());
    await vi.advanceTimersByTimeAsync(0);
    g.group.stop();
    await vi.advanceTimersByTimeAsync(MUTUAL_RETRY_MS * 2);
    expect(mutualAsks(r.posts)).toBe(1);
  });

  it('an answer from an earlier relay connection is ignored', async () => {
    const r = fakeRelay({ '/pair/mutual': { status: 404, body: {} } });
    const g = build({ relay: r, roster: add([], SELF) });
    g.group.setRoster(roster());
    g.setRelay(fakeRelay().relay);
    await flush();
    expect(g.group.members(new Set()).find((m) => m.id === MAC)?.pairByHand).toBe(false);
  });

  it('linked for a live member that links pairs it and opens its channel', () => {
    const g = build({ roster: roster() });
    g.group.relayLinked(MAC);
    expect(g.paired.get(MAC)).toMatchObject({ id: MAC, kind: 'desktop', pairedAt: NOW });
    expect(g.opened).toEqual([MAC]);
  });

  it('linked for a removed member revokes the pair; for a phone it is ignored', async () => {
    const r = fakeRelay();
    const g = build({ roster: removed(roster([PHONE, { kind: 'phone', links: false }]), MAC), relay: r });
    g.group.relayLinked(MAC);
    g.group.relayLinked(PHONE);
    await flush();
    expect(r.posts).toEqual([{ path: '/pair/revoke', payload: { phone: MAC } }]);
    expect(g.paired.size).toBe(0);
  });

  it('a phone never asks another phone of its group for a mutual pair, and reads it as paired elsewhere', async () => {
    const r = fakeRelay();
    const g = build({ kind: 'phone', relay: r, roster: add([], SELF, { kind: 'phone' }) });
    g.group.setRoster(add(add(add([], SELF, { kind: 'phone' }), MAC), OTHER, { kind: 'phone' }));
    g.group.relayOk();
    await flush();
    expect(r.posts.filter((p) => p.path === '/pair/mutual').map((p) => p.payload)).toEqual([{ peer: MAC }, { peer: MAC }]);
    const other = g.group.members(new Set([OTHER])).find((m) => m.id === OTHER);
    expect(other).toMatchObject({ links: true, linked: false, state: 'online' });
  });

  it('linked for another phone, on a phone, revokes the pair and drops a row kept for it', async () => {
    const r = fakeRelay();
    const g = build({
      kind: 'phone', relay: r,
      roster: add(add(add([], SELF, { kind: 'phone' }), MAC), OTHER, { kind: 'phone' }),
      paired: [{ id: OTHER, name: 'pixel', platform: 'android', kind: 'phone', pairedAt: 1, lastSeenAt: null }],
    });
    g.group.relayLinked(OTHER);
    await flush();
    expect(r.posts).toEqual([{ path: '/pair/revoke', payload: { phone: OTHER } }]);
    expect(g.paired.size).toBe(0);
    expect(g.forgotten).toEqual([OTHER]);
    expect(g.opened).toEqual([]);
  });

  it('a desktop links with a phone of its group as before', async () => {
    const r = fakeRelay();
    const g = build({ relay: r, roster: add([], SELF) });
    g.group.setRoster(add(add([], SELF), PHONE, { kind: 'phone' }));
    await flush();
    expect(r.posts).toEqual([{ path: '/pair/mutual', payload: { peer: PHONE } }]);
    g.group.relayLinked(PHONE);
    expect(g.opened).toEqual([PHONE]);
  });
});

describe('GroupMember removal', () => {
  const macRow: PairedDevice = { id: MAC, name: 'Mac', platform: 'macos', kind: 'desktop', pairedAt: 1, lastSeenAt: null };

  it('removing a member drops it here, sends it the signed roster that says so, and revokes the pair', async () => {
    const r = fakeRelay();
    const g = build({ roster: roster(), paired: [macRow], relay: r });
    const { channel, sent } = fakeChannel();
    g.channels.set(MAC, channel);
    expect(await g.group.remove(MAC)).toEqual({ ok: true });
    const told = sent.find((m) => m.t === 'roster');
    expect(told?.t === 'roster' && one(told.entries, MAC)).toMatchObject({ removedBy: SELF });
    expect(g.forgotten).toEqual([MAC]);
    expect(g.paired.has(MAC)).toBe(false);
    expect(isLive(one(g.roster(), MAC))).toBe(false);
    expect(r.posts).toContainEqual({ path: '/pair/revoke', payload: { phone: MAC } });
    expect(g.pending.size).toBe(0);
  });

  it('a revoke made while the relay is offline stays pending and is posted at the next relay ok', async () => {
    const r = fakeRelay();
    r.relay.status = 'connecting';
    const g = build({ roster: roster(), paired: [macRow], relay: r });
    await g.group.remove(MAC);
    expect(r.posts).toEqual([]);
    expect([...g.pending]).toEqual([MAC]);
    r.relay.status = 'online';
    g.group.relayOk();
    await flush();
    expect(r.posts).toContainEqual({ path: '/pair/revoke', payload: { phone: MAC } });
    expect(g.pending.size).toBe(0);
  });

  it('a revoke the relay fails stays pending', async () => {
    const r = fakeRelay({ '/pair/revoke': { status: 500, body: {} } });
    const g = build({ roster: roster(), paired: [macRow], relay: r });
    await g.group.remove(MAC);
    expect([...g.pending]).toEqual([MAC]);
  });

  it('this device removed by another member leaves: its founding entry, a group of one', async () => {
    const r = fakeRelay();
    const phoneRow: PairedDevice = { id: PHONE, name: 'Phone', platform: 'ios', kind: 'phone', pairedAt: 1, lastSeenAt: null };
    const before = roster([PHONE, { kind: 'phone', links: false }]);
    const g = build({ roster: before, paired: [macRow, phoneRow], relay: r });
    const mac = fakeChannel();
    g.channels.set(MAC, mac.channel);
    g.group.onGroup(MAC, mac.channel, { t: 'roster', entries: removed(before, SELF, MAC) });
    await flush();
    // The others hear the roster that says this device and its phone are gone.
    const told = mac.sent.find((m) => m.t === 'roster');
    expect(told && told.t === 'roster' && told.entries.filter((e) => !isLive(e)).map((e) => e.id).sort()).toEqual([PHONE, SELF].sort());
    expect(g.forgotten).toEqual(['*']);
    expect(g.paired.size).toBe(0);
    expect(r.posts.filter((p) => p.path === '/pair/revoke').map((p) => (p.payload as { phone: string }).phone).sort())
      .toEqual([MAC, PHONE].sort());
    expect(g.roster()).toHaveLength(1);
    expect(g.roster()[0]).toMatchObject({ id: SELF, epoch: 0, addedBy: SELF });
    expect(isLive(g.roster()[0])).toBe(true);
  });

  it('leaving is refused while the relay is offline', async () => {
    const r = fakeRelay();
    r.relay.status = 'connecting';
    const g = build({ roster: roster(), relay: r });
    expect(await g.group.remove(SELF)).toEqual({ error: 'offline' });
    expect(isLive(one(g.roster(), SELF))).toBe(true);
  });

  it('a removal merged from another member drops a paired member', () => {
    const g = build({ roster: roster(PHONE), paired: [macRow] });
    g.group.onGroup(PHONE, fakeChannel().channel, { t: 'roster', entries: removed(g.roster(), MAC, PHONE) });
    expect(g.paired.has(MAC)).toBe(false);
    expect(g.forgotten).toEqual([MAC]);
  });

  it('a removal signed by a device no member knows is not taken', () => {
    const g = build({ roster: roster(), paired: [macRow] });
    const stranger = generateIdentity();
    const entries = removeMember(g.roster(), MAC, stranger, 5);
    g.group.onGroup(MAC, fakeChannel().channel, { t: 'roster', entries });
    expect(isLive(one(g.roster(), MAC))).toBe(true);
    expect(g.paired.has(MAC)).toBe(true);
  });
});

describe('GroupMember merging a roster', () => {
  const macRow: PairedDevice = { id: MAC, name: 'Mac', platform: 'macos', kind: 'desktop', pairedAt: 1, lastSeenAt: null };

  it('a removed device cannot re-add itself, through any member', () => {
    const g = build({ roster: removed(roster(OTHER), MAC), paired: [macRow] });
    const readded = describeMember(add([], MAC, { by: MAC }), MAC, { name: 'back', os: 'macos', links: true }, MAC_KEY, 9);
    expect(readded).toEqual([]);
    // Its own founding entry, which it signs, is all it can make of itself.
    const founding = foundingEntry(MAC_KEY, 'desktop', { name: 'back', os: 'macos', links: true }, 9);
    g.group.onGroup(OTHER, fakeChannel().channel, { t: 'roster', entries: [founding] });
    expect(isLive(one(g.roster(), MAC))).toBe(false);
  });

  it('a re-add by another member spreads through a third member', () => {
    const removedHere = removed(roster(OTHER), MAC);
    const third = build({ roster: removedHere });
    const readded = add(removedHere, MAC, { by: OTHER });
    third.group.onGroup(OTHER, fakeChannel().channel, { t: 'roster', entries: readded });
    expect(one(third.roster(), MAC)).toEqual(one(readded, MAC));
    expect(one(third.roster(), MAC).epoch).toBe(2);
    // And from there, to a member that heard of it through this one.
    const fourth = build({ roster: removedHere });
    fourth.group.onGroup(SELF, fakeChannel().channel, { t: 'roster', entries: third.roster() });
    expect(one(fourth.roster(), MAC)).toEqual(one(readded, MAC));
  });

  it('a member cannot describe another, and its hello does not change its kind', () => {
    const g = build({ roster: roster(PHONE, OTHER) });
    // OTHER signs a description of the phone, under the membership the Mac signed.
    const held = one(g.roster(), PHONE);
    const forged = describeMember([{ ...held, addedBy: OTHER }], PHONE, { name: 'renamed', os: 'x', links: false }, OTHER_KEY, 9)
      .map((e) => ({ ...e, addedBy: held.addedBy }));
    g.group.onGroup(OTHER, fakeChannel().channel, { t: 'roster', entries: forged });
    expect(one(g.roster(), PHONE)).toMatchObject({ name: PHONE.slice(0, 4), links: true });
    // A phone added as a phone says it is a desktop.
    const phone = build({ roster: roster([PHONE, { kind: 'phone' }]) });
    phone.group.onPeerHello(PHONE, fakeChannel().channel, hello({ kind: 'desktop' }));
    expect(one(phone.roster(), PHONE).kind).toBe('phone');
  });

  it('two members that keep a different entry for the sender do not trade rosters forever', () => {
    const g = build({ roster: roster() });
    g.group.setRoster(g.roster());
    const mac = fakeChannel();
    // An entry for the Mac far above the one held is not taken; this side has nothing the sender would take.
    let far = g.roster();
    for (let i = 0; i < 9; i++) far = add(removed(far, MAC, OTHER), MAC, { by: OTHER });
    g.group.onGroup(MAC, mac.channel, { t: 'roster', entries: [...far, ...add([], OTHER, { by: SELF })] });
    expect(mac.sent.filter((m) => m.t === 'roster')).toEqual([]);
  });
});

describe('GroupMember members', () => {
  it('reads each member as Settings shows it, without the signatures', async () => {
    const r = fakeRelay({ '/pair/mutual': { status: 404, body: {} } });
    const gone = generateIdentity();
    const g = build({
      roster: removed(
        add(roster([PHONE, { kind: 'phone', links: false }], OTHER), deviceId(gone.publicKey)), deviceId(gone.publicKey),
      ),
      paired: [{ id: MAC, name: 'Mac', platform: 'macos', kind: 'desktop', pairedAt: 1, lastSeenAt: 7 }],
      relay: r,
    });
    g.group.link();
    await flush();
    const rows = g.group.members(new Set([PHONE]));
    const states = Object.fromEntries(rows.map((m) => [m.id, [m.state, m.linked, m.seenAt]]));
    expect(states).toEqual({
      [SELF]: ['self', false, null],
      [MAC]: ['offline', true, 7],
      [PHONE]: ['online', false, null],
      [OTHER]: ['notLinked', false, null],
    });
    expect(rows.some((m) => 'addedSig' in m || 'describedSig' in m)).toBe(false);
    expect(g.group.inGroup()).toBe(true);
  });

  it('a device with only its phones paired here is not in a group', () => {
    const g = build({
      roster: add([foundingEntry(SELF_KEY, 'desktop', { name: 'self', os: 'macos', links: true }, 1)], PHONE, {
        by: SELF, kind: 'phone', links: false,
      }),
      paired: [{ id: PHONE, name: 'Phone', platform: 'ios', kind: 'phone', pairedAt: 1, lastSeenAt: null }],
    });
    expect(g.group.inGroup()).toBe(false);
  });
});

describe('GroupMember joining', () => {
  it('the adder writes the newcomer as added by itself, as the pairing named it', () => {
    const g = build();
    g.group.addPaired({ id: PHONE, kind: 'phone', name: 'Pixel', os: 'android', links: true });
    expect(one(g.roster(), PHONE)).toMatchObject({ addedBy: SELF, describedBy: SELF, kind: 'phone', epoch: 1 });
  });

  it('a device that keeps no roster is added at its hello, by the device that holds its pair', () => {
    const g = build({ paired: [{ id: PHONE, name: 'Phone', platform: 'ios', kind: 'phone', pairedAt: 1, lastSeenAt: null }] });
    g.group.onPeerHello(PHONE, fakeChannel(false).channel, hello({ name: 'renamed', os: 'ios', capabilities: [] }));
    expect(one(g.roster(), PHONE)).toMatchObject({ addedBy: SELF, kind: 'phone', name: 'renamed', links: false });
    // Its adder writes what its next hello says: it never describes itself.
    g.group.onPeerHello(PHONE, fakeChannel(false).channel, hello({ name: 'again', os: 'ios', capabilities: [] }));
    expect(one(g.roster(), PHONE).name).toBe('again');
  });

  it('two devices pairing by a code end with each added by the other, each described by itself', () => {
    const mac = build({
      identity: MAC_KEY, roster: [foundingEntry(MAC_KEY, 'desktop', { name: 'mac', os: 'macos', links: true }, 1)],
      about: { name: 'mac' },
    });
    const joiner = build({
      identity: PHONE_KEY, kind: 'phone', about: { name: 'pixel', os: 'android' },
      roster: [foundingEntry(PHONE_KEY, 'phone', { name: 'pixel', os: 'android', links: true }, 1)],
    });
    // The Mac confirmed the phone's request; the phone heard `paired` and holds the Mac's row.
    mac.paired.set(PHONE, { id: PHONE, name: 'pixel', platform: 'android', kind: 'phone', pairedAt: 1, lastSeenAt: null });
    mac.group.addPaired({ id: PHONE, kind: 'phone', name: 'pixel', os: 'android', links: true });
    joiner.paired.set(MAC, { id: MAC, name: 'mac', platform: '', kind: 'desktop', pairedAt: 1, lastSeenAt: null });
    // A channel between the two, delivering at once.
    const queue: [ReturnType<typeof build>, string, GroupChannel, GroupMessage][] = [];
    const toJoiner: GroupChannel = { groups: true, sendGroup: (m) => { queue.push([joiner, MAC, toMac, m]); return true; } };
    const toMac: GroupChannel = { groups: true, sendGroup: (m) => { queue.push([mac, PHONE, toJoiner, m]); return true; } };
    mac.channels.set(PHONE, toJoiner);
    joiner.channels.set(MAC, toMac);
    mac.group.onPeerHello(PHONE, toJoiner, hello({ name: 'pixel', os: 'android', kind: 'phone' }));
    joiner.group.onPeerHello(MAC, toMac, hello({ name: 'mac', kind: 'desktop' }));
    mac.group.channelReady(toJoiner);
    joiner.group.channelReady(toMac);
    for (let i = 0; queue.length > 0 && i < 50; i++) {
      const [to, from, back, msg] = queue.shift()!;
      to.group.onGroup(from, back, msg);
    }
    expect(queue).toHaveLength(0);
    expect(rosterDigest(mac.roster())).toBe(rosterDigest(joiner.roster()));
    expect(one(mac.roster(), PHONE)).toMatchObject({ addedBy: MAC, describedBy: PHONE, kind: 'phone', name: 'pixel' });
    expect(one(mac.roster(), MAC)).toMatchObject({ addedBy: PHONE, describedBy: MAC, kind: 'desktop', name: 'mac' });
    expect(one(joiner.roster(), MAC)).toEqual(one(mac.roster(), MAC));
  });
});
