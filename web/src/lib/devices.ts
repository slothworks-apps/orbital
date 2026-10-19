/**
 * Settings → Devices' pure derivations (spec 2026-10-16-device-group-design):
 * a member's state wording, its kind and OS, what this device offers by its
 * place in the group (canvas 50a, 50l) and the notice of a group's ending
 * (50m, 50n); and the map's and sidebar's device
 * chips and filter (canvas 50e).
 */
import { linksWith } from '@orbital/shared/remote/group'
import { osLabel } from '@orbital/shared/remote/groupWords'
import {
  memberServesUpdate, type ServerUpdateRefusal, type ServerUpdateState,
} from '@orbital/shared/remote/serverUpdate'
import { api } from './api'
import { timeAgo } from './format'
import type {
  ApiSession, GroupEnded, GroupMember, IdeContext, MachineRef, MemberState, RemoteDevice, RemoteStatus, Tag,
} from './types'

/** In shared, so the `orbital` CLI gates on the same rule. */
export { memberServesUpdate }

type UpdateMember = Pick<GroupMember, 'id' | 'self' | 'kind' | 'version'>

/**
 * A member's update state, asked of it through this server (`?machine=`,
 * this device's own without); null for a member that does not serve the
 * route (`memberServesUpdate`), which is never asked. What Settings →
 * Devices calls; `api.serverUpdate` itself does not gate.
 */
export async function readMemberUpdate(m: UpdateMember): Promise<ServerUpdateState | null> {
  if (!memberServesUpdate(m)) return null
  return api.serverUpdate(m.self ? undefined : m.id)
}

/** Starts a member's update; null for a member that does not serve the route. */
export async function startMemberUpdate(
  m: UpdateMember,
): Promise<{ ok: true; state: ServerUpdateState } | { ok: false; error: ServerUpdateRefusal } | null> {
  if (!memberServesUpdate(m)) return null
  return api.startServerUpdate(m.self ? undefined : m.id)
}

/** `desktop · macOS` (canvas 50k); the OS half drops with its separator while it is not known yet. */
export function kindOs(kind: string, os: string): string {
  const label = osLabel(os)
  return label === '' ? kind : `${kind} · ${label}`
}

/** `offline`, dated by `seenAt` when there is one, in `agoWords`' words: `offline · seen 12 min ago`. */
function offlineWords(seenAt: number | null, now: number): string {
  return seenAt === null ? 'offline' : `offline · seen ${agoWords(seenAt, now)}`
}

/**
 * The member state row's words (canvas 50k MEMBER STATE): the accent dot is
 * drawn elsewhere, this is only the text beside it. `offline` with no
 * `seenAt` (a member never paired here) reads bare, with nothing to date it by.
 */
export function memberStateWords(m: GroupMember, now: number): string {
  // An Orbital too old to federate says what to do about it, whatever its
  // presence (canvas 50e/50g, logic.js `stText` → `update`).
  if (m.tooOld) return `update Orbital on ${m.name}`
  switch (m.state) {
    case 'self': return 'this device'
    case 'online': return 'online'
    case 'offline': return offlineWords(m.seenAt, now)
    case 'linking': return 'linking…'
    case 'notLinked': return 'not linked — pair by hand'
  }
}

/** The device that paired a member: the group's primary, `this device` when it is the one reading the list. */
function primaryName(members: GroupMember[]): string {
  const primary = members.find((x) => x.primary)
  if (!primary) return 'another device'
  return primary.self ? 'this device' : primary.name
}

/**
 * A phone paired with another member: it does not link with this device and
 * is not paired here, so the relay's presence says nothing about it here.
 * Only a phone: a desktop or server in that state is a member still on its
 * way to linking (or the ghost of a cancelled join), and keeps its own state
 * words. A phone that links still never links with another phone
 * (`linksWith`), so seen from a phone it is paired elsewhere too.
 */
