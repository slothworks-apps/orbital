---
id: 2026-10-17-device-group-settings
title: Device group, part 2b — Settings → Devices on the desktop
status: active
type: plan
domain: remote
related:
  - 2026-10-16-device-group-design
  - 2026-10-17-device-group-roster
  - joining-one-member-joins-the-group
tags:
  - web
  - server
  - remote
---
# Device group settings implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the desktop, Settings → Mobile becomes Settings → Devices: this device, every member of the group with its state, adding a device by code (QR or one word), joining another device's group by pasting its code, the join confirmation that names the kind three times, the ceremony's errors, removing a device and leaving.

**Architecture:** The server already keeps the group (part 2a: roster, linking, removal, `POST /api/remote/join`, `POST /api/remote/leave`, `DELETE /api/remote/devices/:id`, `status.group`). This part adds the few server answers the screens need — refuse a join from a device already in a group, cancel a join, the code's expiry inside the code, a member's display state — and rebuilds `MobileSection` and `PairConfirmDialog` in `web/` as the Devices section and the join confirmation, drawn from artboards 50a–50d and 50k.

**Tech Stack:** React, zustand, Tailwind v4, vitest + Testing Library; Fastify server; `qrcode-generator` as `MobileSection` uses it today.

**Spec:** `docs/superpowers/specs/2026-10-16-device-group-design.md` (§ 3, § 4, the Scope section). Design: Claude Design project `df77470e-1384-436c-8b25-5e01acfc497f`, file `Feature - Device group.dc.html`, artboards **50a** (Settings → Devices on a member), **50b** (joining, on the new device), **50c** (join confirmation), **50d** (ceremony errors), **50k** (kind glyphs, member states, wording). A copy split per artboard lives in the worktree at `.superpowers/design/` (`50a.html` … `50k.html`, `logic.js` for the demo's state logic); implementers read values there.

## Global Constraints

- Design values come from the artboard HTML, never from the eye (web/CLAUDE.md). Name the artboard in a comment where a value comes from it (`canvas 50a`).
- No string says "Mac" except a device's own name or OS (50k wording table). "This device", "device", "member", never "your Mac".
- Merging two groups is out (design 50 SCOPE, decided 2026-10-17): a device whose roster has another live member refuses to join elsewhere until it leaves.
- Changing the relay while in a group is out (decided 2026-10-17): the relay field is editable only while this device is alone; in a group it is read-only with the reason. Moving a whole group to another relay is an `idea`.
- State is a dot and words, never hue; nothing blinks, spins, counts or retries by itself (50a ROWS, 50d header, docs/why-orbital.md).
- No native form popups; use `ui/Select`, `ui/Dialog`, `ui/Button`, `ui/Input`, `ui/PairingCodeInput`, `ui/FingerprintBoxes` and the existing settings rows. `className` on a UI primitive is layout-only.
- The phone (`web/src/mobile`) does not change in this part; its Devices screens (50i, 50j) are part 3.
- Shipped devices are untouched: no wire or relay change in this part beyond an optional `expiresAt` in the QR payload (a shipped phone's schema strips unknown keys).
- Tests only where they catch a regression (root CLAUDE.md → Tests): server answers, pure helpers (state words, kind labels, code expiry), and the flows' branching; not that React renders a label, not styling values.
- Typecheck through the npm scripts; server suite with the session's `ORBITAL_*` unset; commit messages carry no attribution.
- Desktop changelog gets one line under `## [Unreleased]`; no version bump.

## Review Focus

1. **A phone paired today opens the new section** — it is listed as a member (`phone · Android`), its Remove still revokes it exactly as before, and the QR still pairs a new phone. Pinned in Task 3.
2. **A code pasted into the wrong place** — this device's own code, a code from another relay, an expired code, a code while this device is already in a group, garbage — each answers with its own card, none sends a request it should not. Pinned in Tasks 1 and 4.
3. **The member closes the confirmation, or the code expires while the joiner waits** — the joiner's waiting card ends on its own as rejected or expired, never waits forever. Pinned in Task 4.
4. **Leave while the relay is offline** — the 409 shows as words, nothing changes. Pinned in Task 3.
5. **One device alone** — no "In this group" noise beyond "Just this device", the relay field is editable, nothing about groups is shown that cannot be acted on. Pinned in Task 3.

---

## File structure

| file | responsibility |
|---|---|
| `server/src/remote/service.ts`, `server/src/api/remoteRoutes.ts` | `in_group` refusal, `DELETE /api/remote/join`, `expiresAt` in the QR, member display state in `status.group` |
| `shared/src/remote/relayApi.ts` | optional `expiresAt` in `QrPayload` |
| `web/src/lib/types.ts`, `web/src/lib/api.ts` | the status as the server sends it now; `join`, `cancelJoin`, `leave` |
| `web/src/lib/devices.ts` (new) | pure helpers: member state words, kind and OS labels, the one-word code, code time left |
| `web/src/ui/KindGlyph.tsx` (new) | the three CSS kind glyphs (canvas 50k) |
| `web/src/panels/DevicesSection.tsx` (new, replaces `MobileSection.tsx`) | Settings → Devices (50a) with the joining flow (50b, 50d) |
| `web/src/panels/PairConfirmDialog.tsx` | the join confirmation (50c, 50d A) |
| `web/src/panels/Settings.tsx` | nav item `devices`, label "Devices", replacing `mobile` |
| `docs/…` | spec § 3 and ADR on merging, an `idea` for moving a group's relay |

---

### Task 1: What the server answers for the screens

**Files:**
- Modify: `shared/src/remote/relayApi.ts`, `server/src/remote/service.ts`, `server/src/api/remoteRoutes.ts`
- Modify: `docs/superpowers/specs/2026-10-16-device-group-design.md`, `docs/decisions/joining-one-member-joins-the-group.md`
- Create: `docs/ideas/move-a-group-to-another-relay.md`
- Test: `server/test/remoteService.test.ts`, `server/test/remoteRoutes.test.ts`, `server/test/deviceChannelEndToEnd.test.ts`, `shared/test/relayApi.test.ts`

**Interfaces:**
- Produces:
  - `QrPayload.expiresAt?: number`; `startPairing` puts the relay's `expiresAt` into the QR.
  - `JoinResult` error `'in_group'`: `join()` refuses when this device's roster holds any live member other than itself. Checked before anything is sent to the relay. Route answers 409 `{ error: 'in_group' }`.
  - `JoinResult` error `'other_relay'` carries `{ error: 'other_relay', relay: string }` (the code's relay), so the card can name both relays.
  - `JoinResult` error `'peer_offline'` carries `{ error: 'peer_offline', expiresAt?: number }` from the code.
  - `RemoteService.cancelJoin(): boolean` — clears `joining` and publishes; route `DELETE /api/remote/join` → 200 `{ ok: true }` or 404 when nothing was joining. The relay's pending request simply expires.
  - `status.joining` gains `code: string` (the six characters to type, formatted) and `expiresAt: number`, so a reload keeps the waiting card.
  - `status.group.members[]` gains `state: 'self' | 'online' | 'offline' | 'linking' | 'notLinked'` and `seenAt: number | null`:
    - `self` for this device;
    - `online`/`offline` for a member with a `remote_devices` row (by the relay's presence; `seenAt` from the row's `lastSeenAt`);
    - `notLinked` for a live member that links, has no row, and is `pairByHand`;
    - `linking` for a live member that links, has no row, and is not `pairByHand`;
    - a live member that does not link and has no row here (a phone paired with another member) is `online`/`offline` by presence — it is shown, never "not linked".
    - removed members are not listed in `members` at all (the store keeps them).
  - `status.group.relayLocked: boolean` — true while the roster holds another live member (the relay field is read-only then).
  - `PATCH /api/settings` refuses `remote_relay_url` with 409 `{ error: 'in_group' }` while `relayLocked`.

- [ ] **Step 1: Write the failing tests**

`server/test/remoteService.test.ts` (use the file's FakeClient setup and how earlier tests seed the roster):

```ts
it('refuses to join another group while this device is in one', async () => {
  // seed the roster with self and one other live member; then:
  const res = await svc.join(validCodeFromAnotherDevice);
  expect(res).toEqual({ error: 'in_group' });
  expect(postsTo(fake, '/pair/redeem')).toHaveLength(0);
});

it('names the code relay when it is another one, and the code expiry when the member is offline', async () => {
  // a code whose relay differs → { error: 'other_relay', relay: 'https://relay.lab.internal' }
  // a code whose redeem answers 409 → { error: 'peer_offline', expiresAt: <the code's expiresAt> }
});

it('cancels a join', async () => {
  // join → joining set; cancelJoin() → true, status.joining null; cancelJoin() again → false
});

it('derives each member display state', () => {
  // self → 'self'; a row online → 'online'; a row offline → 'offline' with seenAt;
  // live linking member without row, not pairByHand → 'linking'; with pairByHand → 'notLinked';
  // a live phone of another member (links false, no row) → by presence, never 'notLinked'; removed → absent
});
```

`server/test/remoteRoutes.test.ts`: `POST /api/remote/join` with `in_group` → 409; `DELETE /api/remote/join` → 200 then 404; `PATCH /api/settings { remote_relay_url }` → 409 `in_group` while another member is live, 200 while alone.

`shared/test/relayApi.test.ts`: a QR with `expiresAt` parses and keeps it; one without still parses.

`server/test/deviceChannelEndToEnd.test.ts`: in the existing two-server `joined()` flow, assert `status.joining` carried `code` equal to what `join` answered while waiting, and `null` after the confirm.

- [ ] **Step 2: Run them and see them fail.** `npm test -w server -- remoteService remoteRoutes deviceChannelEndToEnd` and `npm test -w shared -- relayApi`.

- [ ] **Step 3: Implement** as the Interfaces block says. Keep `setRoster` the single roster entry point (nothing here writes the roster). The `in_group` check reads the roster: `this.roster.list().some((e) => isLive(e) && e.id !== self)`.

- [ ] **Step 4: Documents.**
  - Spec § 3 "Two groups meet": replace with "A device already in a group of two or more cannot join another; it leaves first (design 50, decided 2026-10-17). The roster's merge still converges if two groups ever meet, but no ceremony starts it." Spec § 4 / Scope: the relay field is editable only while the device is alone; moving a group to another relay is `move-a-group-to-another-relay`.
  - ADR `joining-one-member-joins-the-group`: in Decision, replace the sentence on merging two groups with the refusal and why (one person's devices form one group; merging two would surprise more than it helps).
  - `docs/ideas/move-a-group-to-another-relay.md` (type `idea`, status `backlog`): changing the relay on one member moves every online member with it; offline members show "not linked — pair by hand" (canvas 50a, Relay). What it needs: a group message naming the new relay, each member reconnecting, mutual pairs on the new relay, the old pairs revoked.
  - `bunx @slothworks/atlas validate`.

- [ ] **Step 5: Run and commit.** Server suite (ORBITAL_* unset), shared, typecheck server/shared/web. `git commit -m "Devices: refuse a join from a device in a group, cancel a join, member states, the code's expiry"`.

---

### Task 2: Web data and the small parts

**Files:**
- Modify: `web/src/lib/types.ts`, `web/src/lib/api.ts`
- Create: `web/src/lib/devices.ts`, `web/src/ui/KindGlyph.tsx`
- Test: `web/src/test/devices.test.ts`

**Interfaces:**
- Consumes: Task 1's status and routes.
- Produces:
  - `RemoteStatus` mirrors the server: `devices[].kind: string | null`; `pendingPair.kind: string`; `joining: { device: string; name: string; code: string; expiresAt: number } | null`; `group: { members: GroupMember[]; relayLocked: boolean }` with `GroupMember = { id, kind, name, os, links, epoch, addedBy, addedAt, describedAt, self, linked, online, pairByHand, state, seenAt }`.
  - `api.joinGroup(code: string): Promise<JoinAnswer>` where `JoinAnswer = { ok: true; device; name; code } | { ok: false; error: 'bad_code' | 'disabled' | 'offline' | 'already_paired' | 'in_group' | 'relay_error' | 'relay_too_old' } | { ok: false; error: 'other_relay'; relay: string } | { ok: false; error: 'peer_offline'; expiresAt?: number }`; `api.cancelJoin(): Promise<void>`; `api.leaveGroup(): Promise<{ ok: true } | { ok: false; error: 'offline' | 'failed' }>`.
  - `web/src/lib/devices.ts`:
    - `memberStateWords(m: GroupMember, now: number): string` — 50k MEMBER STATE: `online`, `offline · seen 2 h ago` (or `offline` without `seenAt`), `linking…`, `not linked — pair by hand`; `self` → `this device`.
    - `kindWord(kind: string): 'desktop' | 'headless' | 'phone' | string`, `osLabel(os: string): string` (`macos` → `macOS`, `linux` → `Linux`, `ios` → `iOS`, `android` → `Android`, unknown as is), `kindOs(kind, os): string` (`desktop · macOS`).
    - `addedByLine(m: GroupMember, members: GroupMember[]): string | null` — `added by <name>` using the adder's roster name; null for self when added by self.
    - `oneWordCode(qrJson: string): string` — `encodePairingCode` from shared.
    - `codeTimeLeft(expiresAt: number, now: number): { label: string; expired: boolean }` — reuse `codeLeft` from `web/src/lib/remote.ts` if it already does this; otherwise add it there and reuse.
  - `KindGlyph({ kind, scale? }: { kind: string; scale?: 1 | 3 })` — the CSS glyphs from canvas 50k (screen / rack / handset, 12 × 11 px in `currentColor`, 3× on the confirmation); an unknown kind renders the desktop glyph.

- [ ] **Step 1: Failing tests** in `web/src/test/devices.test.ts` for `memberStateWords` (every state, seen-ago wording via the app's existing `timeAgo`), `kindOs`/`osLabel`, `addedByLine` (adder found, adder unknown → `added by` the id's first 8 characters, self → null), `oneWordCode` round-trips through shared `parsePairingCode`.
- [ ] **Step 2: See them fail.** `npm test -w web -- devices`.
- [ ] **Step 3: Implement.** Read canvas 50k (`.superpowers/design/50k.html`) for the glyph CSS and the wording; take the values from there.
- [ ] **Step 4: Pass, typecheck web, commit.** `git commit -m "Devices: the status as the server sends it, member state words, kind glyphs"`.

---

### Task 3: Settings → Devices (50a)

**Files:**
- Create: `web/src/panels/DevicesSection.tsx`
- Delete: `web/src/panels/MobileSection.tsx` (move what stays: `useRelayCheck`, `RelayTooOldCard`, `Advanced`'s relay URL/secret rows, the QR rendering)
- Modify: `web/src/panels/Settings.tsx`, `web/src/panels/settingsRows.tsx` if it references the section
- Test: `web/src/test/settings.test.tsx` (rename the Mobile cases), `web/src/test/devicessection.test.tsx` (new)

**Interfaces:**
- Consumes: Task 2.
- Produces: `DevicesSection` with the same props `MobileSection` took (check `Settings.tsx`), rendered for nav key `devices` labelled "Devices" in the same place `mobile` was. A stored visit to `mobile` (Settings remembers the last section) opens `devices`.

What it shows, top to bottom (values and wording from `.superpowers/design/50a.html`; behaviour from its ROWS / ADD A DEVICE / QUIET BY DESIGN notes and `logic.js`):

1. **REMOTE** — "Connect this device to the group", the relay line and switch as today (`useRelayCheck` and the relay-too-old card move over unchanged). **Relay** field: editable while `group.relayLocked` is false; read-only with "One relay for the whole group." while true.
2. **THIS DEVICE** — name with ✎ rename (writes `remote_mac_name` as today), `kindOs` line, "EVERY DEVICE SEES THIS NAME".
3. **IN THIS GROUP · n** — "ANY MEMBER CAN REMOVE ANY DEVICE"; one row per member except self (glyph, name, kind · OS, `added by …` with the date on hover, state dot + words); a row's Remove opens the inline confirm "Remove <name>? It drops out of every device in the group now and has to join again." → `api.removeDevice`. A `notLinked` row also offers **Pair by hand**, which titles the add-a-device box for that device (50a ADD A DEVICE note). With no other member: "Just this device · Add another with the code on the right, or paste one of theirs."
4. **ADD A DEVICE** — `api.startPairing` code shown twice: QR "For a phone · Scan it with Orbital on the phone." and the one word "For a desktop or a server" with Copy and "paste it in Devices there · on a server: `orbital join orb1…`"; expiry countdown; "CODE EXPIRED · New code" when it runs out. "Have another device's code?" field + Join (Task 4 owns what Join does; here the field and button exist and call Task 4's handler).
5. **Leave this group** — only while another member exists: "Sessions here keep running." Leave… → inline "Leave? This device forgets the other n and their keys; they stop seeing its sessions." → `api.leaveGroup`; `offline` answer shows "Connect to the relay to leave — the others have to hear it." in the same place; nothing else changes.

- [ ] **Step 1: Failing tests** (`devicessection.test.tsx`, mocking `api` the way `settings.test.tsx` does):
  - a phone paired today is listed as a member row with `phone · Android` and its Remove calls `api.removeDevice(id)` after the inline confirm;
  - alone: "Just this device", no Leave, relay field editable;
  - with another member: relay field read-only, Leave present; Leave answering `offline` shows the words and calls nothing else;
  - a `notLinked` member shows "not linked — pair by hand" and a Pair by hand action; a `linking` one shows `linking…`;
  - a stored `mobile` section opens Devices.
- [ ] **Step 2: See them fail.**
- [ ] **Step 3: Implement**, reading every size, colour, radius and gap from `50a.html`. Reuse the existing settings row components and `ui/` primitives; add a variant to a primitive rather than overriding it.
- [ ] **Step 4: Pass; run `npm test -w web`, typecheck web; commit** `git commit -m "Settings → Devices replaces Settings → Mobile"`.

---

### Task 4: Joining from this device (50b, 50d B–D)

**Files:**
- Modify: `web/src/panels/DevicesSection.tsx` (or a new `web/src/panels/JoinCard.tsx` if the section grows past one screen of code)
- Test: `web/src/test/devicessection.test.tsx`

**Interfaces:**
- Consumes: `api.joinGroup`, `api.cancelJoin`, `status.joining`, `parsePairingCode` (to read the code's relay and expiry before sending — a code from another relay is caught at paste, 50d B).

Behaviour (values and wording from `50b.html` and `50d.html`):
- Paste + Join:
  - not a code → "That isn't a device code." under the field (no request);
  - this device's own code → "That's this device's own code." (no request);
  - another relay → card B: "<name> uses another relay · It's on <relay>; this device is on <relay>. Both need the same one." plus "Use <relay>" only while `relayLocked` is false (sets `remote_relay_url` through the existing settings path), otherwise "Leave this group first to change relays.";
  - `in_group` → "This device is already in a group. Leave it first, then join.";
  - `peer_offline` → card C: "<name> is offline · Checked just now. Its code is good for another m:ss — try again once <name> is awake." with Try again (one more `joinGroup`), no loop;
  - expired (code's `expiresAt` passed, or the answer says so) → card D "Code expired · Codes last two minutes. Make a new one on <name> and paste it again." with "Paste a new code".
- While `status.joining` is set: the JOINING card — "Type K7F-Q2M on <member>" with the six characters in boxes (`ui/FingerprintBoxes`), the member's kind · OS, "waiting · code expires in m:ss", Cancel (`api.cancelJoin`). When `joining` clears and the member appears in `group.members`, the list fills in place (50b AFTER); when it clears without the member (rejected), card "Request rejected"; when its `expiresAt` passes, card D.

- [ ] **Step 1: Failing tests** for each branch above with mocked `api` answers and a fake clock.
- [ ] **Step 2: See them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Pass; `npm test -w web`, typecheck; commit** `git commit -m "Devices: join another device's group by its code"`.

---

### Task 5: The join confirmation (50c, 50d A)

**Files:**
- Modify: `web/src/panels/PairConfirmDialog.tsx`
- Test: `web/src/test/pairconfirm.test.tsx`

Behaviour (values and wording from `50c.html`, `50d.html` A):
- Header "JOIN REQUEST · EXPIRES IN m:ss".
- Kind tile: `KindGlyph` at 3×, the kind word in mono capitals (`DESKTOP` / `HEADLESS` / `PHONE`), and its meaning line (50c `cK.note` values in `logic.js`).
- Sentence "<name> (<kind>, <OS>) wants to join" and "Once in, it sees and drives every session on every device in this group."
- The six boxes, Reject / Accept as today; a wrong code clears the boxes and shows "That code doesn't match · n attempts left"; the third miss shows "Request rejected" as today's toast does.
- Accept → "✓ <name> joined · The other devices link to it on their own. It appears under Devices → In this group."
- Closing the dialog is Reject (as today).
- A shipped phone's request (`kind` read as `phone`) reads "Pixel (phone, Android) wants to join".

- [ ] **Step 1: Failing tests:** the sentence for a desktop, a headless and a phone request; the kind word appears; wrong code wording; accept shows "<name> joined".
- [ ] **Step 2–4:** see them fail, implement, pass, typecheck, commit `git commit -m "The join confirmation names the device's kind"`.

---

### Task 6: Changelog and the fidelity pass

**Files:**
- Modify: `desktop/CHANGELOG.md`

- [ ] **Step 1:** `desktop/CHANGELOG.md` under `## [Unreleased]`: "Settings → Mobile is now Settings → Devices: pair another Mac or a server by code, see every device in your group, remove one or leave." (one line, plain).
- [ ] **Step 2 (controller, not a subagent):** fidelity pass against artboards 50a–50d in a real browser (memory: fidelity-pass-recipe — built web on :4848 via `ORBITAL_STATIC_DIR`, Playwright, a local relay), two servers paired so the group has members in every state; fix drift through the implementer of the task that owns it.
- [ ] **Step 3:** set this plan's status to `done`; `bunx @slothworks/atlas validate`; commit.
