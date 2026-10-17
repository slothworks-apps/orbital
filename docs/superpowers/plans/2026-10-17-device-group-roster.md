---
id: 2026-10-17-device-group-roster
title: Device group, part 2a — the roster, mutual pairing and removal (no UI)
status: active
type: plan
domain: remote
related:
  - 2026-10-16-device-group-design
  - joining-one-member-joins-the-group
  - the-relay-pairs-two-devices-that-both-sign
  - 2026-10-16-device-channel
tags:
  - remote
  - relay
  - server
---
# Device group roster implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Macs and servers form a group: a device paired with one member is introduced to every other member and linked with it through the relay without another ceremony, and a device removed on any member is removed everywhere.

**Architecture:** A pure, convergent roster (`shared/src/remote/roster.ts`) that every server keeps in SQLite and syncs over its channels (`roster_digest`, `roster`). The relay gets one new signed route, `POST /pair/mutual`, that creates a pair once both devices have signed for it, and tells both with a new `linked` control. `RemoteService` writes newcomers into the roster at pairing, asks the relay to link every live member it has no pair with, and applies removals by revoking its own pair with the removed device. The phone stays a one-to-one member in this part (it names no `group` capability); the UI is part 2b.

**Tech Stack:** TypeScript, zod 4, vitest, Fastify, drizzle (server SQLite), Kysely (relay SQLite/Postgres), `@noble/hashes`.

**Spec:** `docs/superpowers/specs/2026-10-16-device-group-design.md` (§ 2, § 3, § 4; sub-project 2 of § 14, without its UI). Built on part 1: `docs/superpowers/plans/2026-10-16-device-channel.md`, `docs/domains/device-channel.md`.

## Global Constraints

- The relay stays blind: it learns only that two keys want a pair. No roster, name or kind reaches it.
- `POST /pair/mutual` is signed like every pairing route (`signRequest`, action `'pair.mutual'`), rate-limited by the same limiter, and checks the relay secret. A pair forms only when both devices have signed a half naming each other.
- A relay half waits at most `MUTUAL_PAIR_TTL_MS` (7 days).
- Shipped devices are untouched: the relay sends `linked` only to a device that signed `/pair/mutual`; group messages travel only on a channel whose peer named the `group` capability in its hello; the phone names no `group` capability in this part.
- Roster merge is deterministic and commutative: per id the winner is the higher `epoch`, then a removed entry over a live one, then the later `describedAt`, then the larger canonical JSON. The winner is taken whole, never field by field.
- A device is added again after removal only by a new pairing ceremony, which writes the next epoch.
- Removal by any member: every member revokes its own relay pair with the removed device and closes its channel with `bye revoked`; the removed device, once it learns, revokes all its pairs and becomes a group of one at the next epoch of its own entry.
- `PROTOCOL_VERSION` stays 1. `MIN_RELAY_VERSION` does not change: a relay without `/pair/mutual` answers 404 and the member is listed as `pairByHand`.
- Comments refer to constants by name, never restate their values. Commit messages carry no attribution trailer.
- Typecheck with the npm scripts (`npm run typecheck -w shared|server|relay|web`). Run the server suite with the session's `ORBITAL_*` variables unset.
- Relay changelog gets one line under `## [Unreleased]`; no version bump in this plan (asked at the end of part 2).

## Review Focus

1. **A stale member comes back online after a removal it missed** — it must not bring the removed device back, and must itself drop its pair with it. Pinned in Task 1 (`stale member`) and Task 7 (`offline member catches up`).
2. **Two members introduce the same newcomer at once, or a newcomer joins a group while already in one** — rosters converge to one, digests match. Pinned in Task 1 (`converges`).
3. **The relay is asked for a mutual pair by a device the other side never names** — no pair forms, the half expires. Pinned in Task 3 (`one half`).
4. **A member removes itself (leave) or is removed while its channel to the remover is the only one** — it learns before the channel closes. Pinned in Task 7 (`removed device learns`).
5. **A phone in the roster** — listed, never asked to link, never sent group messages. Pinned in Task 6 (`phone is listed, not linked`).

---

## File structure

| file | responsibility |
|---|---|
| `shared/src/remote/roster.ts` (new) | roster entries, merge, digest, add/remove/describe helpers — pure |
| `shared/src/remote/messages.ts` | `GroupMessage` (`roster_digest`, `roster`, `removed`); `parseChannelMessage` gains kind `'group'` |
| `shared/src/remote/device.ts` | capability `'group'` for desktop and headless |
| `shared/src/remote/relayApi.ts` | action `'pair.mutual'`, control `linked`, `MUTUAL_PAIR_TTL_MS` |
| `shared/src/remote/channel.ts` | `sendGroup(msg)`, event `{ type: 'group', msg }` |
| `relay/migrations/0003_mutual_halves.ts` (new), `relay/src/db.ts`, `relay/src/store.ts`, `relay/src/pairing.ts` | the mutual half table, store methods, the route; revoke in either order |
| `server/src/db/schema.ts`, `server/drizzle/0029_*.sql`, `server/src/remote/rosterStore.ts` (new) | the roster table and its store |
| `server/src/remote/service.ts` | roster at pairing, sync over channels, linking, removal, leave |
| `server/src/api/remoteRoutes.ts` | `DELETE /api/remote/devices/:id` removes from the group; `POST /api/remote/leave` |

---

### Task 1: The roster, pure

**Files:**
- Create: `shared/src/remote/roster.ts`
- Test: `shared/test/roster.test.ts`

**Interfaces:**
- Produces:
  - `type RosterEntry = { id: string; kind: string; name: string; os: string; links: boolean; epoch: number; addedBy: string; addedAt: number; describedAt: number; removedBy?: string; removedAt?: number }`
  - `RosterEntrySchema` (zod), `RosterSchema = z.array(RosterEntrySchema).max(ROSTER_MAX_ENTRIES)`; `ROSTER_MAX_ENTRIES = 256`
  - `isLive(e: RosterEntry): boolean`
  - `winner(a: RosterEntry, b: RosterEntry): RosterEntry`
  - `mergeRosters(a: RosterEntry[], b: RosterEntry[]): RosterEntry[]` (sorted by id)
  - `rosterDigest(entries: RosterEntry[]): string` (hex sha256 of the canonical form)
  - `addMember(roster, entry: Omit<RosterEntry, 'epoch' | 'removedBy' | 'removedAt'>): RosterEntry[]` — next epoch after any known entry for that id
  - `removeMember(roster, id, by, now): RosterEntry[]` — same epoch, `removedBy`/`removedAt` set; unchanged when unknown or already removed
  - `describeMember(roster, id, patch: Partial<Pick<RosterEntry, 'name' | 'os' | 'links' | 'kind'>>, now): RosterEntry[]` — unchanged roster when the patch changes nothing; otherwise `describedAt = now`