function pairedElsewhere(m: GroupMember, selfKind: string | undefined): boolean {
  return !m.self && m.kind === 'phone' && !m.linked && !linksWith(selfKind ?? '', m)
}

/**
 * A row's state in IN THIS GROUP: a member's, `update` for a phone refused
 * as too old (canvas 50a ROWS), or `elsewhere` for a phone paired with
 * another member, which has no presence here and so no dot.
 */
export type RowState = Exclude<MemberState, 'self'> | 'update' | 'elsewhere'

/** One row of Settings → Devices' IN THIS GROUP (canvas 50a, 50l). */
export interface DeviceRow {
  id: string
  name: string
  kind: string
  os: string
  state: RowState
  /** The words beside the state dot (no dot while `elsewhere`). */
  words: string
  /** The group's primary: the quiet PRIMARY label beside its name (canvas 50a ROWS). */
  primary: boolean
  /** Named by the roster; false for a device paired here outside any group, which only this device can drop. */
  member: boolean
  addedAt: number
  /** What the refusal said, while `state` is `update`. */
  needsUpdate: RemoteDevice['needsUpdate']
}

/**
 * The rows under IN THIS GROUP: every member but this device, then every
 * paired device the roster does not list (a device this one paired outside
 * any group; the relay's presence says whether it is online). A paired
 * device this server refused as too old reads `needs an update` whatever
 * its presence says — the relay may still count it online. A member not
 * linked reads `not linked`, and offers pairing by hand only where this
 * device `pairsByHand` — on the primary (canvas 50l).
 */
export function deviceRows(
  members: GroupMember[], devices: RemoteDevice[], now: number, pairsByHand = true,
): DeviceRow[] {
  const paired = new Map(devices.map((d) => [d.id, d]))
  const listed = new Set(members.map((m) => m.id))
  const selfKind = members.find((m) => m.self)?.kind
  const fromRoster = members.filter((m) => !m.self).map((m): DeviceRow => {
    const needsUpdate = paired.get(m.id)?.needsUpdate ?? null
    const elsewhere = !needsUpdate && pairedElsewhere(m, selfKind)
    const notLinked = !needsUpdate && !elsewhere && !m.tooOld && m.state === 'notLinked'
    return {
      id: m.id, name: m.name, kind: m.kind, os: m.os,
      state: needsUpdate ? 'update' : elsewhere ? 'elsewhere' : m.state === 'self' ? 'online' : m.state,
      words: needsUpdate ? 'needs an update'
        : elsewhere ? `paired with ${primaryName(members)}`
          : notLinked && !pairsByHand ? 'not linked' : memberStateWords(m, now),
      primary: m.primary,
      member: true,
      addedAt: m.addedAt,
      needsUpdate,
    }
  })
  const unlisted = devices.filter((d) => !listed.has(d.id)).map((d): DeviceRow => ({
    id: d.id, name: d.name, kind: d.kind ?? 'phone', os: d.platform,
    state: d.needsUpdate ? 'update' : d.online ? 'online' : 'offline',
    words: d.needsUpdate ? 'needs an update' : d.online ? 'online' : offlineWords(d.lastSeenAt, now),
    primary: false,
    member: false,
    addedAt: d.pairedAt,
    needsUpdate: d.needsUpdate,
  }))
  return [...fromRoster, ...unlisted]
}

/**
 * What Settings → Devices offers on this device, by its place in the group
 * (ADR the-group-has-one-primary-device; canvas 50a, 50l). The primary adds
 * a device, removes any, pairs by hand and dissolves; a member does none of
 * that, names the primary in the add box's place, and leaves; a device in no
 * group adds one, which founds a group.
 */
export interface GroupView {
  role: 'primary' | 'member' | 'alone'
  /** ADD A DEVICE: the code and the field that pastes another's. */
  canAdd: boolean
  /** The name the add box's place gives on a member: `<primary> manages this group`. */
  managedBy: string | null
  /** Pair by hand on a row that is not linked. */
  pairsByHand: boolean
  /** The box under the add area, while another device is in the group: Dissolve on the primary, Leave on a member. */
  exit: 'dissolve' | 'leave' | null
  /** PRIMARY on THIS DEVICE's kicker, and the list's `ONLY THE PRIMARY ADDS OR REMOVES`. */
  selfPrimary: boolean
}

