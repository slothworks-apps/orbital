/**
 * Settings → Devices' pure derivations (spec 2026-10-16-device-group-design):
 * a member's state wording, its kind and OS, who added it, and the one-word
 * form of a pairing code (canvas 50k).
 */
import { encodePairingCode } from '@orbital/shared/remote/relayApi'
import { timeAgo } from './format'
import { codeLeft } from './remote'
import type { GroupMember } from './types'

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
 * `added by <name>` using the adder's roster name, read off `members`
 * (which the removed ones have already left, as the status lists them). An
 * adder no longer in the group is named by the first 8 characters of its id
 * — the same cut the log lines use. Null for the device that started the
 * group: it was not added by anyone else to say.
 */
export function addedByLine(m: GroupMember, members: GroupMember[]): string | null {
  if (m.self && m.addedBy === m.id) return null
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