- [ ] **Step 1: Write the failing test**

```ts
// shared/test/roster.test.ts
import { describe, expect, it } from 'vitest';
import {
  addMember, describeMember, isLive, mergeRosters, removeMember, rosterDigest, type RosterEntry,
} from '../src/remote/roster.js';

const base = { kind: 'desktop', name: 'studio', os: 'macos', links: true, addedBy: 'A', addedAt: 1, describedAt: 1 };
const entry = (id: string, over: Partial<RosterEntry> = {}): RosterEntry => ({ ...base, id, epoch: 1, ...over });

describe('mergeRosters', () => {
  it('keeps every id from both sides, sorted', () => {
    expect(mergeRosters([entry('B')], [entry('A')]).map((e) => e.id)).toEqual(['A', 'B']);
  });

  it('a higher epoch wins, a removal wins within an epoch', () => {
    const removed = removeMember([entry('X')], 'X', 'A', 5);
    expect(isLive(mergeRosters([entry('X')], removed)[0])).toBe(false);
    const readded = addMember(removed, { ...base, id: 'X', addedBy: 'B', addedAt: 9, describedAt: 9 });
    expect(readded[0].epoch).toBe(2);
    expect(isLive(mergeRosters(removed, readded)[0])).toBe(true);
  });

  it('stale member: an old live entry never brings a removed device back', () => {
    const stale = [entry('X', { describedAt: 999 })];
    const current = removeMember([entry('X')], 'X', 'A', 5);
    expect(isLive(mergeRosters(stale, current)[0])).toBe(false);
    expect(isLive(mergeRosters(current, stale)[0])).toBe(false);
  });

  it('converges: merge is commutative and the digests agree', () => {
    const a = [entry('A'), entry('N', { addedBy: 'A', addedAt: 5, describedAt: 5 })];
    const b = [entry('B'), entry('N', { addedBy: 'B', addedAt: 6, describedAt: 5 })];
    const ab = mergeRosters(a, b);
    const ba = mergeRosters(b, a);
    expect(ab).toEqual(ba);
    expect(rosterDigest(ab)).toBe(rosterDigest(ba));
  });

  it('the later description wins within one epoch', () => {
    const renamed = describeMember([entry('A')], 'A', { name: 'home' }, 50);
    expect(mergeRosters([entry('A')], renamed)[0].name).toBe('home');
  });
});

describe('describeMember', () => {
  it('leaves the roster as it is when nothing changes', () => {
    const roster = [entry('A')];
    expect(describeMember(roster, 'A', { name: 'studio' }, 50)).toBe(roster);
  });
});

describe('rosterDigest', () => {
  it('changes with any field, not with key order', () => {
    const one = entry('A');
    const reordered = Object.fromEntries(Object.entries(one).reverse()) as RosterEntry;
    expect(rosterDigest([one])).toBe(rosterDigest([reordered]));
    expect(rosterDigest([one])).not.toBe(rosterDigest([entry('A', { links: false })]));
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npm test -w shared -- roster`
Expected: FAIL, cannot resolve `../src/remote/roster.js`.

- [ ] **Step 3: Implement**

```ts
// shared/src/remote/roster.ts
/**
 * The group's roster (spec 2026-10-16-device-group-design § 2): every member
 * keeps all of it and they converge on it by merging. The merge picks one
 * whole entry per id, by an order every member computes the same way, so two
 * members that saw the same entries hold the same roster and the same digest.
 * No I/O: the server stores it, the channel carries it.
 */
import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** The most members a roster carries; one channel frame holds them with room to spare. */
export const ROSTER_MAX_ENTRIES = 256;

export const RosterEntrySchema = z.object({
  id: z.string().max(64),
  kind: z.string().max(20),
  name: z.string().max(80),
  os: z.string().max(20),
  /** The device links with other members: its hello named the `group` capability. */
  links: z.boolean(),
  epoch: z.number().int().nonnegative(),
  addedBy: z.string().max(64),
  addedAt: z.number(),
  describedAt: z.number(),
  removedBy: z.string().max(64).optional(),
  removedAt: z.number().optional(),
});
export type RosterEntry = z.infer<typeof RosterEntrySchema>;
export const RosterSchema = z.array(RosterEntrySchema).max(ROSTER_MAX_ENTRIES);

export function isLive(e: RosterEntry): boolean {
  return e.removedAt === undefined;
}

/** The keys in a fixed order, so the same entry always reads the same. */
function canonical(e: RosterEntry): string {
  return JSON.stringify([
    e.id, e.kind, e.name, e.os, e.links, e.epoch, e.addedBy, e.addedAt, e.describedAt,
    e.removedBy ?? null, e.removedAt ?? null,
  ]);
}

/** The entry that stands for an id: higher epoch, then removed, then later described, then the larger canonical form. */
export function winner(a: RosterEntry, b: RosterEntry): RosterEntry {
  if (a.epoch !== b.epoch) return a.epoch > b.epoch ? a : b;
  if (isLive(a) !== isLive(b)) return isLive(a) ? b : a;
  if (a.describedAt !== b.describedAt) return a.describedAt > b.describedAt ? a : b;
  return canonical(a) >= canonical(b) ? a : b;
}

export function mergeRosters(a: RosterEntry[], b: RosterEntry[]): RosterEntry[] {
  const byId = new Map<string, RosterEntry>();
  for (const e of [...a, ...b]) {
    const known = byId.get(e.id);
    byId.set(e.id, known ? winner(known, e) : e);
  }
  return [...byId.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

export function rosterDigest(entries: RosterEntry[]): string {
  const sorted = [...entries].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return bytesToHex(sha256(new TextEncoder().encode(sorted.map(canonical).join('\n'))));
}

/** A newcomer, or a removed device paired again: the next epoch after any entry known for it. */
export function addMember(
  roster: RosterEntry[], entry: Omit<RosterEntry, 'epoch' | 'removedBy' | 'removedAt'>,
): RosterEntry[] {
  const known = roster.find((e) => e.id === entry.id);
  const epoch = known ? known.epoch + 1 : 1;
  return mergeRosters(roster.filter((e) => e.id !== entry.id), [{ ...entry, epoch }]);
}

/** Marks a live member removed, at its current epoch; unchanged when unknown or already removed. */
export function removeMember(roster: RosterEntry[], id: string, by: string, now: number): RosterEntry[] {
  const known = roster.find((e) => e.id === id);
  if (!known || !isLive(known)) return roster;
  return roster.map((e) => (e.id === id ? { ...e, removedBy: by, removedAt: now } : e));
}

/** What a member says about a device; the same array back when nothing changes, so callers can tell. */
export function describeMember(
  roster: RosterEntry[], id: string, patch: Partial<Pick<RosterEntry, 'name' | 'os' | 'links' | 'kind'>>, now: number,
): RosterEntry[] {
  const known = roster.find((e) => e.id === id);
  if (!known) return roster;
  const changed = (Object.keys(patch) as (keyof typeof patch)[]).some((k) => patch[k] !== undefined && patch[k] !== known[k]);
  if (!changed) return roster;
  return roster.map((e) => (e.id === id ? { ...e, ...patch, describedAt: now } : e));
}
```