/** `others`: the group's members other than this device. */
export function groupView(group: Pick<RemoteStatus['group'], 'primary' | 'isPrimary'>, others: number): GroupView {
  const role = group.isPrimary ? 'primary' : group.primary !== null ? 'member' : 'alone'
  const inGroup = others > 0
  return {
    role,
    canAdd: role !== 'member',
    managedBy: role === 'member' ? group.primary!.name : null,
    pairsByHand: role === 'primary',
    exit: !inGroup || role === 'alone' ? null : role === 'primary' ? 'dissolve' : 'leave',
    selfPrimary: role === 'primary' && inGroup,
  }
}

/**
 * Whether a row offers Remove: on the primary, every row; elsewhere only a
 * device paired here outside any group, whose pair is this device's own to
 * end (`GroupMember.remove`). A member removes no member (canvas 50l).
 */
export function canRemoveRow(view: GroupView, row: Pick<DeviceRow, 'member'>): boolean {
  return view.role === 'primary' || !row.member
}

/**
 * The one-time notice of a group's ending by the primary's hand (canvas
 * 50m on the desktop, 50n on the phone): its head and its body.
 */
export function endedNotice(ended: GroupEnded, on: 'desktop' | 'phone'): { head: string; body: string } {
  const self = on === 'phone' ? 'this phone' : 'this device'
  const head = ended.why === 'dissolved' ? `${ended.by.name} dissolved the group` : `${ended.by.name} removed ${self} from the group`
  const body = on === 'phone'
    ? 'This phone is standalone now. It shows sessions again once it pairs with a desktop or server.'
    : 'This device is standalone now. Its own sessions kept running; it no longer sees the others’.'
  return { head, body }
}

/** The versions and the time behind `needs an update` (as Settings → Mobile said it, canvas 11c). */
export function needsUpdateLine(needsUpdate: NonNullable<RemoteDevice['needsUpdate']>, now: number): string {
  return `app ${needsUpdate.version} · this device needs ≥ ${needsUpdate.needed} · refused · ${timeAgo(needsUpdate.at, now)}`
}

/** The device id of this device's own sessions: one with no `machine` runs here. */
export const LOCAL_DEVICE = 'self'

/** The device a session runs on: a member's id, or `LOCAL_DEVICE`. */
export function deviceOf(session: Pick<ApiSession, 'machine'>): string {
  return session.machine?.id ?? LOCAL_DEVICE
}

/**
 * Whether a session runs on a member of the group that is offline now: by
 * the session's own `machine`, and — when `members` is passed — by the
 * roster too. Never for this device's own sessions.
 */
export function machineOffline(
  session: Pick<ApiSession, 'machine'>,
  members?: GroupMember[],
): boolean {
  if (!session.machine) return false
  return !session.machine.online || memberOf(session, members)?.state === 'offline'
}

/** How often an offline member's `as of` age is re-read, wherever it shows. */
export const AS_OF_TICK_MS = 60_000

/** `timeAgo` with a space before its unit, the way the canvas spells an age (`2 h`, `3 d`); `now` and dates as they are. */
export function spacedAgo(ts: number, now: number): string {
  return timeAgo(ts, now).replace(/^(\d+)([mhd])$/, '$1 $2')
}

/** The kind of the device a session runs on: the roster's, else the session's own `machine`'s, else a desktop. */
export function deviceKind(session: Pick<ApiSession, 'machine'>, members: GroupMember[] | undefined): string {
  return memberOf(session, members)?.kind ?? session.machine?.kind ?? 'desktop'
}

