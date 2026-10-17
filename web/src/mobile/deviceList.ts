/**
 * The session list and New session across the group, on the phone (canvas
 * 50j): a chip per device that hosts sessions, asleep per device, and the
 * device a new session runs on. Read through the desktop's own chip and
 * option rules (`lib/devices`); the phone lists no device of its own.
 */
import { create } from 'zustand'
import type { MemberRow } from '@orbital/shared/remote/group'
import { agoWords, kindOs, memberStateWords, openingDevice, type DeviceChip, type DeviceOption } from '../lib/devices'
import { isListable } from '../lib/harnessSession'
import type { ApiSession } from '../lib/types'
import { isMacAsleep, type MobileState } from './state'

type DeviceState = Pick<MobileState, 'link' | 'rechecking' | 'devices'>

/**
 * Whether device `id` is asleep: the relay is up and says it is away, and
 * it neither refused this app nor has a live channel. A relay link still
 * coming up says nothing about any device; while a check runs the answer
 * from before it holds (`isMacAsleep`'s rule, per device).
 */
export function deviceAsleep(state: DeviceState, id: string): boolean {
  if (state.rechecking) return state.rechecking.asleepIds?.includes(id) ?? state.rechecking.asleep
  if (state.link !== 'online') return false
  const device = state.devices.find((d) => d.id === id)
  return device !== undefined && !device.online && !device.ready && device.refused === null
}

/** The ids of every device asleep now, which a check holds while it runs. */
export function asleepDevices(state: DeviceState): string[] {
  return state.devices.filter((d) => deviceAsleep({ ...state, rechecking: null }, d.id)).map((d) => d.id)
}

/**
 * Whether the device a session runs on is asleep. A session whose device
 * the phone does not know (no `machine`, or one no source names) is judged
 * by the whole group, as before there was one.
 */
export function sessionAsleep(state: DeviceState & Pick<MobileState, 'macOnline'>, deviceId: string | null): boolean {
  if (deviceId === null || !state.devices.some((d) => d.id === deviceId)) return isMacAsleep(state)
  return deviceAsleep(state, deviceId)
}

/** Whether requests about a session go through now: its device's channel is up; with the device unknown, any. */
export function sessionReady(state: Pick<MobileState, 'ready' | 'devices'>, deviceId: string | null): boolean {
  const device = deviceId === null ? undefined : state.devices.find((d) => d.id === deviceId)
  return device ? device.ready : state.ready
}

/** A chip of the list's device row (canvas 50j `jChips`): the desktop's, with how many sessions it holds. */
export type PhoneChip = DeviceChip & { count: number }

type Counted = Pick<ApiSession, 'machine' | 'status' | 'purpose'>

/**
 * One chip per device that hosts sessions — the federation's sources, so
 * never this phone or another phone — in their order: half opacity asleep,
 * `update` when its Orbital is too old for this app, and the count of its
 * sessions that have not ended.
 */
export function phoneChips(state: DeviceState, sessions: readonly Counted[]): PhoneChip[] {
  return state.devices.map((d) => ({
    id: d.id, label: d.name, name: d.name, kind: d.kind,
    offline: deviceAsleep(state, d.id),
    update: d.refused?.cause === 'mac',
    count: sessions.filter((s) => s.machine?.id === d.id && s.status !== 'ended' && isListable(s)).length,
  }))
}

/**
 * The sessions of the devices that are on. A session no chip names (no
 * `machine`, or a device gone from the group) is kept: hiding it would hide
 * it for good.
 */
export function onDevices<S extends Pick<ApiSession, 'machine'>>(sessions: readonly S[], chips: DeviceChip[], on: string[]): S[] {
  const off = new Set(chips.filter((c) => !on.includes(c.id)).map((c) => c.id))
  if (off.size === 0) return [...sessions]
  return sessions.filter((s) => !s.machine || !off.has(s.machine.id))
}

/** One compact card above the list (canvas 50j ASLEEP, PER DEVICE). */
export interface AsleepCard {
  id: string
  name: string
  /** `showing what it last sent · as of 2 h ago`; without the date when there is none. */
  line: string
}

/** A card per asleep device whose chip is on, in chip order. */
export function asleepCards(state: DeviceState, chips: DeviceChip[], on: string[], now: number): AsleepCard[] {
  return chips
    .filter((c) => c.offline && on.includes(c.id))
    .map((c) => {
      const asOf = state.devices.find((d) => d.id === c.id)?.asOf ?? null
      const line = asOf === null ? 'showing what it last sent' : `showing what it last sent · as of ${agoWords(asOf, now)}`
      return { id: c.id, name: c.name, line }
    })
}

/**
 * Why a source cannot take a new session now, or null when it can: too old
 * for this app or this app too old for it, asleep, or its channel still
 * coming up.
 */
function inertReason(state: DeviceState, d: MobileState['devices'][number], now: number): string | null {
  if (d.refused?.cause === 'mac') return `update Orbital on ${d.name}`
  if (d.refused) return 'needs a newer app on this phone'
  if (deviceAsleep(state, d.id)) return d.asOf === null ? 'asleep' : `asleep · seen ${agoWords(d.asOf, now)}`
  if (!d.ready) return 'linking…'
  return null
}

/**
 * New session's devices (canvas 50j `kOpts`): every source, then every
 * other member of the roster that could host one but is not paired here
 * yet — linking, or to be paired by hand. Only a source that is up can take
 * a session; the rest are listed inert, their reason as the sub-line.
 */
export function phoneDeviceOptions(state: DeviceState, members: readonly MemberRow[], now: number): DeviceOption[] {
  const sources = new Set(state.devices.map((d) => d.id))
  const options: DeviceOption[] = state.devices.map((d) => {
    const reason = inertReason(state, d, now)
    return { id: d.id, label: d.name, name: d.name, kind: d.kind, sub: reason ?? kindOs(d.kind, d.os), inert: reason !== null }
  })
  for (const m of members) {
    if (m.self || m.kind === 'phone' || sources.has(m.id)) continue
    options.push({
      id: m.id, label: m.name, name: m.name, kind: m.kind,
      sub: memberStateWords({ ...m, tooOld: false }, now), inert: true,
    })
  }
  return options
}

/**
 * The device New session opens on: the one the last session started from
 * this phone went to while it can take one, else the first that can, else
 * the first listed; null with none.
 */
export function phoneOpeningDevice(options: DeviceOption[], remembered: string | null): string | null {
  const id = openingDevice(options, remembered)
  return options.some((o) => o.id === id) ? id : (options[0]?.id ?? null)
}

/**
 * The device the last launch from this phone went to. In localStorage
 * rather than with the group: an id means something only to this phone.
 */
const LAST_DEVICE_KEY = 'orbital.newSession.device'

export function rememberedDevice(): string | null {
  try {
    return globalThis.localStorage?.getItem(LAST_DEVICE_KEY) ?? null
  } catch {
    return null
  }
}

export function rememberDevice(id: string): void {
  try {
    globalThis.localStorage?.setItem(LAST_DEVICE_KEY, id)
  } catch {
    // A lost default costs the next New session its device, nothing else.
  }
}

/** The chips turned off on the list; kept while the app runs, so opening a session keeps the choice. */
export const useDeviceFilter = create<{ hidden: string[]; setHidden: (hidden: string[]) => void }>()((set) => ({
  hidden: [],
  setHidden: (hidden) => set({ hidden }),
}))