Check that `@noble/hashes/utils.js` exports `bytesToHex` in the installed version (`node -e "import('@noble/hashes/utils.js').then(m=>console.log(typeof m.bytesToHex))"` from `shared/`); if it does not, write the hex by hand.

- [ ] **Step 4: Run the test**

Run: `npm test -w shared -- roster && npm run typecheck -w shared`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/src/remote/roster.ts shared/test/roster.test.ts
git commit -m "Group roster: entries, a convergent merge and a digest"
```

---

### Task 2: Group messages in the channel, `linked` and `pair.mutual` in the relay protocol

**Files:**
- Modify: `shared/src/remote/messages.ts`, `shared/src/remote/device.ts`, `shared/src/remote/relayApi.ts`, `shared/src/remote/channel.ts`
- Test: `shared/test/messages.test.ts`, `shared/test/device.test.ts`, `shared/test/channel.test.ts`, `shared/test/relayApi.test.ts`

**Interfaces:**
- Consumes: `RosterSchema` (Task 1).
- Produces:
  - `GroupMessage` (zod) = `{ t: 'roster_digest'; digest: string }` | `{ t: 'roster'; entries: RosterEntry[] }` | `{ t: 'removed' }`; `ChannelMessage` gains `{ kind: 'group'; msg: GroupMessage }`, and `parseChannelMessage` tries `GroupMessage` after `AnswerMessage`.
  - `Capability` gains `'group'`; `capabilitiesOf('desktop')` and `capabilitiesOf('headless')` include it; the phone's stays `[]`.
  - `RelayAction` gains `'pair.mutual'`; `RelayToDevice` gains `{ type: 'linked'; peer: string }`; `MUTUAL_PAIR_TTL_MS = 7 * 24 * 60 * 60_000`.
  - `Channel.sendGroup(msg: GroupMessage): boolean` (sends only when ready and the peer's hello named `'group'`; false otherwise); `ChannelEvent` gains `{ type: 'group'; msg: GroupMessage }`, emitted only after the peer's hello; `Channel.groups: boolean` getter (peer named `'group'`).

- [ ] **Step 1: Write the failing tests**

`shared/test/messages.test.ts`:

```ts
it('reads group messages, and refuses a roster over its bound', () => {
  expect(parseChannelMessage({ t: 'roster_digest', digest: 'ab' })?.kind).toBe('group');
  expect(parseChannelMessage({ t: 'removed' })?.kind).toBe('group');
  const one = { id: 'A', kind: 'desktop', name: 'a', os: 'macos', links: true, epoch: 1, addedBy: 'A', addedAt: 1, describedAt: 1 };
  expect(parseChannelMessage({ t: 'roster', entries: [one] })?.kind).toBe('group');
  expect(parseChannelMessage({ t: 'roster', entries: new Array(ROSTER_MAX_ENTRIES + 1).fill(one) })).toBeNull();
});
```

`shared/test/device.test.ts`: `expect(capabilitiesOf('headless')).toEqual(['sessions', 'group'])` (replace the old headless expectation), `expect(capabilitiesOf('desktop')).toContain('group')`, `expect(capabilitiesOf('phone')).toEqual([])`.

`shared/test/relayApi.test.ts`:

```ts
it('reads a linked control', () => {
  expect(RelayToDevice.parse({ type: 'linked', peer: 'x' })).toEqual({ type: 'linked', peer: 'x' });
});
```

`shared/test/channel.test.ts` (reuse the file's `pair()` helper; its `desktop()` hello takes capabilities — pass `['sessions', 'group']` where needed, adding a parameter to the helper if it has none):

```ts
it('carries group messages only between members that name the group capability', () => {
  const { a, b, pump } = pair();            // both hellos with ['sessions', 'group']
  const got: unknown[] = [];
  b.on((e) => { if (e.type === 'group') got.push(e.msg); });
  a.start();
  pump();
  expect(a.groups && b.groups).toBe(true);
  expect(a.sendGroup({ t: 'roster_digest', digest: 'ab' })).toBe(true);
  pump();
  expect(got).toEqual([{ t: 'roster_digest', digest: 'ab' }]);
});

it('does not send group messages to a peer that does not name the capability', () => {
  const { a, pump } = pair({ bHello: { capabilities: ['sessions'] } });
  a.start();
  pump();
  expect(a.groups).toBe(false);
  expect(a.sendGroup({ t: 'removed' })).toBe(false);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npm test -w shared -- messages device relayApi channel`
Expected: FAIL.

- [ ] **Step 3: Implement**

`messages.ts`, after `AnswerMessage`:

```ts
/**
 * The group's own messages (spec 2026-10-16-device-group-design § 2, § 4),
 * sent only to a peer whose hello named the `group` capability: a shipped
 * device never sees one. They change the group, so no route carries them.
 */
export const GroupMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('roster_digest'), digest: z.string().max(128) }),
  z.object({ t: z.literal('roster'), entries: RosterSchema }),
  z.object({ t: z.literal('removed') }),
]);
export type GroupMessage = z.infer<typeof GroupMessage>;
```

Import `RosterSchema` from `./roster.js`. Add `| { kind: 'group'; msg: GroupMessage }` to `ChannelMessage`, and in `parseChannelMessage` after the answer attempt: `const group = GroupMessage.safeParse(value); return group.success ? { kind: 'group', msg: group.data } : null;`.

`device.ts`: `Capability` gains `'group'`; `capabilitiesOf` returns `['sessions', 'group']` for headless and appends `'group'` for desktop. Update the doc comment.

`relayApi.ts`: `RelayAction` gains `'pair.mutual'`; in `RelayToDevice` add, with a comment ("Both devices signed `/pair/mutual` for each other: the pair exists. Sent only to a device that signed one."):

```ts
  z.object({ type: z.literal('linked'), peer: z.string() }),