/** One device chip above the tag chips (canvas 50e, logic.js `devChips`). */
export interface DeviceChip {
  /** `LOCAL_DEVICE` for this device, a member's id otherwise. */
  id: string
  /** What the chip reads: `This device`, or the member's name. */
  label: string
  name: string
  kind: string
  /** The member is offline: the chip (and its sessions) at half opacity. */
  offline: boolean
  /** Its Orbital is too old to federate: a mono `update` after the label. */
  update: boolean
}

/**
 * Who gets a chip (canvas 50e WHO GETS A CHIP): this device first, then every
 * member that can host sessions here, in roster order — linked (online or
 * offline), or too old to federate (its chip says `update`). Phones host
 * none; a member still linking, or not linked, gets its chip once linked.
 * With the remote off there are no members, and only this device.
 */
export function deviceChips(members: GroupMember[] | undefined): DeviceChip[] {
  const list = members ?? []
  const self = list.find((m) => m.self)
  const chips: DeviceChip[] = [{
    id: LOCAL_DEVICE, label: 'This device', name: self?.name ?? '', kind: self?.kind ?? 'desktop',
    offline: false, update: false,
  }]
  for (const m of list) {
    if (m.self || m.kind === 'phone') continue
    if (!m.tooOld && m.state !== 'online' && m.state !== 'offline') continue
    chips.push({
      id: m.id, label: m.name, name: m.name, kind: m.kind,
      offline: m.state === 'offline', update: m.tooOld,
    })
  }
  return chips
}

/**
 * `deviceChips` as one string, for a store selector that should settle: the
 * roster is a new array on every `remote` publish, the chips it gives mostly
 * the same. `chipsOfKey` reads it back.
 */
export function deviceChipsKey(members: GroupMember[] | undefined): string {
  return JSON.stringify(deviceChips(members))
}

/** The chips a `deviceChipsKey` string holds. */
export function chipsOfKey(key: string): DeviceChip[] {
  return JSON.parse(key) as DeviceChip[]
}

/** The chip row appears only once a second device can host sessions (canvas 50e). */
export function showDeviceRow(chips: DeviceChip[]): boolean {
  return chips.length >= 2
}

/**
 * The ids of the chips that are on. A hidden id that names no chip any more
 * is ignored. Never none: should the one chip left on disappear (its member
 * stops linking), every chip reads on again rather than hiding everything
 * behind a row that may no longer even show.
 */
export function devicesOn(chips: DeviceChip[], hidden: string[]): string[] {
  const on = chips.filter((c) => !hidden.includes(c.id)).map((c) => c.id)
  return on.length > 0 ? on : chips.map((c) => c.id)
}

/**
 * The hidden ids after clicking chip `id`: off if it was on, on if it was
 * off. The last chip on cannot be turned off (canvas 50e), so that click
 * returns `hidden` unchanged. Stale ids (no chip any more) are kept: a member
 * that drops out of the roster for a moment keeps its choice when it returns.
 */
export function toggleDevice(hidden: string[], id: string, chips: DeviceChip[]): string[] {
  const on = devicesOn(chips, hidden)
  if (!on.includes(id)) return hidden.filter((h) => h !== id)
  if (on.length <= 1) return hidden
  // Ids `devicesOn` read as on despite `hidden` (its never-none fallback) are
  // on now for real, so only `id` goes off.
  return [...hidden.filter((h) => !on.includes(h)), id]
}

/**
 * Whether labels carry the device name (canvas 50e NAMES ON LABELS): only
 * while the row shows and two or more chips are on — with one on, the user
 * already chose the device.
 */
export function namesShown(chips: DeviceChip[], hidden: string[]): boolean {
  return showDeviceRow(chips) && devicesOn(chips, hidden).length >= 2
}

/**
 * `as of 2 h`: how old an offline member's sessions are (canvas 50e), read
 * by the sidebar rows, the planets and the Desk cards. Null while the member
 * is online, for this device's own sessions, and with no `asOf` to date it.
 * `timeAgo`'s `2h` gets a space before its unit, the way the canvas spells it.
 */
