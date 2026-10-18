import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GroupMember, MUTUAL_RETRY_MS, type GroupChannel, type GroupHost, type GroupRelay, type PairedDevice,
} from '../src/remote/group.js';
import type { GroupMessage } from '../src/remote/messages.js';
import { isLive, removeMember, rosterDigest, type RosterEntry } from '../src/remote/roster.js';

const SELF = 'S'.repeat(43);
const MAC = 'M'.repeat(43);
const PHONE = 'P'.repeat(43);
const NOW = 1_000;

const entry = (id: string, over: Partial<RosterEntry> = {}): RosterEntry => ({
  id, kind: 'desktop', name: id.slice(0, 4), os: 'macos', links: true, epoch: 1, addedBy: SELF, addedAt: 1, describedAt: 1,
  ...over,
});

type Answer = { status: number; body: unknown; unsupported?: boolean };

/** A relay connection that records what is posted and answers from `answers`. */
function fakeRelay(answers: Record<string, Answer> = {}) {
  const posts: { path: string; payload: unknown }[] = [];
  const relay: GroupRelay & { status: string } = {
    status: 'online',
    async post<T>(path: string, _action: string, payload: unknown) {
      posts.push({ path, payload });
      return (answers[path] ?? { status: 200, body: {} }) as { status: number; body: T };
    },
  };
  return { relay, posts, answers };
}

function fakeChannel(groups = true) {
  const sent: GroupMessage[] = [];
  const channel: GroupChannel = { groups, sendGroup: (msg) => { sent.push(msg); return true; } };
  return { channel, sent };
}