```

and the constant, with a doc comment ("How long the relay keeps one device's half of a mutual pair waiting for the other's."):

```ts
export const MUTUAL_PAIR_TTL_MS = 7 * 24 * 60 * 60_000;
```

Check every `switch (msg.type)` over `RelayToDevice` in `shared/src/remote/client.ts`, `server/src/remote/relayClient.ts`, `server/src/remote/service.ts` and the relay's tests compiles (an exhaustive switch needs a `case 'linked': return;` — the phone ignores it, the server handles it in Task 6).

`channel.ts`: in `receive`, after the `answer` branch: `if (parsed.kind === 'group') { if (this.peerHello) this.emit({ type: 'group', msg: parsed.msg }); return; }`. Add:

```ts
  /** The peer's hello named the `group` capability: it takes roster messages. */
  get groups(): boolean {
    return this.peerHello?.capabilities?.includes('group') === true;
  }

  /** A roster message to a peer that takes them; false (nothing sent) otherwise. */
  sendGroup(msg: GroupMessage): boolean {
    if (!this.ready || !this.groups) return false;
    return this.sendJson(msg);
  }
```

`sendJson`'s parameter type gains `GroupMessage`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -w shared && npm run typecheck -w shared && npm run typecheck -w server && npm run typecheck -w web && npm run typecheck -w relay`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared server/src relay/test
git commit -m "Group messages in the channel; linked and pair.mutual in the relay protocol"
```

---

### Task 3: The relay pairs two devices that both sign

**Files:**
- Create: `relay/migrations/0003_mutual_halves.ts`
- Modify: `relay/src/db.ts`, `relay/src/store.ts`, `relay/src/pairing.ts`, `relay/CHANGELOG.md`
- Test: `relay/test/pairing.test.ts`, `relay/test/store.test.ts`

**Interfaces:**
- Consumes: `MUTUAL_PAIR_TTL_MS`, action `'pair.mutual'`, control `linked` (Task 2).
- Produces: route `POST /pair/mutual` with payload `{ peer: string }` → 200 `{ linked: boolean }`, 400 `bad_peer` (not a device id, or the signer itself); `RelayStore.offerMutual(from: string, to: string, now: number): Promise<'linked' | 'waiting'>`; `RelayStore.revokePair(a, b)` deletes the pair in either order.

- [ ] **Step 1: Write the failing tests**

In `relay/test/pairing.test.ts`, inside `describe('pairing')` and using its `relay()` helper (add a third identity where needed with `generateIdentity()`):

```ts
it('one half: a device that names another forms no pair on its own', async () => {
  const r = await relay();
  const a = await connectDevice(r.base, r.mac);
  const res = await r.post('/pair/mutual', signRequest(r.mac, 'pair.mutual', { peer: deviceId(r.phone.publicKey) }, r.now()));
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ linked: false });
  expect(await r.store.isPaired(a.id, deviceId(r.phone.publicKey))).toBe(false);
});

it('both halves: the pair forms, both hear linked and presence', async () => {
  const r = await relay();
  const a = await connectDevice(r.base, r.mac);
  const b = await connectDevice(r.base, r.phone);
  await r.post('/pair/mutual', signRequest(r.mac, 'pair.mutual', { peer: b.id }, r.now()));
  const res = await r.post('/pair/mutual', signRequest(r.phone, 'pair.mutual', { peer: a.id }, r.now()));
  expect(res.json()).toEqual({ linked: true });
  expect(await a.next('linked')).toEqual({ type: 'linked', peer: b.id });
  expect(await b.next('linked')).toEqual({ type: 'linked', peer: a.id });
  expect(await a.next('presence')).toEqual({ type: 'presence', peer: b.id, online: true });
  expect(await r.store.isPaired(a.id, b.id)).toBe(true);
});

it('a half older than MUTUAL_PAIR_TTL_MS is gone', async () => {
  const r = await relay();
  const a = deviceId(r.mac.publicKey);
  const b = deviceId(r.phone.publicKey);
  await r.post('/pair/mutual', signRequest(r.mac, 'pair.mutual', { peer: b }, r.now()));
  r.tick(MUTUAL_PAIR_TTL_MS + 1);
  const res = await r.post('/pair/mutual', signRequest(r.phone, 'pair.mutual', { peer: a }, r.now()));
  expect(res.json()).toEqual({ linked: false });
});

it('asking again once paired answers linked and changes nothing', async () => {
  const r = await relay();
  const a = deviceId(r.mac.publicKey);
  const b = deviceId(r.phone.publicKey);
  await r.post('/pair/mutual', signRequest(r.mac, 'pair.mutual', { peer: b }, r.now()));
  await r.post('/pair/mutual', signRequest(r.phone, 'pair.mutual', { peer: a }, r.now()));
  const again = await r.post('/pair/mutual', signRequest(r.mac, 'pair.mutual', { peer: b }, r.now()));
  expect(again.json()).toEqual({ linked: true });
});

it('refuses a peer that is not a device id, or the signer itself', async () => {
  const r = await relay();
  expect((await r.post('/pair/mutual', signRequest(r.mac, 'pair.mutual', { peer: 'nope' }, r.now()))).statusCode).toBe(400);
  expect((await r.post('/pair/mutual', signRequest(r.mac, 'pair.mutual', { peer: deviceId(r.mac.publicKey) }, r.now()))).statusCode).toBe(400);
});