export function asOfLabel(machine: MachineRef | undefined, now: number): string | null {
  if (!machine || machine.online || machine.asOf === null) return null
  return `as of ${spacedAgo(machine.asOf, now)}`
}

/**
 * A request about another device's session refused because that device is
 * offline (409 `member_offline`, spec § 8). A drop on History that meets it
 * reports nothing: the card or planet stays, and the drop works once the
 * device is back.
 */
export function isMemberOffline(err: unknown): boolean {
  if (!(err instanceof Error) || (err as { status?: unknown }).status !== 409) return false
  return err.message.includes('member_offline')
}

/**
 * How long ago, in the words the detail panel prints it (canvas 50f `Last
 * seen 12 min ago`, `AS OF 12 MIN AGO`): `just now` inside the first
 * minute, `12 min ago`, `2 h ago`, `3 d ago`, then the date alone.
 */
export function agoWords(ts: number, now: number): string {
  const ago = spacedAgo(ts, now)
  if (ago === 'now') return 'just now'
  if (!/^\d+ [mhd]$/.test(ago)) return ago
  return `${ago.replace(/ m$/, ' min')} ago`
}

/** The roster entry of the device a session runs on: this device's own for a local session. */
export function memberOf(
  session: Pick<ApiSession, 'machine'>,
  members: GroupMember[] | undefined,
): GroupMember | undefined {
  const list = members ?? []
  return session.machine ? list.find((m) => m.id === session.machine?.id) : list.find((m) => m.self)
}

/**
 * The detail header's state line keeps its last value while the device is
 * offline, dated (canvas 50f `fState`: `WORKING · AS OF 12 MIN AGO`): the
 * `AS OF …` half, or null for a device that is up, this device's own
 * session, and an offline one with nothing to date it by.
 */
export function stateAsOf(machine: MachineRef | undefined, now: number): string | null {
  if (!machine || machine.online || machine.asOf === null) return null
  return `AS OF ${agoWords(machine.asOf, now).toUpperCase()}`
}

/** What replaces the composer of a session that cannot be driven from here (canvas 50f `fLockTitle`, `fLockBody`). */
export interface DeviceLock {
  title: string
  body: string
}

/**
 * Whether the composer of a session gives way to the reason it cannot be
 * driven (canvas 50f C): null for this device's sessions and for a member
 * that is up; the update texts for a member too old to federate (its
 * versions are not known here, so the canvas's `It runs orbital 0.5.3;
 * groups need 0.6` names none); the offline texts, dated by when it was last seen, for one
 * that is down — by the session's own `machine` or by the roster.
 */
export function deviceLock(
  session: Pick<ApiSession, 'machine'>,
  members: GroupMember[] | undefined,
  now: number,
): DeviceLock | null {
  const machine = session.machine
  if (!machine) return null
  const member = memberOf(session, members)
  const name = member?.name ?? machine.name
  if (member?.tooOld) {
    return {
      title: `Update Orbital on ${name}`,
      body: `Its Orbital is too old for groups. Nothing from ${name} reaches this device until it is updated.`,
    }
  }
  if (!machineOffline(session, members)) return null
  const seen = member?.seenAt ?? machine.asOf
  const back = `Everything it sent is here to read; the composer opens again when ${name} is back.`
  return {
    title: `${name} is offline`,
    body: seen === null ? back : `Last seen ${agoWords(seen, now)}. ${back}`,
  }
}

/** The RUNS ON card's state line and its dot (canvas 50f `fbState`, `fbDot`). */
export interface RunsOn {
  name: string
  kind: string
  os: string
  /** `live`: the accent dot; `offline`: a hollow ring; `update`: a solid light dot. */
  dot: 'live' | 'offline' | 'update'
  words: string
}

/**
 * What the device pill's hover card says (canvas 50f RUNS ON): the device's
 * name, kind and OS, and its state — `online · added by <who>`, `offline ·
 * seen 12 min ago`, `update Orbital on <name>`, or `this device`. A member
 * the roster does not list (yet) is read off the session's own `machine`.
 */
