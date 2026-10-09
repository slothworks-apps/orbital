import { compareVersions } from '@orbital/shared/remote/version'

/**
 * The replay guard (ADR an-ota-bundle-runs-only-if-signed-by-ci → Residual
 * risk). A bundle's signature is not bound to its version, so a compromised
 * Beam could serve an older signed bundle — one with a fixed hole — under a
 * newer name. Every bundle from 0.8.0 on runs this first: a downloaded bundle
 * whose own version is below the highest this phone has run, or below
 * `MIN_APP_VERSION`, does not start; the app goes back to the newest good
 * bundle it knows.
 *
 * The built-in bundle is exempt: it comes with the store binary, not from
 * Beam, and refusing it could leave no bundle to run.
 */

/**
 * Raised with a security fix, to the first version that has it: older
 * bundles then refuse to run even on a phone that never ran the fixed one.
 * Never above `version` in mobile/package.json (mobileupdate.test.ts).
 */
export const MIN_APP_VERSION = '0.8.0'

/** The highest app version this phone has run, and the bundle it ran in. */
export interface HighWater {
  version: string
  /** The plugin's bundle id; `builtin` for the bundle in the store binary. */
  bundleId: string
}

export const BUILTIN = 'builtin'

export function parseHighWater(raw: string | null): HighWater | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<HighWater> | null
    return typeof value?.version === 'string' && typeof value.bundleId === 'string'
      ? { version: value.version, bundleId: value.bundleId }
      : null
  } catch {
    return null
  }
}

/** The lowest version a downloaded bundle may be. */
export function floorVersion(highWater: HighWater | null, min: string = MIN_APP_VERSION): string {
  return highWater && compareVersions(highWater.version, min) > 0 ? highWater.version : min
}

/** Whether a bundle of version `running` may start at all, before anything else is known. */
export function belowFloor(
  running: string,
  highWater: HighWater | null,
  min: string = MIN_APP_VERSION,
): boolean {
  return compareVersions(running, floorVersion(highWater, min)) < 0
}

/** The mark after `running` started well in bundle `bundleId`: it only goes up. */
export function nextHighWater(
  stored: HighWater | null,
  running: string,
  bundleId: string,
): HighWater | null {
  if (stored && compareVersions(running, stored.version) <= 0) return null
  return { version: running, bundleId }
}

export interface KnownBundle {
  id: string
  status: string
}

export type Revert = { kind: 'set'; id: string } | { kind: 'reset' } | { kind: 'wait' }

/**
 * Where a refused bundle goes: back to the bundle the high-water mark ran in
 * while the plugin still holds it and has not marked it bad; to the built-in
 * bundle when that is the one, or when the built-in bundle's own version is
 * known to reach the floor; otherwise nowhere — the refused bundle never
 * calls `notifyAppReady()`, and the plugin rolls it back by itself.
 */
export function revertTarget(input: {
  highWater: HighWater | null
  bundles: readonly KnownBundle[]
  currentId: string
  /** The app version the built-in bundle reported when it last ran; null if never. */
  builtinVersion: string | null
  min?: string
}): Revert {
  const { highWater, bundles, currentId, builtinVersion } = input
  const floor = floorVersion(highWater, input.min)
  const good = (status: string) => status === 'success' || status === 'pending'
  if (highWater && highWater.bundleId !== currentId) {
    if (highWater.bundleId === BUILTIN) return { kind: 'reset' }
    const kept = bundles.find((b) => b.id === highWater.bundleId)
    if (kept && good(kept.status)) return { kind: 'set', id: kept.id }
  }
  if (currentId !== BUILTIN && builtinVersion && compareVersions(builtinVersion, floor) >= 0) {
    return { kind: 'reset' }
  }
  return { kind: 'wait' }
}