it('either side of a mutual pair may revoke it', async () => {
  const r = await relay();
  const a = deviceId(r.mac.publicKey);
  const b = await connectDevice(r.base, r.phone);
  await r.post('/pair/mutual', signRequest(r.mac, 'pair.mutual', { peer: b.id }, r.now()));
  await r.post('/pair/mutual', signRequest(r.phone, 'pair.mutual', { peer: a }, r.now()));
  const res = await r.post('/pair/revoke', signRequest(r.phone, 'pair.revoke', { phone: a }, r.now()));
  expect(res.statusCode).toBe(200);
  expect(await r.store.isPaired(a, b.id)).toBe(false);
});
```

Import `MUTUAL_PAIR_TTL_MS` from `@orbital/shared/remote/relayApi`. If the file's helpers name the identities differently, keep the meaning (two independent identities).

In `relay/test/store.test.ts`, following the file's pattern for the other store methods: `offerMutual` returns `'waiting'` then `'linked'`, stores the pair with the lower id in the `mac` column, and `revokePair` works with either argument order.

- [ ] **Step 2: Run them and see them fail**

Run: `npm test -w relay -- pairing store`
Expected: FAIL (404 on `/pair/mutual`).

- [ ] **Step 3: Migration**

```ts
// relay/migrations/0003_mutual_halves.ts
import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * One device's half of a mutual pair (spec 2026-10-16-device-group-design
 * § 4): `from` signed that it wants a pair with `to`, until `expires_at`.
 * The pair itself goes into `pairs` once both halves are in.
 */
export const migration: Migration = {
  async up(db: Kysely<any>) {
    await db.schema.createTable('mutual_halves')
      .addColumn('from_id', 'text', (c) => c.notNull())
      .addColumn('to_id', 'text', (c) => c.notNull())
      .addColumn('expires_at', 'bigint', (c) => c.notNull())
      .addPrimaryKeyConstraint('mutual_halves_pk', ['from_id', 'to_id'])
      .execute();
  },
  async down(db: Kysely<any>) {
    await db.schema.dropTable('mutual_halves').execute();
  },
};
```

Check how `0001_initial.ts` types timestamps (`bigint` vs `integer`) and match it. Register it in `relay/src/db.ts` beside `0002_no_names` and add the table to the `Database` interface (`MutualHalvesTable = { from_id: string; to_id: string; expires_at: number }`).

- [ ] **Step 4: Store**

Add to `RelayStore`:

```ts
  /**
   * `from` wants a pair with `to`. `'linked'` once `to` has said the same
   * (the pair is stored, lower id in `mac`) or the two were already paired;
   * `'waiting'` while only this half is in. Expired halves go first.
   */
  offerMutual(from: string, to: string, now: number): Promise<'linked' | 'waiting'>;
```

Implement in `KyselyRelayStore`:

```ts
  async offerMutual(from: string, to: string, now: number): Promise<'linked' | 'waiting'> {
    await this.db.deleteFrom('mutual_halves').where('expires_at', '<', now).execute();
    if (await this.isPaired(from, to)) return 'linked';
    const other = await this.db.selectFrom('mutual_halves').select('to_id')
      .where('from_id', '=', to).where('to_id', '=', from).executeTakeFirst();
    if (!other) {
      await this.db.insertInto('mutual_halves').values({ from_id: from, to_id: to, expires_at: now + MUTUAL_PAIR_TTL_MS })
        .onConflict((oc) => oc.columns(['from_id', 'to_id']).doUpdateSet({ expires_at: now + MUTUAL_PAIR_TTL_MS }))
        .execute();
      return 'waiting';
    }
    const [mac, phone] = from < to ? [from, to] : [to, from];
    await this.db.insertInto('pairs').values({ mac, phone, created_at: now })
      .onConflict((oc) => oc.columns(['mac', 'phone']).doNothing()).execute();
    await this.db.deleteFrom('mutual_halves')
      .where((eb) => eb.or([
        eb.and([eb('from_id', '=', from), eb('to_id', '=', to)]),
        eb.and([eb('from_id', '=', to), eb('to_id', '=', from)]),
      ])).execute();
    return 'linked';
  }
```

`revokePair(a, b)` deletes `(mac = a and phone = b) or (mac = b and phone = a)`; update its interface comment ("either side of the pair may revoke it"). `clearForTests` empties `mutual_halves` too.

- [ ] **Step 5: Route**

In `relay/src/pairing.ts` (schema beside the others, comment in the file's style):

```ts
const MutualPayload = z.object({ peer: z.string() });
```

```ts
  // Two devices of one group pair without a code: each signs that it wants
  // the other, and the pair exists once both have (ADR
  // the-relay-pairs-two-devices-that-both-sign). Neither half says why.
  app.post('/pair/mutual', async (req, reply) => {
    const s = signed(req.body, 'pair.mutual', MutualPayload, req.ip, reply);
    if (!s) return;
    const peer = s.payload.peer;
    if (!publicKeyOf(peer) || peer === s.id) return reply.code(400).send({ error: 'bad_peer' });
    await ctx.store.upsertDevice({ id: s.id, kind: 'mac' });
    const already = await ctx.store.isPaired(s.id, peer);
    const outcome = await ctx.store.offerMutual(s.id, peer, ctx.now());
    if (outcome === 'linked' && !already) {
      ctx.connections.get(s.id)?.peers.add(peer);
      ctx.connections.get(peer)?.peers.add(s.id);
      ctx.connections.pairsChanged();
      for (const [one, other] of [[s.id, peer], [peer, s.id]] as const) {
        ctx.connections.sendControl(one, { type: 'linked', peer: other });
        ctx.connections.sendControl(one, { type: 'presence', peer: other, online: ctx.connections.isOnline(other) });
      }
      log(`mutual pair: ${short(s.id)} and ${short(peer)}`);
    }
    return { linked: outcome === 'linked' };
  });
```

Import `publicKeyOf` from `@orbital/shared/remote/keys`. Update `/pair/revoke`: after `revokePair` succeeds, besides the existing `unpaired` to `s.payload.phone`, nothing else changes (the other side is told as today).

Update the module comment ("The signed endpoints of pairing …").

- [ ] **Step 6: Changelog**

`relay/CHANGELOG.md` under `## [Unreleased]` → `### Added`: "Devices of one Orbital group pair with each other without a code, once both ask for it."

- [ ] **Step 7: Run and commit**

Run: `npm test -w relay && npm run typecheck -w relay`
Expected: PASS.

```bash
git add relay
git commit -m "Relay: a mutual pair forms when both devices sign for it; either side may revoke"
```

---

### Task 4: The server keeps the roster

