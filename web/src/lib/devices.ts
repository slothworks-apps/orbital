/**
 * Settings → Devices' pure derivations (spec 2026-10-16-device-group-design):
 * a member's state wording, its kind and OS, who added it, and the one-word
 * form of a pairing code (canvas 50k); and the map's and sidebar's device
 * chips and filter (canvas 50e).
 */
import { encodePairingCode } from '@orbital/shared/remote/relayApi'
import { timeAgo } from './format'
import { codeLeft } from './remote'
import type { ApiSession, GroupMember, MachineRef, MemberState, RemoteDevice } from './types'

/**
 * The three known device kinds read as is; an unrecognised one passes
 * through verbatim (canvas 50k). `string & {}` rather than a bare `string`
 * keeps the three literals as autocomplete without the union collapsing.
 */
export function kindWord(kind: string): 'desktop' | 'headless' | 'phone' | (string & {}) {
  return kind
}

const OS_LABELS: Record<string, string> = {
  macos: 'macOS', linux: 'Linux', ios: 'iOS', android: 'Android',
}

/** An OS as a roster entry names it, worded for people (canvas 50k "WORDING"); unknown passes through as is. */
export function osLabel(os: string): string {
  return OS_LABELS[os] ?? os
}

/** `desktop · macOS` (canvas 50k); the OS half drops with its separator while it is not known yet. */
export function kindOs(kind: string, os: string): string {
  const label = osLabel(os)
  return label === '' ? kindWord(kind) : `${kindWord(kind)} · ${label}`
}

/**
 * `offline`, dated by `seenAt` when there is one: `seen just now` inside
 * `timeAgo`'s first minute, `seen <date>` once it answers with a date, and
 * `seen <n> ago` between them.
 */
function offlineWords(seenAt: number | null, now: number): string {
  if (seenAt === null) return 'offline'
  const ago = timeAgo(seenAt, now)
  if (ago === 'now') return 'offline · seen just now'
  return /^\d+[mhd]$/.test(ago) ? `offline · seen ${ago} ago` : `offline · seen ${ago}`
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

/**
 * The row's second line (canvas 50k `devRow`): `started the group` for the
 * one member no one added (`addedBy` names itself); otherwise `added by
 * <name>`, `this device` when the adder is the device reading the list
 * (found by the `self` entry in `members`, there being exactly one), its
 * roster name when the adder is some other live member, or the first 8
 * characters of its id when the adder has since left the group.
 */
export function addedByLine(m: GroupMember, members: GroupMember[]): string {
  if (m.addedBy === m.id) return 'started the group'
  return `added by ${adderName(m, members)}`
}

/** Who added `m`, as `addedByLine` names it: `this device`, a live member's name, or a short id. */
function adderName(m: GroupMember, members: GroupMember[]): string {
  const selfId = members.find((x) => x.self)?.id
  if (m.addedBy === selfId) return 'this device'
  const adder = members.find((x) => x.id === m.addedBy)
  return adder ? adder.name : m.addedBy.slice(0, 8)
}

/**
 * A phone paired with another member: it does not link and is not paired
 * here, so the relay's presence says nothing about it here. Only a phone: a
 * desktop or server in that state is a member still on its way to linking
 * (or the ghost of a cancelled join), and keeps its own state words.
 */
function pairedElsewhere(m: GroupMember): boolean {
  return !m.self && m.kind === 'phone' && !m.links && !m.linked
}

/** The QR's JSON as one word to paste (`encodePairingCode`, shared with the phone's own paste box). */
export function oneWordCode(qrJson: string): string {
  return encodePairingCode(qrJson)
}

/** A joining code's remaining time and whether it has run out — `codeLeft` without the draining bar's fraction. */
export function codeTimeLeft(expiresAt: number, now: number): { label: string; expired: boolean } {
  const { label, expired } = codeLeft(expiresAt, now)
  return { label, expired }
}

/**
 * A row's state in IN THIS GROUP: a member's, `update` for a phone refused
 * as too old (canvas 50a ROWS), or `elsewhere` for a phone paired with
 * another member, which has no presence here and so no dot.
 */
export type RowState = Exclude<MemberState, 'self'> | 'update' | 'elsewhere'

/** One row of Settings → Devices' IN THIS GROUP (canvas 50a). */
export interface DeviceRow {
  id: string
  name: string
  kind: string
  os: string
  state: RowState
  /** The words beside the state dot (no dot while `elsewhere`). */
  words: string
  /** The quiet second line: who added it. */
  added: string
  addedAt: number
  /** What the refusal said, while `state` is `update`. */
  needsUpdate: RemoteDevice['needsUpdate']
}

/**
 * The rows under IN THIS GROUP: every member but this device, then every
 * paired device the roster does not list yet (a phone paired before the
 * roster existed; this device paired it, and the relay's presence says
 * whether it is online). A paired device this server refused as too old
 * reads `needs an update` whatever its presence says — the relay may still
 * count it online.
 */
export function deviceRows(members: GroupMember[], devices: RemoteDevice[], now: number): DeviceRow[] {
  const paired = new Map(devices.map((d) => [d.id, d]))
  const listed = new Set(members.map((m) => m.id))
  const fromRoster = members.filter((m) => !m.self).map((m): DeviceRow => {
    const needsUpdate = paired.get(m.id)?.needsUpdate ?? null
    const elsewhere = !needsUpdate && pairedElsewhere(m)
    return {
      id: m.id, name: m.name, kind: m.kind, os: m.os,
      state: needsUpdate ? 'update' : elsewhere ? 'elsewhere' : m.state === 'self' ? 'online' : m.state,
      words: needsUpdate ? 'needs an update'
        : elsewhere ? `paired with ${adderName(m, members)}` : memberStateWords(m, now),
      added: addedByLine(m, members),
      addedAt: m.addedAt,
      needsUpdate,
    }
  })
  const unlisted = devices.filter((d) => !listed.has(d.id)).map((d): DeviceRow => ({
    id: d.id, name: d.name, kind: d.kind ?? 'phone', os: d.platform,
    state: d.needsUpdate ? 'update' : d.online ? 'online' : 'offline',
    words: d.needsUpdate ? 'needs an update' : d.online ? 'online' : offlineWords(d.lastSeenAt, now),
    added: 'added by this device',
    addedAt: d.pairedAt,
    needsUpdate: d.needsUpdate,
  }))
  return [...fromRoster, ...unlisted]
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
  const ago = timeAgo(machine.asOf, now)
  return `as of ${ago.replace(/^(\d+)([mhd])$/, '$1 $2')}`
}
