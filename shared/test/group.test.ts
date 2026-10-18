import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GroupMember, MUTUAL_RETRY_MS, RELAY_POST_TIMEOUT_MS, type GroupChannel, type GroupHost, type GroupRelay,
  type PairedDevice, type SelfAbout,
} from '../src/remote/group.js';
import { deviceId, generateIdentity, type Identity } from '../src/remote/keys.js';
import type { GroupMessage, HelloMessage } from '../src/remote/messages.js';
import {
  EMPTY_ROSTER, ROSTER_MAX_ENTRIES, describeDevice, foundRoster, leftNotice, memberIds, nextRoster, normalize,
  rosterDigest, rosterKey, rosterMembers, type RosterState,
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

type Spec = string | [string, { kind?: string; links?: boolean }];
const specOf = (m: Spec) => (typeof m === 'string' ? { id: m, kind: 'desktop', links: true } : { id: m[0], kind: m[1].kind ?? 'desktop', links: m[1].links ?? true });

/** `primary`'s group of itself and `members`, at version 1, each described by the primary. */
function doc(primary: Identity, members: Spec[]): RosterState {
  const all = members.map(specOf);
  const roster = foundRoster(primary, 'desktop', all, 1)!;
  const self = deviceId(primary.publicKey);
  return {
    roster,
    descriptions: [
      describeDevice(self, { name: self.slice(0, 4), os: 'macos', links: true }, primary, 1),
      ...all.map((m) => describeDevice(m.id, { name: m.id.slice(0, 4), os: 'macos', links: m.links }, primary, 1)),
    ],
    left: [],
  };
}

/** The Mac's group: the Mac (its primary), this device and whatever else is named. */
const roster = (...more: Spec[]) => doc(MAC_KEY, [SELF, ...more]);

/** `state` moved on by its primary. */
function moved(state: RosterState, change: { add?: Spec[]; remove?: string[] }, by = MAC_KEY): RosterState {
  const add = (change.add ?? []).map(specOf);
  return normalize({
    roster: nextRoster(state.roster!, by, { add, remove: change.remove ?? [] }, 2)!,
    descriptions: [...state.descriptions, ...add.map((m) => describeDevice(m.id, { name: m.id.slice(0, 4), os: 'macos', links: m.links }, by, 2))],
    left: state.left,
  });
}

/** A pair this device holds with `id`: group messages are taken only from a paired device. */
const row = (id: string, kind = 'desktop'): PairedDevice => ({ id, name: id.slice(0, 4), platform: 'macos', kind, pairedAt: 1, lastSeenAt: null });
const roster$ = (msg: GroupMessage | undefined): RosterState | null => (msg?.t === 'roster' ? msg : null);

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
  roster?: RosterState; paired?: PairedDevice[]; relay?: ReturnType<typeof fakeRelay> | null; kind?: string;
  identity?: Identity; about?: Partial<SelfAbout>;
  /** The group id stored apart from the roster; by default the held document's group. */
  groupId?: string | null;
} = {}) {
  const identity = opts.identity ?? SELF_KEY;
  const self = deviceId(identity.publicKey);
  let state = normalize(opts.roster ?? roster());
  let groupId = opts.groupId !== undefined ? opts.groupId : state.roster && !state.roster.dissolved ? state.roster.group : null;
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
      read: () => state,
      replace: (next) => {
        if (rosterKey(next) === rosterKey(state)) return false;
        state = normalize(next);
        return true;
      },
      digest: () => rosterDigest(state),
    },
    paired: {
      list: () => [...paired.values()],
      get: (id) => paired.get(id) ?? null,
      add: (d) => { paired.set(d.id, { ...d, lastSeenAt: null }); },
      remove: (id) => { paired.delete(id); },
    },
    pendingRevokes: { list: () => [...pending], add: (id) => { pending.add(id); }, remove: (id) => { pending.delete(id); } },
    groupId: { get: () => groupId, set: (id) => { groupId = id; } },
  }, host);
  return {
    group, channels, forgotten, opened, pending, paired, logs, self,
    state: () => state,
    groupId: () => groupId,
    setRelay: (r: GroupRelay | null) => { relay = r; },
  };
}