**Files:**
- Modify: `server/src/db/schema.ts`; create `server/drizzle/0029_group_roster.sql` (+ generated snapshot and journal entry)
- Create: `server/src/remote/rosterStore.ts`
- Test: `server/test/rosterStore.test.ts`, `server/test/database.test.ts`

**Interfaces:**
- Consumes: `RosterEntry`, `mergeRosters`, `addMember`, `removeMember`, `describeMember`, `rosterDigest` (Task 1).
- Produces: table `group_members` (one row per id, the columns of `RosterEntry`); `class RosterStore` with `list(): RosterEntry[]`, `replace(entries: RosterEntry[]): boolean` (true when the stored roster changed), `digest(): string`, `entry(id): RosterEntry | null`.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/rosterStore.test.ts
import { describe, expect, it } from 'vitest';
import { rosterDigest, type RosterEntry } from '@orbital/shared/remote/roster';
import { RosterStore } from '../src/remote/rosterStore.js';
import { openTmpDb } from './tmp.js';

const e = (id: string, over: Partial<RosterEntry> = {}): RosterEntry => ({
  id, kind: 'desktop', name: id, os: 'macos', links: true, epoch: 1, addedBy: 'A', addedAt: 1, describedAt: 1, ...over,
});

describe('RosterStore', () => {
  it('stores and lists a roster, and says whether a replace changed it', () => {
    const store = new RosterStore(openTmpDb());
    expect(store.list()).toEqual([]);
    expect(store.replace([e('B'), e('A', { removedBy: 'B', removedAt: 5 })])).toBe(true);
    expect(store.list()).toEqual([e('A', { removedBy: 'B', removedAt: 5 }), e('B')]);
    expect(store.replace(store.list())).toBe(false);
    expect(store.digest()).toBe(rosterDigest(store.list()));
    expect(store.entry('B')?.name).toBe('B');
  });
});
```

`server/test/database.test.ts`: the existing "migrations on disk" count test covers the new migration; nothing more.

- [ ] **Step 2: Run it and see it fail**

Run: `npm test -w server -- rosterStore`
Expected: FAIL.

- [ ] **Step 3: Schema, migration, store**

`schema.ts`, beside `remoteDevices`:

```ts
/**
 * The group's roster as this device knows it (spec
 * 2026-10-16-device-group-design § 2), linked or not, removed members
 * included: a removal has to outlive the device it removed. `remote_devices`
 * holds only the devices this one has a relay pair with.
 */
export const groupMembers = sqliteTable('group_members', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  os: text('os').notNull(),
  links: integer('links', { mode: 'boolean' }).notNull(),
  epoch: integer('epoch').notNull(),
  addedBy: text('added_by').notNull(),
  addedAt: integer('added_at').notNull(),
  describedAt: integer('described_at').notNull(),
  removedBy: text('removed_by'),
  removedAt: integer('removed_at'),
});
```

Run `npm run db:generate -w server`, name the file `0029_group_roster.sql` and the journal tag `0029_group_roster`.

```ts
// server/src/remote/rosterStore.ts
/**
 * The roster in SQLite. `replace` writes a whole roster at once and says
 * whether anything changed, so the service pushes only real changes.
 */
import { rosterDigest, type RosterEntry } from '@orbital/shared/remote/roster';
import { groupMembers } from '../db/schema.js';
import type { OrbitalDb } from '../db/database.js';

export class RosterStore {
  constructor(private readonly db: OrbitalDb) {}

  list(): RosterEntry[] {
    return this.db.select().from(groupMembers).orderBy(groupMembers.id).all().map(fromRow);
  }

  entry(id: string): RosterEntry | null {
    return this.list().find((e) => e.id === id) ?? null;
  }

  digest(): string {
    return rosterDigest(this.list());
  }

  replace(entries: RosterEntry[]): boolean {
    if (rosterDigest(entries) === this.digest()) return false;
    this.db.transaction((tx) => {
      tx.delete(groupMembers).run();
      for (const e of entries) {
        tx.insert(groupMembers).values({
          ...e, removedBy: e.removedBy ?? null, removedAt: e.removedAt ?? null,
        }).run();
      }
    });
    return true;
  }
}

function fromRow(row: typeof groupMembers.$inferSelect): RosterEntry {
  const { removedBy, removedAt, ...rest } = row;
  return { ...rest, ...(removedBy !== null ? { removedBy } : {}), ...(removedAt !== null ? { removedAt } : {}) };
}
```

Check the drizzle transaction API this repo uses elsewhere (`grep -rn "transaction(" server/src | head`) and follow it.

- [ ] **Step 4: Run and commit**

Run: `npm test -w server -- rosterStore database && npm run typecheck -w server`
Expected: PASS.

```bash
git add server/src/db/schema.ts server/drizzle server/src/remote/rosterStore.ts server/test/rosterStore.test.ts
git commit -m "Server keeps the group roster"
```

---

### Task 5: The roster at pairing and over the channels

**Files:**
- Modify: `server/src/remote/service.ts`
- Test: `server/test/groupRoster.test.ts` (new, unit-level against `RemoteService` with the harness's fakes, or the e2e harness if the unit fakes cannot carry a channel)

**Interfaces:**
- Consumes: `RosterStore` (Task 4); `addMember`, `mergeRosters`, `describeMember` (Task 1); `Channel.sendGroup`, `Channel.groups`, event `group` (Task 2).
- Produces (on `RemoteService`):
  - the self entry: on `start()`, when the roster has no live entry for this device and no removed one, `addMember` it (kind `serverDeviceKind()`, name `macName`, os `osName(process.platform)`, links true, addedBy self); when the name changes (`nameChanged()`), `describeMember` self.
  - at pairing: a successful `confirmPairing` accept adds the new device (`kind` from the request, name, os = its platform, links false, addedBy self); a `paired` for `joining` adds the device joined (kind from the QR, links false).
  - on a channel `hello` from a peer: `describeMember(peer, { name: hello.name ?? hello.macName, os: hello.os, links: channel.groups })` when the hello names them.
  - sync: when a channel becomes ready and `channel.groups`, send `roster_digest`; on `roster_digest` that differs from ours, answer with `roster`; on `roster`, merge into ours (`mergeRosters`), and if the stored roster changed, push `roster_digest` to every other ready group channel.
  - `RemoteStatus.group: { members: (RosterEntry & { self: boolean; linked: boolean; online: boolean })[] }` — `linked`: a row in `remote_devices`; `online`: in the relay's `peersOnline`.
  - a single private `setRoster(next: RosterEntry[], from?: string)` that stores, publishes status and pushes the digest to every ready group channel except `from`; every roster change goes through it.

- [ ] **Step 1: Write the failing test**

Extend `server/test/deviceChannelEndToEnd.test.ts` (it already pairs two servers on one relay with `joined()`):

```ts
it('pairing writes both into one roster, and the rosters converge', async () => {
  const { a, b, idA, idB } = await joined();
  const membersOf = async (s: typeof a) => (await s.api('GET', '/api/remote')).json().group.members;
  await until(async () => {
    const ma = await membersOf(a);
    const mb = await membersOf(b);
    return ma.length === 2 && mb.length === 2 && JSON.stringify(ma.map((m: any) => m.id)) === JSON.stringify(mb.map((m: any) => m.id));
  });
  const ma = await membersOf(a);
  expect(ma.find((m: any) => m.id === idA)).toMatchObject({ self: true, name: 'studio' });
  expect(ma.find((m: any) => m.id === idB)).toMatchObject({ self: false, name: 'laptop', linked: true, links: true });
  expect(a.remote.rosterDigest()).toBe(b.remote.rosterDigest());
});