export function runsOn(
  session: Pick<ApiSession, 'machine'>,
  members: GroupMember[] | undefined,
  now: number,
): RunsOn {
  const member = memberOf(session, members)
  const machine = session.machine
  const name = member?.name ?? machine?.name ?? ''
  const kind = deviceKind(session, members)
  const os = member?.os ?? machine?.os ?? ''
  if (!machine) return { name, kind, os, dot: 'live', words: 'this device' }
  if (member?.tooOld) return { name, kind, os, dot: 'update', words: `update Orbital on ${name}` }
  if (machineOffline(session, members)) {
    const seen = member?.seenAt ?? machine.asOf
    return { name, kind, os, dot: 'offline', words: offlineWords(seen, now) }
  }
  return { name, kind, os, dot: 'live', words: member?.primary ? 'online · primary' : 'online' }
}

/** The device pill's words (canvas 50f `fTag`): the name, and why it cannot be driven when it cannot. */
export function pillWords(session: Pick<ApiSession, 'machine'>, members: GroupMember[] | undefined): string {
  const member = memberOf(session, members)
  const name = member?.name ?? session.machine?.name ?? ''
  if (!session.machine) return name
  if (member?.tooOld) return `${name} · update`
  return machineOffline(session, members) ? `${name} · offline` : name
}

/**
 * Every session of `machineId` marked offline, as the server will republish
 * them: a request about one of them was refused with `member_offline` while
 * this tab still held the member as up. `asOf` keeps a date it already had,
 * else takes `now`. The same object when no session runs there.
 */
export function withMachineOffline<S extends Pick<ApiSession, 'machine'>>(
  sessions: Record<string, S>,
  machineId: string,
  now: number,
): Record<string, S> {
  let next: Record<string, S> | null = null
  for (const [id, s] of Object.entries(sessions)) {
    if (s.machine?.id !== machineId || machineOffline(s)) continue
    next ??= { ...sessions }
    next[id] = { ...s, machine: { ...s.machine, online: false, asOf: s.machine.asOf ?? now } }
  }
  return next ?? sessions
}

/**
 * A member's state as its server says it (a `machine` event on `sessions`):
 * every session that runs on it takes `machine`. The same object when no
 * session runs there.
 */
export function withMachine<S extends Pick<ApiSession, 'machine'>>(
  sessions: Record<string, S>,
  machine: MachineRef,
): Record<string, S> {
  let next: Record<string, S> | null = null
  for (const [id, s] of Object.entries(sessions)) {
    if (s.machine?.id !== machine.id) continue
    next ??= { ...sessions }
    next[id] = { ...s, machine }
  }
  return next ?? sessions
}

/**
 * The editor a session's composer and file paths may talk to: none for
 * another device's session, whose files are on that device (canvas 50f B:
 * no editor button and no IDE in the composer).
 */
export function ideHere(session: Pick<ApiSession, 'machine' | 'ide'> | undefined): IdeContext | null {
  if (!session || session.machine) return null
  return session.ide ?? null
}

/**
 * Another device's tag id as this device's tag of the same name — how a
 * session's tags cross between devices (spec § 7) — or null when this device
 * has no tag by that name, or there was no tag.
 */
export function localTagOf(
  theirId: number | null,
  theirTags: Pick<Tag, 'id' | 'name'>[],
  ourTags: Pick<Tag, 'id' | 'name'>[],
): number | null {
  if (theirId === null) return null
  const name = theirTags.find((t) => t.id === theirId)?.name
  return name === undefined ? null : (ourTags.find((t) => t.name === name)?.id ?? null)
}

/**
 * The Claude directory a session's mark is read from on this device: none
 * for another device's session, whose directory ids are that device's own
 * and would name one of this device's directories by accident.
 */
export function localClaudeDirId(
  session: Pick<ApiSession, 'machine' | 'claudeDirId'> | undefined,
): number | null {
  if (!session || session.machine) return null
  return session.claudeDirId ?? null
}