function build(opts: {
  roster?: RosterEntry[]; paired?: PairedDevice[]; relay?: ReturnType<typeof fakeRelay>; kind?: string;
} = {}) {
  let roster = opts.roster ?? [entry(SELF)];
  const paired = new Map((opts.paired ?? []).map((d) => [d.id, d]));
  const pending = new Set<string>();
  let relay: GroupRelay | null = (opts.relay ?? fakeRelay()).relay;
  const channels = new Map<string, GroupChannel>();
  const forgotten: string[] = [];
  const opened: string[] = [];
  const host: GroupHost = {
    selfId: () => SELF,
    about: () => ({ kind: opts.kind ?? 'desktop', name: 'self', os: 'macos', links: true }),
    knownId: () => SELF,
    relay: () => relay,
    channels: () => channels,
    channel: (id) => channels.get(id) ?? null,
    open: (id) => { opened.push(id); },
    paired: () => {},
    forget: (id) => { forgotten.push(id); channels.delete(id); },
    forgetAll: () => { forgotten.push('*'); channels.clear(); },
    changed: () => {},
    now: () => NOW,
    log: () => {},
  };
  const group = new GroupMember({
    roster: {
      list: () => roster,
      entry: (id) => roster.find((e) => e.id === id) ?? null,
      replace: (next) => {
        if (rosterDigest(next) === rosterDigest(roster)) return false;
        roster = [...next].sort((a, b) => (a.id < b.id ? -1 : 1));
        return true;
      },
      digest: () => rosterDigest(roster),
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
    group, channels, forgotten, opened, pending, paired,
    roster: () => roster,
    setRelay: (r: GroupRelay | null) => { relay = r; },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const mutualAsks = (posts: { path: string }[]) => posts.filter((p) => p.path === '/pair/mutual').length;

afterEach(() => { vi.useRealTimers(); });

describe('GroupMember linking', () => {
  it('asks the relay for a mutual pair with a new live member that links, once per relay connection', async () => {
    const r = fakeRelay();
    const g = build({ relay: r });
    g.group.setRoster([entry(SELF), entry(MAC)]);
    await flush();
    expect(r.posts).toEqual([{ path: '/pair/mutual', payload: { peer: MAC } }]);
    // Another roster change on the same connection does not ask again.
    g.group.setRoster([entry(SELF, { name: 'renamed', describedAt: 2 }), entry(MAC)]);
    await flush();
    expect(mutualAsks(r.posts)).toBe(1);
    // A new connection asks again.
    g.group.relayOk();
    await flush();
    expect(mutualAsks(r.posts)).toBe(2);
  });

  it('a relay without /pair/mutual (404) leaves the member to pair by hand until the next relay ok', async () => {
    const r = fakeRelay({ '/pair/mutual': { status: 404, body: {} } });
    const g = build({ relay: r });
    g.group.setRoster([entry(SELF), entry(MAC)]);
    await flush();
    expect(g.group.members(new Set()).find((m) => m.id === MAC)).toMatchObject({ pairByHand: true, state: 'notLinked' });
    r.answers['/pair/mutual'] = { status: 200, body: {} };
    g.group.relayOk();
    expect(g.group.members(new Set()).find((m) => m.id === MAC)).toMatchObject({ pairByHand: false, state: 'linking' });
  });

  it('a relay that never answers this device on /pair/mutual (unsupported) is read as one without it', async () => {
    const r = fakeRelay({ '/pair/mutual': { status: 0, body: { error: 'network' }, unsupported: true } });
    const g = build({ relay: r });
    g.group.setRoster([entry(SELF), entry(MAC)]);
    await flush();
    expect(g.group.members(new Set()).find((m) => m.id === MAC)).toMatchObject({ pairByHand: true, state: 'notLinked' });
    // A plain network failure is asked again instead.
    r.answers['/pair/mutual'] = { status: 0, body: { error: 'network' } };
    g.group.relayOk();
    await flush();
    expect(g.group.members(new Set()).find((m) => m.id === MAC)).toMatchObject({ pairByHand: false, state: 'linking' });
  });

  it('a rate-limited ask (429) is asked again after MUTUAL_RETRY_MS', async () => {
    vi.useFakeTimers();
    const r = fakeRelay({ '/pair/mutual': { status: 429, body: {} } });
    const g = build({ relay: r });
    g.group.setRoster([entry(SELF), entry(MAC)]);
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
    const g = build({ relay: r });
    g.group.setRoster([entry(SELF), entry(MAC)]);
    await vi.advanceTimersByTimeAsync(0);
    g.group.stop();
    await vi.advanceTimersByTimeAsync(MUTUAL_RETRY_MS * 2);
    expect(mutualAsks(r.posts)).toBe(1);
  });

  it('an answer from an earlier relay connection is ignored', async () => {
    const r = fakeRelay({ '/pair/mutual': { status: 404, body: {} } });
    const g = build({ relay: r });
    g.group.setRoster([entry(SELF), entry(MAC)]);
    g.setRelay(fakeRelay().relay);
    await flush();
    expect(g.group.members(new Set()).find((m) => m.id === MAC)?.pairByHand).toBe(false);
  });

  it('linked for a live member that links pairs it and opens its channel', () => {
    const g = build({ roster: [entry(SELF), entry(MAC)] });
    g.group.relayLinked(MAC);
    expect(g.paired.get(MAC)).toMatchObject({ id: MAC, kind: 'desktop', pairedAt: NOW });
    expect(g.opened).toEqual([MAC]);
  });

  it('linked for a removed member revokes the pair; for a phone it is ignored', async () => {
    const r = fakeRelay();
    const g = build({
      roster: [entry(SELF), entry(MAC, { removedBy: SELF, removedAt: 5 }), entry(PHONE, { kind: 'phone', links: false })],
      relay: r,
    });
    g.group.relayLinked(MAC);
    g.group.relayLinked(PHONE);
    await flush();
    expect(r.posts).toEqual([{ path: '/pair/revoke', payload: { phone: MAC } }]);
    expect(g.paired.size).toBe(0);
  });

  it('a phone never asks another phone of its group for a mutual pair, and reads it as paired elsewhere', async () => {
    const OTHER = 'O'.repeat(43);
    const r = fakeRelay();
    const g = build({ kind: 'phone', relay: r });
    g.group.setRoster([
      entry(SELF, { kind: 'phone' }), entry(MAC), entry(OTHER, { kind: 'phone', addedBy: MAC }),
    ]);
    g.group.relayOk();
    await flush();
    expect(r.posts.filter((p) => p.path === '/pair/mutual').map((p) => p.payload)).toEqual([{ peer: MAC }, { peer: MAC }]);
    const other = g.group.members(new Set([OTHER])).find((m) => m.id === OTHER);
    expect(other).toMatchObject({ links: true, linked: false, state: 'online' });
  });

  it('linked for another phone, on a phone, revokes the pair and drops a row kept for it', async () => {
    const OTHER = 'O'.repeat(43);
    const r = fakeRelay();
    const g = build({
      kind: 'phone', relay: r,
      roster: [entry(SELF, { kind: 'phone' }), entry(MAC), entry(OTHER, { kind: 'phone' })],
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
    const g = build({ relay: r });
    g.group.setRoster([entry(SELF), entry(PHONE, { kind: 'phone' })]);
    await flush();
    expect(r.posts).toEqual([{ path: '/pair/mutual', payload: { peer: PHONE } }]);
    g.group.relayLinked(PHONE);
    expect(g.opened).toEqual([PHONE]);
  });
});

describe('GroupMember removal', () => {
  const macRow: PairedDevice = { id: MAC, name: 'Mac', platform: 'macos', kind: 'desktop', pairedAt: 1, lastSeenAt: null };

  it('removing a member drops it here, tells it, and revokes the pair at the relay', async () => {
    const r = fakeRelay();
    const g = build({ roster: [entry(SELF), entry(MAC)], paired: [macRow], relay: r });
    const { channel, sent } = fakeChannel();
    g.channels.set(MAC, channel);
    expect(await g.group.remove(MAC)).toEqual({ ok: true });
    expect(sent).toContainEqual({ t: 'removed' });
    expect(g.forgotten).toEqual([MAC]);
    expect(g.paired.has(MAC)).toBe(false);
    expect(isLive(g.roster().find((e) => e.id === MAC)!)).toBe(false);
    expect(r.posts).toContainEqual({ path: '/pair/revoke', payload: { phone: MAC } });
    expect(g.pending.size).toBe(0);
  });

  it('a revoke made while the relay is offline stays pending and is posted at the next relay ok', async () => {
    const r = fakeRelay();
    r.relay.status = 'connecting';
    const g = build({ roster: [entry(SELF), entry(MAC)], paired: [macRow], relay: r });
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
    const g = build({ roster: [entry(SELF), entry(MAC)], paired: [macRow], relay: r });
    await g.group.remove(MAC);
    expect([...g.pending]).toEqual([MAC]);
  });

  it('this device removed by another member leaves: a group of one at its next epoch', async () => {
    const r = fakeRelay();
    const phoneRow: PairedDevice = { id: PHONE, name: 'Phone', platform: 'ios', kind: 'phone', pairedAt: 1, lastSeenAt: null };
    const g = build({
      roster: [entry(SELF), entry(MAC), entry(PHONE, { kind: 'phone', links: false })],
      paired: [macRow, phoneRow], relay: r,
    });
    const mac = fakeChannel();
    g.channels.set(MAC, mac.channel);
    g.group.onGroup(MAC, mac.channel, { t: 'removed' });
    await flush();
    // The others hear the roster that says this device and its phone are gone.
    const told = mac.sent.find((m) => m.t === 'roster');
    expect(told && told.t === 'roster' && told.entries.filter((e) => !isLive(e)).map((e) => e.id).sort()).toEqual([PHONE, SELF].sort());
    expect(g.forgotten).toEqual(['*']);
    expect(g.paired.size).toBe(0);
    expect(r.posts.filter((p) => p.path === '/pair/revoke').map((p) => (p.payload as { phone: string }).phone).sort())
      .toEqual([MAC, PHONE].sort());
    expect(g.roster()).toHaveLength(1);
    expect(g.roster()[0]).toMatchObject({ id: SELF, epoch: 2 });
    expect(isLive(g.roster()[0])).toBe(true);
  });

  it('leaving is refused while the relay is offline', async () => {
    const r = fakeRelay();
    r.relay.status = 'connecting';
    const g = build({ roster: [entry(SELF), entry(MAC)], relay: r });
    expect(await g.group.remove(SELF)).toEqual({ error: 'offline' });
    expect(isLive(g.roster().find((e) => e.id === SELF)!)).toBe(true);
  });

  it('a removal merged from another member drops a paired member', () => {
    const g = build({ roster: [entry(SELF), entry(MAC)], paired: [macRow] });
    const peer = fakeChannel();
    g.group.onGroup(PHONE, peer.channel, { t: 'roster', entries: removeMember(g.roster(), MAC, PHONE, 5) });
    expect(g.paired.has(MAC)).toBe(false);
    expect(g.forgotten).toEqual([MAC]);
  });
});

describe('GroupMember merging a roster', () => {
  const OTHER = 'O'.repeat(43);
  const macRow: PairedDevice = { id: MAC, name: 'Mac', platform: 'macos', kind: 'desktop', pairedAt: 1, lastSeenAt: null };

  it('a removed device cannot re-add itself at the next epoch through a member that has not heard of its removal', () => {
    const g = build({ roster: [entry(SELF), entry(MAC, { addedBy: OTHER }), entry(OTHER)], paired: [macRow] });
    const mac = fakeChannel();
    g.channels.set(MAC, mac.channel);
    const removal = removeMember(g.roster(), MAC, OTHER, 5);
    // The removed device sends its own entry, live, one epoch up.
    g.group.onGroup(MAC, mac.channel, { t: 'roster', entries: [entry(MAC, { epoch: 2, addedBy: OTHER, describedAt: 9 })] });
    expect(g.roster().find((e) => e.id === MAC)).toMatchObject({ epoch: 1 });
    // The removal arrives and holds.
    const other = fakeChannel();
    g.group.onGroup(OTHER, other.channel, { t: 'roster', entries: removal });
    expect(isLive(g.roster().find((e) => e.id === MAC)!)).toBe(false);
  });

  it('a device removed here is not taken back at a higher epoch it added itself, from any member', () => {
    const g = build({ roster: [entry(SELF), entry(MAC, { removedBy: SELF, removedAt: 3 }), entry(OTHER)] });
    const other = fakeChannel();
    g.group.onGroup(OTHER, other.channel, { t: 'roster', entries: [entry(OTHER), entry(MAC, { epoch: 2, addedBy: MAC, describedAt: 9 })] });
    const mac = g.roster().find((e) => e.id === MAC)!;
    expect(mac.epoch).toBe(1);
    expect(isLive(mac)).toBe(false);
  });

  it('a re-add by a ceremony on another member spreads through a third member', () => {
    const third = build({ roster: [entry(SELF), entry(MAC, { removedBy: SELF, removedAt: 3 }), entry(OTHER)] });
    const readded = entry(MAC, { epoch: 2, addedBy: OTHER, addedAt: 8, describedAt: 9 });
    const other = fakeChannel();
    third.group.onGroup(OTHER, other.channel, { t: 'roster', entries: [entry(OTHER), readded] });
    expect(third.roster().find((e) => e.id === MAC)).toEqual(readded);
    // And from there, to a member that heard of it through this one.
    const fourth = build({ roster: [entry(SELF), entry(MAC, { removedBy: SELF, removedAt: 3 })] });
    fourth.group.onGroup(OTHER, fakeChannel().channel, { t: 'roster', entries: third.roster() });
    expect(fourth.roster().find((e) => e.id === MAC)).toEqual(readded);
  });

  it('two members that keep a different entry for the sender do not trade rosters forever', () => {
    const g = build({ roster: [entry(SELF), entry(MAC)] });
    const mac = fakeChannel();
    // The sender's own entry one epoch up is not taken; this side has nothing the sender would take.
    g.group.onGroup(MAC, mac.channel, { t: 'roster', entries: [entry(SELF), entry(MAC, { epoch: 2 })] });
    expect(mac.sent.filter((m) => m.t === 'roster')).toEqual([]);
  });
});

describe('GroupMember members', () => {
  it('reads each member as Settings shows it', async () => {
    const r = fakeRelay({ '/pair/mutual': { status: 404, body: {} } });
    const other = 'O'.repeat(43);
    const g = build({
      roster: [
        entry(SELF), entry(MAC), entry(PHONE, { kind: 'phone', links: false }), entry(other),
        entry('R'.repeat(43), { removedBy: SELF, removedAt: 3 }),
      ],
      paired: [{ id: MAC, name: 'Mac', platform: 'macos', kind: 'desktop', pairedAt: 1, lastSeenAt: 7 }],
      relay: r,
    });
    g.group.link();
    await flush();
    const states = Object.fromEntries(g.group.members(new Set([PHONE])).map((m) => [m.id, [m.state, m.linked, m.seenAt]]));
    expect(states).toEqual({
      [SELF]: ['self', false, null],
      [MAC]: ['offline', true, 7],
      [PHONE]: ['online', false, null],
      [other]: ['notLinked', false, null],
    });
    expect(g.group.inGroup()).toBe(true);
  });

  it('a device with only its phones paired here is not in a group', () => {
    const g = build({
      roster: [entry(SELF), entry(PHONE, { kind: 'phone', links: false })],
      paired: [{ id: PHONE, name: 'Phone', platform: 'ios', kind: 'phone', pairedAt: 1, lastSeenAt: null }],
    });
    expect(g.group.inGroup()).toBe(false);
  });
});

describe('GroupMember joining', () => {
  const OTHER = 'O'.repeat(43);

  it("the joiner's entry for the device it joined loses to that device's own, hello or not", () => {
    const g = build();
    g.group.addPaired({ id: MAC, kind: 'desktop', name: 'studio', os: '' }, true);
    const { channel } = fakeChannel();
    // Its hello arrives before its roster: the placeholder stays one.
    g.group.onPeerHello(MAC, channel, {
      t: 'hello', protocol: 1, app: 'orbital', server: '1', name: 'studio', os: 'macos', capabilities: ['group'],
    });
    // The joined device was added by another member, before the joiner heard of it.
    const real = entry(MAC, { name: 'studio', addedBy: OTHER, addedAt: 50, describedAt: 60 });
    g.group.onGroup(MAC, channel, { t: 'roster', entries: [entry(OTHER, { addedBy: OTHER }), real] });
    expect(g.roster().find((e) => e.id === MAC)).toEqual(real);
  });

  it("the joined device's own entry replaces the placeholder at whatever epoch it holds", () => {
    const g = build();
    g.group.addPaired({ id: MAC, kind: 'desktop', name: 'studio', os: '' }, true);
    const real = entry(MAC, { epoch: 3, addedBy: MAC, describedAt: 60 });
    g.group.onGroup(MAC, fakeChannel().channel, { t: 'roster', entries: [real] });
    expect(g.roster().find((e) => e.id === MAC)).toEqual(real);
  });

  it('the adder writes the newcomer as added by itself, as before', () => {
    const g = build();
    g.group.addPaired({ id: PHONE, kind: 'phone', name: 'Pixel', os: 'android' });
    expect(g.roster().find((e) => e.id === PHONE)).toMatchObject({ addedBy: SELF, describedAt: NOW });
  });
});