it('a phone paired with a member is listed, not linked with others', async () => {
  // pair a FakePhone with `a` as remoteEndToEnd does, then:
  // expect a's roster to hold it with kind 'phone', links false
});
```

Add `rosterDigest(): string` on `RemoteService` (returns the store's digest) for tests. Complete the phone test with the FakePhone sequence from `remoteEndToEnd.test.ts` against `a`; assert the entry `{ kind: 'phone', links: false }` and that `b`, after converging, lists it too with `linked: false`.

- [ ] **Step 2: Run it and see it fail**

Run: `npm test -w server -- deviceChannelEndToEnd`
Expected: FAIL (`group` missing in the status).

- [ ] **Step 3: Implement** in `service.ts` as the Interfaces block says. The channel listener in `makeChannel` gains:

```ts
      if (event.type === 'hello') this.onPeerHello(from, opened, event.hello);
      if (event.type === 'ready' && event.ready && opened.groups) opened.sendGroup({ t: 'roster_digest', digest: this.roster.digest() });
      if (event.type === 'group') this.onGroup(from, opened, event.msg);
```

with

```ts
  private onGroup(from: string, channel: Channel, msg: GroupMessage): void {
    if (msg.t === 'roster_digest') {
      if (msg.digest !== this.roster.digest()) channel.sendGroup({ t: 'roster', entries: this.roster.list() });
      return;
    }
    if (msg.t === 'roster') {
      this.setRoster(mergeRosters(this.roster.list(), msg.entries), from);
      // The sender may still lack what only this side knew.
      if (this.roster.digest() !== rosterDigest(msg.entries)) channel.sendGroup({ t: 'roster', entries: this.roster.list() });
      return;
    }
    // `removed` is handled in Task 7.
  }
```

`setRoster` returns early when `RosterStore.replace` reports no change, so two members cannot ping-pong. Construct the `RosterStore` in the constructor beside `DeviceStore`. Self id: `deviceId(this.identity.publicKey)`, available after `start()` loads the identity; the self entry is written right after the identity loads.

- [ ] **Step 4: Run and commit**

Run: `npm test -w server -- deviceChannelEndToEnd remote && npm run typecheck -w server`
Expected: PASS.

```bash
git add server/src/remote/service.ts server/test
git commit -m "The roster is written at pairing and converges over the channels"
```

---

### Task 6: Linking every member with every other

**Files:**
- Modify: `server/src/remote/service.ts`
- Test: `server/test/deviceChannelEndToEnd.test.ts`

**Interfaces:**
- Consumes: control `linked`, route `/pair/mutual` (Tasks 2–3); `setRoster` (Task 5).
- Produces:
  - `private link()`: for every live roster entry with `links` true, not self, without a `remote_devices` row and not asked since the last relay `ok`, post `/pair/mutual` `{ peer: id }` (signed, action `'pair.mutual'`); on `{ linked: true }` treat as `linked`; on 404 mark the id `pairByHand` (in memory, cleared on `ok`); remember the id as asked.
  - `link()` runs after every `setRoster` that changed the roster and on every relay `ok`.
  - on control `linked` `{ peer }` (and on `{ linked: true }` from the post): when the roster has a live entry for `peer`, add a `remote_devices` row from it (`kind`, `name`, `platform` = its `os`, `pairedAt` now, notifications defaults), publish status, and `open(peer)`. A `linked` for an id the roster does not hold live is ignored (and logged).
  - `RemoteStatus.group.members[].pairByHand: boolean`.

- [ ] **Step 1: Write the failing test**

```ts
it('a device paired with one member links with the others without a ceremony', async () => {
  const { a, b, idA, idB } = await joined();                           // A ↔ B
  const c = await startMacAndRelay(closers, { relayUrl: a.relayUrl, name: 'vps' });
  const qr = (await b.api('POST', '/api/remote/pair')).json().qr;     // C joins through B
  const join = await c.api('POST', '/api/remote/join', { code: qr });
  await until(async () => (await b.api('GET', '/api/remote')).json().pendingPair !== null);
  const idC = (await c.api('GET', '/api/remote')).json().macId;
  await b.api('POST', '/api/remote/pair/confirm', { accept: true, phone: idC, code: join.json().code });
  await until(() => a.remote.channel(idC)?.ready === true && c.remote.channel(idA)?.ready === true, 15_000);
  expect((await a.remote.channel(idC)!.request('GET', '/api/health')).status).toBe(200);
  expect((await c.remote.channel(idA)!.request('GET', '/api/health')).status).toBe(200);
  for (const s of [a, b, c]) {
    const members = (await s.api('GET', '/api/remote')).json().group.members;
    expect(members.filter((m: any) => m.linked || m.self)).toHaveLength(3);
  }
  void idB;
}, 30_000);

it('phone is listed, not linked: no mutual pair is asked for it', async () => {
  // pair a FakePhone with `a`; after converging, b's status lists it with linked false, pairByHand false,
  // and the relay holds no pair between b and the phone (relay store not reachable here: assert via
  // b.remote.channel(phoneId) === null after waiting for convergence plus one second)
});
```

Complete the second test with the FakePhone sequence from `remoteEndToEnd.test.ts`.

- [ ] **Step 2: Run it and see it fail**

Run: `npm test -w server -- deviceChannelEndToEnd`
Expected: FAIL (A never gets a channel to C).

- [ ] **Step 3: Implement** as the Interfaces block says. Handle `linked` in `onControl` before `presence`:

```ts
    if (msg.type === 'linked') {
      this.onLinked(msg.peer);
      return;
    }
