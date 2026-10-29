import {
  FIVE_HOUR_PACE_LOOKBACK_MS,
  groupLimitsByAccount,
  limitsReadingStale,
  WEEKLY_PACE_LOOKBACK_MS,
  type LimitsAccountGroup,
} from '@orbital/shared/limits'
import { claudeDirDisplayPath, claudeDirMonograms } from '../lib/claudeDirs'
import { deviceOf, LOCAL_DEVICE } from '../lib/devices'
import type { EstimateLine } from '../lib/limits'
import type { ClaudeDirInfo, ClaudeDirLimits, RemoteStatus } from '../lib/types'

/**
 * The limits page by account (spec 2026-10-20-limit-suns-design § 1, § 3;
 * canvas `Feature - Limit sun` 60c): what each account's head says, and the
 * words of the run-out estimate. Pure, so Settings → Appearance can list the same
 * accounts the page does.
 */

/** `max` → `Max`, `pro` → `Pro`, any other plan capitalised; null when unknown. */
export function planLabel(plan: string | null | undefined): string | null {
  const p = plan?.trim()
  if (!p) return null
  return p.charAt(0).toUpperCase() + p.slice(1)
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** A lookback in words, as the AT THIS PACE card says it: `the last hour`, `the last day`, `the last 30 minutes`. */
export function lookbackWords(ms: number): string {
  const unit = (n: number, one: string) => (n === 1 ? one : `${n} ${one}s`)
  if (ms >= DAY_MS && ms % DAY_MS === 0) return `the last ${unit(ms / DAY_MS, 'day')}`
  if (ms >= HOUR_MS && ms % HOUR_MS === 0) return `the last ${unit(ms / HOUR_MS, 'hour')}`
  return `the last ${unit(Math.max(1, Math.round(ms / MINUTE_MS)), 'minute')}`
}

/** The AT THIS PACE card (60c), its lookbacks read off the server's constants. */
export function paceExplanation(): string {
  return (
    `Each estimate comes from how fast the window filled recently: ${lookbackWords(FIVE_HOUR_PACE_LOOKBACK_MS)} ` +
    `for the 5-hour window, ${lookbackWords(WEEKLY_PACE_LOOKBACK_MS)} for the weekly ones. It's shown only when ` +
    `the window would run out before it resets. Otherwise the row says it lasts until the reset.`
  )
}

/**
 * The estimate line's words (60c): `before`, the time in bright ink, `after`.
 * `lit` is the brighter ink of a line that names a time.
 */
export interface EstimateWords {
  before: string
  at: string
  after: string
  lit: boolean
}

export function estimateWords(line: EstimateLine): EstimateWords {
  switch (line.kind) {
    case 'stale':
      return { before: 'no estimate · reading is out of date', at: '', after: '', lit: false }
    case 'lasts':
      return { before: 'lasts until the reset', at: '', after: '', lit: false }
    case 'runs':
      return { before: 'runs out ', at: line.at, after: ' at this pace', lit: true }
    case 'ran':
      return { before: 'ran out at ', at: line.at, after: '', lit: true }
  }
}

/** One directory an account covers, as its head lists it. */
export interface AccountDir {
  /** Unique across devices: the machine id (`self` here) and the directory id. */
  key: string
  name: string
  /** `~/.claude-work`; null for another member's, whose path this device does not know. */
  path: string | null
  /** The directory's monogram, among the directories of its own device (the planets' marks). */
  mono: string
  /** 44a: a directory of this device missing on disk. */
  missing: boolean
}

/** One device an account covers. */
export interface AccountDevice {
  id: string
  name: string
  kind: string
}

/** This device's name in an account's head when the group has none for it. */
export const UNNAMED_THIS_DEVICE = 'this device'

/** One device of an account's head (60c), with the account's directories on it; this device's id is `LOCAL_DEVICE`. */
export interface AccountDeviceDirs extends AccountDevice {
  dirs: AccountDir[]
}

/** One account's group on the page. */
export interface AccountView {
  group: LimitsAccountGroup<ClaudeDirLimits>
  /** The heading: the e-mail, else the directory's name. */
  title: string
  plan: string | null
  /** Out of date by `limitsReadingStale`: the estimate is hidden and the read line says so. */
  stale: boolean
  dirs: AccountDir[]
  /** The devices with their directories, once the page spans two devices; empty before. */
  devices: AccountDeviceDirs[]
}

/**
 * Every account's view, in the snapshot's order. Each device's directories
 * are given monograms among themselves, so a tile reads as that device's
 * planets do. The devices, each with its directories, are listed only once
 * the page spans more than one device; this device's name is `thisDevice`'s.
 */
export function accountViews(
  dirs: readonly ClaudeDirLimits[],
  input: { dirInfo: readonly ClaudeDirInfo[] | null; self: AccountDevice | null; now: number },
): AccountView[] {
  const byDevice = new Map<string, ClaudeDirLimits[]>()
  for (const d of dirs) {
    const id = deviceOf(d)
    byDevice.set(id, [...(byDevice.get(id) ?? []), d])
  }
  const monograms = new Map([...byDevice].map(([id, list]) => [id, claudeDirMonograms(list)]))
  const severalDevices = byDevice.size >= 2

  return groupLimitsByAccount(dirs).map((group) => {
    const reading = group.reading
    const accountDirs = group.entries.map((e) => {
      const device = deviceOf(e)
      const info = e.machine ? undefined : input.dirInfo?.find((i) => i.id === e.id)
      const dir: AccountDir = {
        key: `${device}:${e.id}`,
        name: e.name,
        path: info ? claudeDirDisplayPath(info.path) : null,
        mono: monograms.get(device)?.get(e.id) ?? '?',
        missing: info?.exists === false,
      }
      return { device, dir }
    })
    const on = (device: string) => accountDirs.filter((d) => d.device === device).map((d) => d.dir)
    const devices: AccountDeviceDirs[] = []
    if (severalDevices) {
      if (group.local) {
        devices.push({ ...(input.self ?? { id: LOCAL_DEVICE, name: UNNAMED_THIS_DEVICE, kind: 'desktop' }), dirs: on(LOCAL_DEVICE) })
      }
      for (const m of group.machines) {
        const kind = group.entries.find((e) => e.machine?.id === m.id)?.machine?.kind ?? 'desktop'
        devices.push({ id: m.id, name: m.name, kind, dirs: on(m.id) })
      }
    }
    return {
      group,
      title: group.account ?? reading.name,
      plan: planLabel(reading.plan ?? group.entries.find((e) => e.plan)?.plan),
      stale: limitsReadingStale(reading, input.now),
      dirs: accountDirs.map((d) => d.dir),
      devices,
    }
  })
}

/**
 * This device as the device chips name it (`deviceChips`): the roster's own
 * entry, else the name the remote gives this Mac; null with neither.
 */
export function thisDevice(remote: Pick<RemoteStatus, 'macName' | 'group'> | null): AccountDevice | null {
  const self = remote?.group?.members.find((m) => m.self)
  if (self?.name) return { id: 'self', name: self.name, kind: self.kind }
  return remote?.macName ? { id: 'self', name: remote.macName, kind: 'desktop' } : null
}

/** The keys of the accounts that get a sun, and so a colour: those with plan windows, in order. */
export function sunAccountKeys(views: readonly AccountView[]): string[] {
  return views.filter((v) => v.group.reading.tracked).map((v) => v.group.key)
}