/** One row of New session's DEVICE field (canvas 50g, logic.js `opts`). */
export interface DeviceOption {
  /** `LOCAL_DEVICE` for this device, a member's id otherwise. */
  id: string
  /** `This device`, or the member's name. */
  label: string
  /** The member's own name; this device's name for `LOCAL_DEVICE`. */
  name: string
  kind: string
  /** `<own name> · desktop · macOS` for this device, `headless · Linux` for one that can host, else the reason it cannot. */
  sub: string
  /** Listed but inert: offline, too old, still linking, or not linked. */
  inert: boolean
}

/**
 * The devices a new session can be started on (canvas 50g DEVICE FIRST):
 * this device first, then every other member in roster order but phones
 * (`PHONES DRIVE SESSIONS · THEY DON'T RUN THEM`). Only an online member
 * whose Orbital federates can take one; the rest are listed, inert, with
 * the reason as their sub-line (`memberStateWords`).
 */
export function deviceOptions(members: GroupMember[] | undefined, now: number): DeviceOption[] {
  const list = members ?? []
  const self = list.find((m) => m.self)
  const selfKindOs = kindOs(self?.kind ?? 'desktop', self?.os ?? '')
  const options: DeviceOption[] = [{
    id: LOCAL_DEVICE, label: 'This device', name: self?.name ?? '', kind: self?.kind ?? 'desktop',
    sub: self?.name ? `${self.name} · ${selfKindOs}` : selfKindOs,
    inert: false,
  }]
  for (const m of list) {
    if (m.self || m.kind === 'phone') continue
    const inert = m.tooOld || m.state !== 'online'
    options.push({
      id: m.id, label: m.name, name: m.name, kind: m.kind,
      sub: inert ? memberStateWords(m, now) : kindOs(m.kind, m.os),
      inert,
    })
  }
  return options
}

/**
 * The device New session opens on (canvas 50g: "Defaults to the device of
 * the last session you launched"): the selected planet's device when the
 * dialog opens from one (its directory comes along), else the remembered
 * one — each only while it can take a session; else the first that can —
 * this device on a desktop, whose option leads and is never inert; the
 * first awake one on the phone, which lists no option of its own (canvas
 * 50j). `LOCAL_DEVICE` when none can.
 */
export function openingDevice(options: DeviceOption[], remembered: string | null, planet?: string): string {
  for (const id of [planet, remembered]) {
    if (id && options.some((o) => o.id === id && !o.inert)) return id
  }
  return options.find((o) => !o.inert)?.id ?? LOCAL_DEVICE
}

/** A step of the folder chooser's breadcrumbs (canvas 50g `gCrumbs`). */
export interface Crumb {
  label: string
  path: string
}

/**
 * The breadcrumbs of a path, root first: `/home/me` → `/`, `home`, `me`,
 * each carrying the path it goes up to. Repeated and trailing slashes read
 * as one. A path that is not absolute starts at its first segment.
 */
export function crumbsOf(path: string): Crumb[] {
  const absolute = path.startsWith('/')
  const segments = path.split('/').filter(Boolean)
  const crumbs: Crumb[] = absolute ? [{ label: '/', path: '/' }] : []
  segments.forEach((segment, i) => {
    const joined = segments.slice(0, i + 1).join('/')
    crumbs.push({ label: segment, path: absolute ? `/${joined}` : joined })
  })
  return crumbs
}

/** A folder inside `parent`, as the chooser walks into it. */
export function childPath(parent: string, name: string): string {
  return parent.endsWith('/') ? `${parent}${name}` : `${parent}/${name}`
}

/**
 * How long ago a recent project was used, as the chooser's left column
 * spells it (canvas 50g: `2 h`, `3 d`): `timeAgo` with a space before its
 * unit; nothing when the project has no date.
 */
export function recentAge(lastAt: number | null, now: number): string {
  if (lastAt === null) return ''
  return spacedAgo(lastAt, now)
}