```

`RelayClient.post` resolves `{ status, body }`; use `client.post<{ linked?: boolean }>('/pair/mutual', 'pair.mutual', { peer: id })`.

- [ ] **Step 4: Run and commit**

Run: `npm test -w server -- deviceChannelEndToEnd remote && npm run typecheck -w server`
Expected: PASS.

```bash
git add server/src/remote/service.ts server/test
git commit -m "Every member links with every other through a mutual pair"
```

---

### Task 7: Removal and leaving

**Files:**
- Modify: `server/src/remote/service.ts`, `server/src/api/remoteRoutes.ts`
- Test: `server/test/deviceChannelEndToEnd.test.ts`, `server/test/remoteRoutes.test.ts`, `server/test/remoteService.test.ts`

**Interfaces:**
- Consumes: `removeMember`, `addMember` (Task 1); `setRoster` (Task 5); `link` (Task 6).
- Produces:
  - `RemoteService.remove(id: string): Promise<boolean>` — replaces `revoke`: `setRoster(removeMember(roster, id, self, now))`; false when the roster has no live entry for `id` and no `remote_devices` row (a phone paired before the roster existed has a row: write its entry first, then remove it).
  - `RemoteService.leave(): Promise<void>` — `remove(self)`.
  - applying the roster (inside `setRoster`, after storing): for every removed entry that still has a `remote_devices` row: send `{ t: 'removed' }` on its channel if it groups, close the channel with `bye revoked`, stop its watcher, delete the row, and post `/pair/revoke` `{ phone: id }`. When this device's own entry is removed: send `removed` to every group channel, close every channel with `bye revoked`, revoke every pair at the relay, delete every `remote_devices` row, and then write the roster as just this device at its next epoch (`addMember` self) — a group of one.
  - on a `removed` group message from a peer: treat as this device's entry removed (the peer's roster will also say so): apply the self-removal above.
  - on control `unpaired` `{ mac }` for a device with a `remote_devices` row: delete the row and close its channel (the other side revoked the pair).
  - routes: `DELETE /api/remote/devices/:id` calls `remove`; new `POST /api/remote/leave` calls `leave` (200 `{ ok: true }`). Neither is on the phone allowlist.

- [ ] **Step 1: Write the failing tests**

```ts
it('removing a member on any device removes it everywhere', async () => {
  // A, B, C linked as in Task 6's test (extract a `threeLinked()` helper)
  await a.api('DELETE', `/api/remote/devices/${idC}`);
  await until(async () => {
    for (const s of [a, b]) {
      const m = (await s.api('GET', '/api/remote')).json().group.members.find((x: any) => x.id === idC);
      if (!m || m.removedAt === undefined || m.linked) return false;
    }
    return b.remote.channel(idC) === null;
  }, 15_000);
}, 30_000);

it('removed device learns: it becomes a group of one', async () => {
  // A, B, C linked; remove C from A; until C's status lists only itself, live, and no linked members
}, 30_000);

it('offline member catches up: a member that missed a removal drops its pair when it comes back', async () => {
  // A, B, C linked; stop B's remote (POST /api/remote/restart is not enough: use settings remote_enabled false,
  // or close B's app and start a new server on B's dir); remove C on A; bring B back; until B's roster has C removed
  // and B has no remote_devices row for C
}, 45_000);

it('leave: a member leaves the group from itself', async () => {
  // A, B linked; POST /api/remote/leave on B; until A lists B removed and B lists only itself
}, 30_000);
```

Complete the commented steps with the harness (`startMacAndRelay`, `until`, the status). For "offline member", the cleanest offline is to turn B's remote off and on through `PATCH /api/settings` `{ remote_enabled: 'false' }` and back, if the remote reacts to that setting (check `remoteRoutes.ts` and `settingsChanged`); otherwise use `app.close()` and a new `startMacAndRelay` over the same `dir` — extend the harness with an optional `dir` if needed.

In `server/test/remoteRoutes.test.ts`: `POST /api/remote/leave` answers 200; existing `DELETE /api/remote/devices/:id` tests keep passing (a revoked phone still gets `bye revoked` and the relay revoke).

- [ ] **Step 2: Run them and see them fail**

Run: `npm test -w server -- deviceChannelEndToEnd remoteRoutes`
Expected: FAIL.

- [ ] **Step 3: Implement** as the Interfaces block says. Order inside the self-removal matters: send `removed` and `bye revoked` while the channels still exist, then revoke at the relay, then clear the rows, then write the group of one.

- [ ] **Step 4: Run everything**

Run: `npm test -w shared && npm test -w relay && <server suite with ORBITAL_* unset> && npm test -w web -- mobile && npm run typecheck -w shared && npm run typecheck -w server && npm run typecheck -w relay && npm run typecheck -w web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src server/test
git commit -m "A device removed on any member is removed everywhere; a member can leave"
```

---

### Task 8: Documents

**Files:**
- Modify: `docs/superpowers/specs/2026-10-16-device-group-design.md`, `docs/domains/device-channel.md`
- Create: `docs/domains/device-group.md`

- [ ] **Step 1:** Spec § 2 "Storage" says the roster lives in `remote_devices`; as built it is its own table `group_members`, and `remote_devices` holds only linked devices. Add an "As built (part 2a)" note under § 14 saying that, plus: the relay route and the `linked` control as built, `pairByHand` on a 404, and the known limit — a removed device that is offline when it is removed learns it only when it next talks to a member that knows (the relay's `unpaired` is not queued for an absent device).
- [ ] **Step 2:** `docs/domains/device-group.md` (type `domain`, status `in-force`): how the roster merges and syncs, who writes what (self entry, newcomers at pairing, descriptions from hellos), how linking runs, how removal and leaving apply, where each piece lives. Plain sentences, constants by name.
- [ ] **Step 3:** `docs/domains/device-channel.md`: the `group` capability and group messages.
- [ ] **Step 4:** Set this plan's status to `done`. Run `bunx @slothworks/atlas validate`; commit "Device group: how the roster and linking work today".
