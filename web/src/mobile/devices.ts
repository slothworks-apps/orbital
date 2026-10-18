/**
 * Settings → Devices on the phone (canvas 50i): the rows of IN THIS GROUP,
 * read through the desktop's own derivations (`lib/devices`) and worded as
 * the phone's canvas words them.
 */
import { linksWith, type MemberRow } from '@orbital/shared/remote/group'
import { codeLeft } from '../lib/remote'
import { deviceRows, kindOs, type RowState } from '../lib/devices'
import type { GroupMember, RemoteDevice } from '../lib/types'
import type { DeviceView } from './state'

/** One row of IN THIS GROUP, and the sheet a tap opens. */
export interface PhoneRow {
  id: string
  name: string
  kind: string
  /** The dot beside the state words; none for a phone paired with another member. */
  state: RowState
  /** The second line: `online`, `asleep · seen 2 h ago`, `not linked`… */
  words: string
  /** The quiet third line: `desktop · macOS`. */
  kindOs: string
  /** The group's primary: the PRIMARY label beside its name (canvas 50i). */
  primary: boolean
  /** When it joined the group, for the sheet's `joined`; null for a device the roster does not list. */
  joinedAt: number | null
}

/**
 * Every member but this phone, in roster order, then every paired device
 * the roster does not list — a Mac from before groups, which never sends
 * one (canvas 50i). A member the phone hears refuse it as too old (`bye
 * protocol`, or older than the phone's floor) reads `update Orbital on
 * <name>`. Where the desktop says offline the phone says asleep, and this
 * phone is `this phone`. A phone is never primary, so a member not linked
 * reads `not linked`, with no pairing by hand (canvas 50i `st2`).
 */
export function phoneRows(members: MemberRow[], devices: DeviceView[], now: number): PhoneRow[] {
  const tooOld = new Set(devices.filter((d) => d.refused?.cause === 'mac').map((d) => d.id))
  const group: GroupMember[] = members.map((m) => ({ ...m, tooOld: !m.self && tooOld.has(m.id) }))
  const paired: RemoteDevice[] = devices.map((d) => ({
    id: d.id, name: d.name, platform: d.os, kind: d.kind, pairedAt: 0, lastSeenAt: d.asOf, online: d.online,
    needsUpdate: null,
  }))
  return deviceRows(group, paired, now, false).map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    state: tooOld.has(row.id) ? 'update' : row.state,
    words: tooOld.has(row.id)
      ? `update Orbital on ${row.name}`
      : row.words.replace(/^offline\b/, 'asleep').replace(/ this device$/, ' this phone'),
    kindOs: kindOs(row.kind, row.os),
    primary: row.primary,
    joinedAt: row.member ? row.addedAt : null,
  }))
}

/** This phone's code's countdown (canvas 50i `p3Left`, `p3Bar`): the line under the bar, and the bar's fill. */
export function ownCodeLeft(expiresAt: number, now: number): { line: string; fraction: number; expired: boolean } {
  const left = codeLeft(expiresAt, now)
  return {
    line: left.expired ? 'expired · make a new code' : `expires in ${left.label} · one device per code`,
    fraction: left.fraction,
    expired: left.expired,
  }
}

/**
 * Whether removing `id` leaves this phone with no device to reach: no other
 * member it links with (never another phone, `linksWith`) or is paired
 * with, and no other paired device. A group of one shows nothing on a phone, so that removal is a leave.
 */
export function removalLeavesAlone(members: MemberRow[], devices: DeviceView[], id: string): boolean {
  const others = members.some((m) => !m.self && m.id !== id && (linksWith('phone', m) || m.linked))
  const unlisted = devices.some((d) => d.id !== id && !members.some((m) => m.id === d.id))
  return !others && !unlisted
}