type Built = ReturnType<typeof build>;

/** Every group message between the built members delivered at once, in order, until none is left. */
function wire(...members: Built[]) {
  const queue: [Built, string, GroupChannel, GroupMessage][] = [];
  const ends = new Map<string, GroupChannel>();
  for (const a of members) {
    for (const b of members) {
      if (a === b) continue;
      const channel: GroupChannel = { groups: true, sendGroup: (m) => { queue.push([b, a.self, ends.get(`${b.self}>${a.self}`)!, m]); return true; } };
      ends.set(`${a.self}>${b.self}`, channel);
      a.channels.set(b.self, channel);
    }
  }
  return {
    ready: () => {
      for (const a of members) for (const [, channel] of a.channels) a.group.channelReady(channel);
    },
    flush: () => {
      for (let i = 0; queue.length > 0 && i < 200; i++) {
        const [to, from, back, msg] = queue.shift()!;
        to.group.onGroup(from, back, msg);
      }
      return queue.length;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const mutualAsks = (posts: { path: string }[]) => posts.filter((p) => p.path === '/pair/mutual').length;
const revoked = (posts: { path: string; payload: unknown }[]) =>
  posts.filter((p) => p.path === '/pair/revoke').map((p) => (p.payload as { phone: string }).phone).sort();
const hello = (over: Partial<HelloMessage> = {}): HelloMessage => ({
  t: 'hello', protocol: 1, app: 'orbital', server: '1', name: 'studio', os: 'macos', capabilities: ['group'], ...over,
});

afterEach(() => { vi.useRealTimers(); });

describe('GroupMember linking', () => {
  it('asks the relay for a mutual pair with a new member that links, once per relay connection', async () => {
    const r = fakeRelay();
    const g = build({ relay: r, roster: EMPTY_ROSTER });
    g.group.setRoster(roster());
    await flush();
    expect(r.posts).toEqual([{ path: '/pair/mutual', payload: { peer: MAC } }]);
    // Another version on the same connection asks only for the member it brought.
    g.group.setRoster(moved(roster(), { add: [PHONE] }));
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
    const g = build({ relay: r });
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
    const g = build({ relay: r });
    g.group.relayOk();
    g.group.relayLost();
    g.group.relayOk();
    g.group.revokeAtRelay(OTHER);
    g.group.revokeAtRelay(OTHER);
    await vi.advanceTimersByTimeAsync(0);
    expect(mutualAsks(r.posts)).toBe(1);
    expect(r.posts.filter((p) => p.path === '/pair/revoke')).toHaveLength(1);
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
    const g = build({ relay: r, roster: EMPTY_ROSTER });
    g.group.setRoster(roster());
    await flush();
    expect(g.group.members(new Set()).find((m) => m.id === MAC)).toMatchObject({ pairByHand: true, state: 'notLinked' });
    expect(g.group.byHandPending()).toBe(true);
    r.answers['/pair/mutual'] = { status: 200, body: {} };
    g.group.relayOk();
    expect(g.group.members(new Set()).find((m) => m.id === MAC)).toMatchObject({ pairByHand: false, state: 'linking' });
  });

  it('a rate-limited ask (429) is asked again after MUTUAL_RETRY_MS', async () => {
    vi.useFakeTimers();
    const r = fakeRelay({ '/pair/mutual': { status: 429, body: {} } });
    const g = build({ relay: r, roster: EMPTY_ROSTER });
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
    const g = build({ relay: r, roster: EMPTY_ROSTER });
    g.group.setRoster(roster());
    await vi.advanceTimersByTimeAsync(0);
    g.group.stop();
    await vi.advanceTimersByTimeAsync(MUTUAL_RETRY_MS * 2);
    expect(mutualAsks(r.posts)).toBe(1);
  });

  it('an answer from an earlier relay connection is ignored', async () => {
    const r = fakeRelay({ '/pair/mutual': { status: 404, body: {} } });
    const g = build({ relay: r, roster: EMPTY_ROSTER });
    g.group.setRoster(roster());
    g.setRelay(fakeRelay().relay);
    await flush();
    expect(g.group.members(new Set()).find((m) => m.id === MAC)?.pairByHand).toBe(false);
  });

  it('linked for a member that links pairs it and opens its channel', () => {
    const g = build();
    g.group.relayLinked(MAC);
    expect(g.paired.get(MAC)).toMatchObject({ id: MAC, kind: 'desktop', pairedAt: NOW });
    expect(g.opened).toEqual([MAC]);
  });

  it('linked for a device the group no longer names revokes the pair; for a member that does not link it is ignored', async () => {
    const r = fakeRelay();
    const g = build({ roster: roster([PHONE, { kind: 'phone', links: false }]), relay: r });
    g.group.relayLinked(OTHER);
    g.group.relayLinked(PHONE);
    await flush();
    expect(r.posts).toEqual([{ path: '/pair/revoke', payload: { phone: OTHER } }]);
    expect(g.paired.size).toBe(0);
  });

  it('a phone never asks another phone of its group for a mutual pair, and reads it as paired elsewhere', async () => {
    const r = fakeRelay();
    const g = build({ kind: 'phone', relay: r, roster: EMPTY_ROSTER });
    g.group.setRoster(doc(MAC_KEY, [[SELF, { kind: 'phone' }], [OTHER, { kind: 'phone' }]]));
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
      roster: doc(MAC_KEY, [[SELF, { kind: 'phone' }], [OTHER, { kind: 'phone' }]]),
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
    const g = build({ relay: r, roster: EMPTY_ROSTER });
    g.group.setRoster(doc(SELF_KEY, [[PHONE, { kind: 'phone' }]]));
    await flush();
    expect(r.posts).toEqual([{ path: '/pair/mutual', payload: { peer: PHONE } }]);
    g.group.relayLinked(PHONE);
    expect(g.opened).toEqual([PHONE]);
  });
});

describe('GroupMember removal', () => {
  it('the primary removes a member: a version without it, sent to it, and its pair revoked', async () => {
    const r = fakeRelay();
    const g = build({ roster: doc(SELF_KEY, [MAC, OTHER]), paired: [row(MAC), row(OTHER)], relay: r });
    const { channel, sent } = fakeChannel();
    g.channels.set(MAC, channel);
    expect(await g.group.remove(MAC)).toEqual({ ok: true });
    const told = roster$(sent.find((m) => m.t === 'roster'));
    expect(told?.roster).toMatchObject({ group: SELF, version: 2 });
    expect(memberIds(told!)).not.toContain(MAC);
    expect(g.forgotten).toEqual([MAC]);
    expect(g.paired.has(MAC)).toBe(false);
    expect(memberIds(g.state())).toEqual([OTHER, SELF].sort());
    expect(r.posts).toContainEqual({ path: '/pair/revoke', payload: { phone: MAC } });
    expect(g.pending.size).toBe(0);
  });

  it('a member that is not the primary is refused, naming the primary; a pair outside the group is its own to drop', async () => {
    const g = build({ roster: roster(OTHER), paired: [row(MAC), row(OTHER), row(PHONE, 'phone')] });
    const before = g.state();
    expect(await g.group.remove(OTHER)).toEqual({ error: 'not_primary', primary: { id: MAC, name: MAC.slice(0, 4) } });
    expect(g.state()).toBe(before);
    expect(g.paired.has(OTHER)).toBe(true);
    expect(g.group.canAdd(PHONE)).toBe(false);
    expect(g.group.addPaired({ id: PHONE, kind: 'phone', name: 'p', os: 'ios', links: false })).toBe(false);
    // A device paired here that the group does not name: no roster to write, only the pair goes.
    expect(await g.group.remove(PHONE)).toEqual({ ok: true });
    expect(g.paired.has(PHONE)).toBe(false);
    expect(await g.group.remove(deviceId(generateIdentity().publicKey))).toEqual({ error: 'not_found' });
  });

  it('a revoke made while the relay is offline stays pending and is posted at the next relay ok', async () => {
    const r = fakeRelay();
    r.relay.status = 'connecting';
    const g = build({ roster: doc(SELF_KEY, [MAC]), paired: [row(MAC)], relay: r });
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
    const g = build({ roster: doc(SELF_KEY, [MAC]), paired: [row(MAC)], relay: r });
    await g.group.remove(MAC);
    expect([...g.pending]).toEqual([MAC]);
  });

  it('a removed device learns it from the version, through any member, and becomes alone', async () => {
    const r = fakeRelay();
    const before = roster(OTHER);
    const g = build({ roster: before, paired: [row(MAC), row(OTHER)], relay: r });
    const mac = fakeChannel();
    g.channels.set(MAC, mac.channel);
    // OTHER passes on the version the Mac signed without this device.
    g.group.onGroup(OTHER, fakeChannel().channel, { t: 'roster', ...moved(before, { remove: [SELF] }) });
    await flush();
    // What it took goes on to the members it still talks to, and then it is alone.
    expect(roster$(mac.sent.find((m) => m.t === 'roster'))?.roster?.version).toBe(2);
    expect(g.forgotten).toEqual(['*']);
    expect(g.paired.size).toBe(0);
    expect(revoked(r.posts)).toEqual([MAC, OTHER].sort());
    expect(g.state()).toEqual(EMPTY_ROSTER);
    expect(g.group.memberList()).toEqual([expect.objectContaining({ id: SELF, primary: false })]);
  });

  it('a version the primary signed reaches a member asleep at the removal through any member, and drops its pair', () => {
    const before = roster(OTHER, PHONE);
    const g = build({ roster: before, paired: [row(OTHER), row(PHONE)] });
    g.group.onGroup(PHONE, fakeChannel().channel, { t: 'roster', ...moved(before, { remove: [OTHER] }) });
    expect(g.paired.has(OTHER)).toBe(false);
    expect(g.forgotten).toEqual([OTHER]);
    // The same removal again, or an older version, changes nothing.
    g.group.onGroup(PHONE, fakeChannel().channel, { t: 'roster', ...before });
    expect(memberIds(g.state())).not.toContain(OTHER);
  });

  it('a roster a former peer had in flight, delivered after leaving, is not taken', async () => {
    const g = build({ roster: roster(OTHER), paired: [row(MAC), row(OTHER)] });
    const stale = g.state();
    expect(await g.group.leave()).toEqual({ ok: true });
    expect(g.state()).toEqual(EMPTY_ROSTER);
    const mac = fakeChannel();
    g.group.onGroup(MAC, mac.channel, { t: 'roster', ...stale });
    g.group.onGroup(OTHER, mac.channel, { t: 'roster_digest', digest: 'x' });
    expect(g.state()).toEqual(EMPTY_ROSTER);
    expect(mac.sent).toEqual([]);
    expect(g.logs.filter((l) => l.includes('not paired here'))).toHaveLength(2);
  });

  it('leaving is refused while the relay is offline', async () => {
    const r = fakeRelay();
    r.relay.status = 'connecting';
    const g = build({ relay: r });
    expect(await g.group.remove(SELF)).toEqual({ error: 'offline' });
    expect(memberIds(g.state())).toContain(SELF);
  });
});

describe('GroupMember leaving', () => {
  it('a member signs its notice, sends it and is alone; members drop it; the primary leaves it out', async () => {
    const state = roster(OTHER);
    const leaver = build({ roster: state, paired: [row(MAC), row(OTHER)] });
    const out = fakeChannel();
    leaver.channels.set(MAC, out.channel);
    expect(await leaver.group.leave()).toEqual({ ok: true });
    const notice = roster$(out.sent.find((m) => m.t === 'roster'))!;
    expect(notice.roster).toBeNull();
    expect(notice.left).toMatchObject([{ id: SELF, group: MAC, version: 1 }]);
    expect(leaver.state()).toEqual(EMPTY_ROSTER);
    // Another member takes the notice: this device is no member there, and its pair goes.
    const other = build({ identity: OTHER_KEY, roster: state, paired: [row(SELF), row(MAC)] });
    other.group.onGroup(MAC, fakeChannel().channel, { t: 'roster', ...notice });
    expect(memberIds(other.state())).not.toContain(SELF);
    expect(other.paired.has(SELF)).toBe(false);
    // The primary signs its next version without it.
    const mac = build({ identity: MAC_KEY, roster: state, paired: [row(SELF), row(OTHER)] });
    mac.group.onGroup(SELF, fakeChannel().channel, { t: 'roster', ...notice });
    expect(mac.state().roster).toMatchObject({ version: 2 });
    expect(mac.state().roster!.members.map((m) => m.id)).not.toContain(SELF);
    expect(mac.state().left).toEqual([]);
  });

  it('the primary drops a noticed device even when a version it signed since still names it', () => {
    const v1 = roster(OTHER);
    const notice = leftNotice(SELF_KEY, v1.roster!, 5);
    const v2 = moved(v1, { add: [PHONE] });
    const mac = build({ identity: MAC_KEY, roster: v2, paired: [row(SELF), row(OTHER)] });
    mac.group.onGroup(OTHER, fakeChannel().channel, { t: 'roster', roster: null, descriptions: [], left: [notice] });
    expect(mac.state().roster).toMatchObject({ version: 3 });
    expect(memberIds(mac.state())).not.toContain(SELF);
    expect(mac.paired.has(SELF)).toBe(false);
  });

  it('a notice is void once the primary adds the device again', () => {
    const state = roster(OTHER);
    const notice = leftNotice(SELF_KEY, state.roster!, 5);
    const other = build({ identity: OTHER_KEY, roster: state, paired: [row(MAC)] });
    other.group.onGroup(MAC, fakeChannel().channel, { t: 'roster', ...state, left: [notice] });
    expect(memberIds(other.state())).not.toContain(SELF);
    const readded = moved(moved(state, { remove: [SELF] }), { add: [SELF] });
    other.group.onGroup(MAC, fakeChannel().channel, { t: 'roster', ...readded, left: [notice] });
    expect(memberIds(other.state())).toContain(SELF);
  });

  it('the primary leaving dissolves the group, and every member becomes alone', async () => {
    const r = fakeRelay();
    const p = build({ identity: MAC_KEY, roster: roster(OTHER), paired: [row(SELF), row(OTHER)], relay: r });
    const toSelf = fakeChannel();
    p.channels.set(SELF, toSelf.channel);
    expect(await p.group.leave()).toEqual({ ok: true });
    expect(p.state().roster).toMatchObject({ dissolved: true, version: 2 });
    expect(p.group.primary()).toBeNull();
    expect(p.paired.size).toBe(0);
    expect(revoked(r.posts)).toEqual([SELF, OTHER].sort());
    const last = roster$(toSelf.sent.find((m) => m.t === 'roster'))!;
    const m = build({ roster: roster(OTHER), paired: [row(MAC), row(OTHER)] });
    m.group.onGroup(MAC, fakeChannel().channel, { t: 'roster', ...last });
    expect(m.state()).toEqual(EMPTY_ROSTER);
    expect(m.paired.size).toBe(0);
    // The former primary founds again from where it left: its versions go on.
    p.paired.set(PHONE, row(PHONE, 'phone'));
    expect(p.group.addPaired({ id: PHONE, kind: 'phone', name: 'p', os: 'ios', links: false })).toBe(true);
    expect(p.state().roster).toMatchObject({ version: 3, group: MAC });
  });
});

describe('GroupMember taking a roster', () => {
  it('a member cannot describe another, and a hello does not change its kind', () => {
    const g = build({ identity: MAC_KEY, roster: roster([PHONE, { kind: 'phone', links: false }], OTHER), paired: [row(OTHER)] });
    const forged = describeDevice(PHONE, { name: 'renamed', os: 'x', links: true }, OTHER_KEY, 9);
    g.group.onGroup(OTHER, fakeChannel().channel, { t: 'roster', ...g.state(), descriptions: [forged] });
    expect(rosterMembers(g.state()).find((m) => m.id === PHONE)).toMatchObject({ name: PHONE.slice(0, 4), links: false });
    // The primary describes a device that never describes itself from its hello; its kind stays.
    g.group.onPeerHello(PHONE, fakeChannel(false).channel, hello({ kind: 'desktop', name: 'pixel', capabilities: [] }));
    expect(rosterMembers(g.state()).find((m) => m.id === PHONE)).toMatchObject({ kind: 'phone', name: 'pixel', links: false });
    // A member that is not the primary describes no one.
    const m = build({ roster: roster([PHONE, { kind: 'phone', links: false }]) });
    m.group.onPeerHello(PHONE, fakeChannel(false).channel, hello({ name: 'other name', capabilities: [] }));
    expect(rosterMembers(m.state()).find((x) => x.id === PHONE)?.name).toBe(PHONE.slice(0, 4));
  });

  it('two members that hold what the other does not take do not trade rosters forever', () => {
    const g = build({ roster: roster(), paired: [row(MAC)] });
    g.group.setRoster(g.state());
    const mac = fakeChannel();
    // The same version, its own description of this device missing, and one of the Mac by a device that is no primary.
    const theirs = {
      ...roster(), descriptions: [...roster().descriptions, describeDevice(MAC, { name: 'x', os: 'y', links: true }, OTHER_KEY, 9)],
    };
    g.group.onGroup(MAC, mac.channel, { t: 'roster', ...theirs });
    // The sender lacks this device's own description: answered once.
    const answer = roster$(mac.sent.find((m) => m.t === 'roster'))!;
    expect(answer.descriptions.find((d) => d.id === SELF)?.by).toBe(SELF);
    // Its next roster holds it, and still the description this side does not take: no answer.
    mac.sent.length = 0;
    g.group.onGroup(MAC, mac.channel, { t: 'roster', ...answer, descriptions: [...answer.descriptions, theirs.descriptions.at(-1)!] });
    expect(mac.sent).toEqual([]);
  });
});

describe('GroupMember bounds', () => {
  it('at ROSTER_MAX_ENTRIES the primary adds no one, and a device paired for it is not left half added', () => {
    const others = Array.from({ length: ROSTER_MAX_ENTRIES - 1 }, () => deviceId(generateIdentity().publicKey));
    const g = build({ roster: doc(SELF_KEY, others) });
    expect(g.group.canAdd(PHONE)).toBe(false);
    expect(g.group.canAdd(others[0])).toBe(true);
    expect(g.group.addPaired({ id: PHONE, kind: 'phone', name: 'Pixel', os: 'android', links: true })).toBe(false);
    expect(g.state().roster!.members).toHaveLength(ROSTER_MAX_ENTRIES);
  });
});

describe('GroupMember members', () => {
  it('reads each member as Settings shows it, the primary marked, without the signatures', async () => {
    const r = fakeRelay({ '/pair/mutual': { status: 404, body: {} } });
    const g = build({
      roster: roster([PHONE, { kind: 'phone', links: false }], OTHER),
      paired: [{ id: MAC, name: 'Mac', platform: 'macos', kind: 'desktop', pairedAt: 1, lastSeenAt: 7 }],
      relay: r,
    });
    g.group.link();
    await flush();
    const rows = g.group.members(new Set([PHONE]));
    const states = Object.fromEntries(rows.map((m) => [m.id, [m.state, m.linked, m.seenAt, m.primary]]));
    expect(states).toEqual({
      [SELF]: ['self', false, null, false],
      [MAC]: ['offline', true, 7, true],
      [PHONE]: ['online', false, null, false],
      [OTHER]: ['notLinked', false, null, false],
    });
    expect(rows.some((m) => 'sig' in m)).toBe(false);
    expect(g.group.inGroup()).toBe(true);
    expect(g.group.primary()).toEqual({ id: MAC, name: MAC.slice(0, 4) });
    expect(g.group.isPrimary()).toBe(false);
  });

  it('a device whose group holds only its own phones is their primary, and not in a group', () => {
    const g = build({ roster: doc(SELF_KEY, [[PHONE, { kind: 'phone', links: false }]]), paired: [row(PHONE, 'phone')] });
    expect(g.group.inGroup()).toBe(false);
    expect(g.group.isPrimary()).toBe(true);
    expect(g.group.notPrimary()).toBeNull();
  });
});

describe('GroupMember with its stored roster dropped', () => {
  it('takes only its own primary\'s roster again, and becomes alone if that no longer names it', () => {
    // The Mac's group, this device a member; the document it stored did not read, the group id did.
    const g = build({ roster: EMPTY_ROSTER, groupId: MAC, paired: [row(MAC), row(OTHER)] });
    // OTHER, a member, hands it a group of its own.
    g.group.onGroup(OTHER, fakeChannel().channel, { t: 'roster', ...doc(OTHER_KEY, [SELF]) });
    expect(g.state().roster).toBeNull();
    g.group.onGroup(OTHER, fakeChannel().channel, { t: 'roster', ...roster(OTHER) });
    expect(g.state().roster?.group).toBe(MAC);
    expect(memberIds(g.state())).toContain(SELF);
    // Removed while its document was gone: the version it learns leaves it out, and it is alone.
    const h = build({ roster: EMPTY_ROSTER, groupId: MAC, paired: [row(MAC), row(OTHER)] });
    h.group.onGroup(MAC, fakeChannel().channel, { t: 'roster', ...moved(roster(OTHER), { remove: [SELF] }) });
    expect(h.state()).toEqual(EMPTY_ROSTER);
    expect(h.groupId()).toBeNull();
    expect(h.paired.size).toBe(0);
  });

  it('a device with no group id adopts a group that names it, from its primary, and keeps its id', () => {
    const g = build({ roster: EMPTY_ROSTER, paired: [row(MAC)] });
    g.group.onGroup(MAC, fakeChannel().channel, { t: 'roster', ...roster() });
    expect(g.groupId()).toBe(MAC);
    // Leaving clears it.
    return g.group.leave().then(() => expect(g.groupId()).toBeNull());
  });
});

describe('GroupMember founding and joining', () => {
  it('two devices alone: the founder signs version 1 naming both, the joiner takes it and describes itself', () => {
    const mac = build({ identity: MAC_KEY, roster: EMPTY_ROSTER, about: { name: 'mac' } });
    const joiner = build({ identity: PHONE_KEY, kind: 'phone', roster: EMPTY_ROSTER, about: { name: 'pixel', os: 'android' } });
    // The Mac confirmed the phone's request; the phone heard `paired` and holds the Mac's row.
    mac.paired.set(PHONE, row(PHONE, 'phone'));
    expect(mac.group.addPaired({ id: PHONE, kind: 'phone', name: 'pixel', os: 'android', links: true })).toBe(true);
    expect(mac.state().roster).toMatchObject({ group: MAC, version: 1 });
    joiner.paired.set(MAC, row(MAC));
    const w = wire(mac, joiner);
    w.ready();
    expect(w.flush()).toBe(0);
    expect(rosterDigest(mac.state())).toBe(rosterDigest(joiner.state()));
    expect(rosterMembers(joiner.state()).map((m) => [m.id, m.kind, m.primary]).sort())
      .toEqual([[MAC, 'desktop', true], [PHONE, 'phone', false]].sort());
    expect(joiner.state().descriptions.find((d) => d.id === PHONE)).toMatchObject({ by: PHONE, name: 'pixel' });
    expect(joiner.group.primary()).toEqual({ id: MAC, name: 'mac' });
  });

  it('a fourth device the primary adds reaches every member, and they all link with it', async () => {
    const r = fakeRelay();
    const start = roster(OTHER);
    const mac = build({ identity: MAC_KEY, roster: start, paired: [row(SELF), row(OTHER)] });
    const self = build({ roster: start, paired: [row(MAC), row(OTHER)], relay: r });
    const other = build({ identity: OTHER_KEY, roster: start, paired: [row(MAC), row(SELF)] });
    mac.paired.set(PHONE, row(PHONE, 'phone'));
    mac.group.addPaired({ id: PHONE, kind: 'phone', name: 'pixel', os: 'android', links: true });
    const w = wire(mac, self, other);
    w.ready();
    expect(w.flush()).toBe(0);
    for (const m of [self, other]) expect(memberIds(m.state())).toContain(PHONE);
    await flush();
    expect(r.posts).toContainEqual({ path: '/pair/mutual', payload: { peer: PHONE } });
  });

  it('a device in a group of only its own phones joins another primary\'s group by a ceremony, and keeps its phones paired', () => {
    const own = doc(SELF_KEY, [[PHONE, { kind: 'phone', links: false }]]);
    const g = build({ roster: own, paired: [row(PHONE, 'phone'), row(MAC)] });
    const theirs = roster(OTHER);
    // Without the ceremony naming that group, its roster is not taken.
    g.group.onGroup(MAC, fakeChannel().channel, { t: 'roster', ...theirs });
    expect(g.state().roster?.group).toBe(SELF);
    g.group.joinGroup(MAC);
    g.group.onGroup(MAC, fakeChannel().channel, { t: 'roster', ...theirs });
    expect(g.groupId()).toBe(MAC);
    expect(g.state().roster?.group).toBe(MAC);
    expect(g.paired.has(PHONE)).toBe(true);
    expect(g.group.isPrimary()).toBe(false);
  });

  it('a Mac from before groups that holds paired phones founds its group at start, as their primary', () => {
    const g = build({
      roster: EMPTY_ROSTER,
      paired: [{ ...row(PHONE), kind: null, platform: 'ios' }, row(OTHER, 'phone'), row(MAC)],
    });
    g.group.addSelf();
    const state = g.state();
    expect(state.roster).toMatchObject({ group: SELF, version: 1 });
    expect(rosterMembers(state).map((m) => [m.id, m.kind, m.links]).sort())
      .toEqual([[SELF, 'desktop', true], [PHONE, 'phone', false], [OTHER, 'phone', false]].sort());
    // A desktop paired before the roster is not a phone: it stays a pair of its own.
    expect(memberIds(state)).not.toContain(MAC);
    // A phone alone founds nothing.
    const phone = build({ kind: 'phone', roster: EMPTY_ROSTER, paired: [row(MAC)] });
    phone.group.addSelf();
    expect(phone.state()).toEqual(EMPTY_ROSTER);
  });

  it('a device that keeps no roster is described by the primary from its hello', () => {
    const g = build({ roster: doc(SELF_KEY, [[PHONE, { kind: 'phone', links: false }]]), paired: [row(PHONE, 'phone')] });
    g.group.onPeerHello(PHONE, fakeChannel(false).channel, hello({ name: 'renamed', os: 'ios', capabilities: [] }));
    expect(rosterMembers(g.state()).find((m) => m.id === PHONE)).toMatchObject({ name: 'renamed', os: 'ios', links: false });
  });
});
