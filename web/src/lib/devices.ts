/**
 * Settings → Devices' pure derivations (spec 2026-10-16-device-group-design):
 * a member's state wording, its kind and OS, who added it, and the one-word
 * form of a pairing code (canvas 50k).
 */
import { encodePairingCode } from '@orbital/shared/remote/relayApi'
import { timeAgo } from './format'
import { codeLeft } from './remote'
import type { GroupMember, MemberState, RemoteDevice } from './types'

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
 * The member state row's words (canvas 50k MEMBER STATE): the accent dot is
 * drawn elsewhere, this is only the text beside it. `offline` with no
 * `seenAt` (a member never paired here) reads bare, with nothing to date it by.
 */
export function memberStateWords(m: GroupMember, now: number): string {
  switch (m.state) {
    case 'self': return 'this device'
    case 'online': return 'online'
    case 'offline': return m.seenAt === null ? 'offline' : `offline · seen ${timeAgo(m.seenAt, now)} ago`
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
  const selfId = members.find((x) => x.self)?.id
  if (m.addedBy === selfId) return 'added by this device'
  const adder = members.find((x) => x.id === m.addedBy)
  return `added by ${adder ? adder.name : m.addedBy.slice(0, 8)}`
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

/** A row's state in IN THIS GROUP: a member's, or `update` for a phone refused as too old (canvas 50a ROWS). */
export type RowState = Exclude<MemberState, 'self'> | 'update'

/** One row of Settings → Devices' IN THIS GROUP (canvas 50a). */
export interface DeviceRow {
  id: string
  name: string
  kind: string
  os: string
  state: RowState
  /** The words beside the state dot. */
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
    return {
      id: m.id, name: m.name, kind: m.kind, os: m.os,
      state: needsUpdate ? 'update' : m.state === 'self' ? 'online' : m.state,
      words: needsUpdate ? 'needs an update' : memberStateWords(m, now),
      added: addedByLine(m, members),
      addedAt: m.addedAt,
      needsUpdate,
    }
  })
  const unlisted = devices.filter((d) => !listed.has(d.id)).map((d): DeviceRow => {
    const offline = d.lastSeenAt === null ? 'offline' : `offline · seen ${timeAgo(d.lastSeenAt, now)} ago`
    return {
      id: d.id, name: d.name, kind: d.kind ?? 'phone', os: d.platform,
      state: d.needsUpdate ? 'update' : d.online ? 'online' : 'offline',
      words: d.needsUpdate ? 'needs an update' : d.online ? 'online' : offline,
      added: 'added by this device',
      addedAt: d.pairedAt,
      needsUpdate: d.needsUpdate,
    }
  })
  return [...fromRoster, ...unlisted]
}

/** The versions and the time behind `needs an update` (as Settings → Mobile said it, canvas 11c). */
export function needsUpdateLine(needsUpdate: NonNullable<RemoteDevice['needsUpdate']>, now: number): string {
  return `app ${needsUpdate.version} · this device needs ≥ ${needsUpdate.needed} · refused · ${timeAgo(needsUpdate.at, now)}`
}
