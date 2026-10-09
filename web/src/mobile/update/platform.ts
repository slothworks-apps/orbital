import { App } from '@capacitor/app'
import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { Device } from '@capacitor/device'
import { CapacitorUpdater } from '@capgo/capacitor-updater'
import { deviceInfoEvent, statsUrl } from './beam'
import { loadDiagnostics, saveDiagnostics } from './diagnostics'
import { BUILTIN, belowFloor, nextHighWater, parseHighWater, revertTarget } from './guard'
import { stashForRestart, takeRestartStash } from './restartStash'
import { usePhoneUpdate, type DownloadedBundle, type UpdateSource } from './state'

/**
 * The updater plugin (`@capgo/capacitor-updater`) behind `UpdateSource`.
 * Only a release build's shell has it on (mobile/capacitor.config.ts); in any
 * other, and in a browser, everything here but the shell's version does
 * nothing.
 */

// localStorage, not Preferences: a start reads the pending bundle before
// anything awaits (boot installs the push listeners first). Losing either
// costs one more prompt, or a later switch, at most.
/** The last version the user answered (Restart or ×): not offered again. */
const ANSWERED_KEY = 'orbital.update.answered'
/** A bundle left for the next start, as `DownloadedBundle` JSON. */
const PENDING_KEY = 'orbital.update.pending'
/** The replay guard's high-water mark (`guard.ts`), as `HighWater` JSON. */
const HIGH_WATER_KEY = 'orbital.update.highWater'
/** The app version the built-in bundle reported when it last started well. */
const BUILTIN_VERSION_KEY = 'orbital.update.builtinVersion'

const storage = {
  get: (key: string): string | null => {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  // A promise, so that a full or blocked storage rejects rather than throws.
  set: (key: string, value: string | null): Promise<void> =>
    new Promise((resolve) => {
      if (value === null) localStorage.removeItem(key)
      else localStorage.setItem(key, value)
      resolve()
    }),
}

const native = () => Capacitor.isNativePlatform()
const warn = (what: string) => (err: unknown) =>
  console.warn(`[mobile] update: could not ${what}`, err)

const source: UpdateSource = {
  restart: async (bundle) => {
    stashForRestart(bundle.version)
    await storage.set(PENDING_KEY, null)
    try {
      await CapacitorUpdater.set({ id: bundle.id })
    } catch (err) {
      // No reload follows: the drafts are still in memory, and a stash left
      // behind would come back at some later start.
      takeRestartStash()
      throw err
    }
  },
  // Not the plugin's `next()`: that switches the next time the app goes to
  // the background, under the user's feet. The next start does it instead
  // (`switchToPendingBundle`), behind the launch screen.
  later: (bundle) => storage.set(PENDING_KEY, JSON.stringify(bundle)),
  answered: (version) => storage.set(ANSWERED_KEY, version),
}

function parseBundle(raw: string | null): DownloadedBundle | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<DownloadedBundle> | null
    return typeof value?.id === 'string' && typeof value.version === 'string'
      ? { id: value.id, version: value.version }
      : null
  } catch {
    return null
  }
}

/**
 * The first thing a start does: takes the bundle closed with × the last time,
 * if any, dropping it so that one which fails is not tried again. Synchronous,
 * so a start without one awaits nothing.
 */
export function takePendingBundle(): DownloadedBundle | null {
  if (!native()) return null
  const pending = parseBundle(storage.get(PENDING_KEY))
  if (pending) void storage.set(PENDING_KEY, null)
  return pending
}

/**
 * Switches to that bundle while the launch screen still covers the app. True
 * when the app is reloading into it, and nothing else should start.
 */
export async function switchToPendingBundle(pending: DownloadedBundle): Promise<boolean> {
  try {
    const { bundle } = await CapacitorUpdater.current()
    if (bundle.id === pending.id) return false
    await CapacitorUpdater.set({ id: pending.id })
    return true
  } catch (err) {
    warn('switch to the bundle left for this start')(err)
    return false
  }
}

/**
 * The replay guard, before anything else starts (`guard.ts`). True when this
 * bundle must not run: it has already asked the plugin to go back to a good
 * bundle, or, when there is none it can name, it never calls
 * `notifyAppReady()` and the plugin rolls it back by itself.
 */
export async function refuseOldBundle(running: string): Promise<boolean> {
  if (!native()) return false
  const highWater = parseHighWater(storage.get(HIGH_WATER_KEY))
  // The usual start: nothing to await.
  if (!belowFloor(running, highWater)) return false
  try {
    const { bundle } = await CapacitorUpdater.current()
    if (bundle.id === BUILTIN) return false
    const { bundles } = await CapacitorUpdater.list()
    const target = revertTarget({
      highWater,
      bundles,
      currentId: bundle.id,
      builtinVersion: storage.get(BUILTIN_VERSION_KEY),
    })
    console.warn(
      `[mobile] update: refused bundle ${running}, below what this phone has run`,
      target,
    )
    if (target.kind === 'set') await CapacitorUpdater.set({ id: target.id })
    else if (target.kind === 'reset') await CapacitorUpdater.reset()
  } catch (err) {
    warn('leave a refused bundle')(err)
  }
  return true
}

/**
 * Once the app is up: tells the plugin this bundle started, so it is not
 * rolled back, and raises the guard's high-water mark. Called after the
 * first screen rendered without a crash.
 */
export function notifyStarted(running: string): void {
  if (!native()) return
  void (async () => {
    try {
      await CapacitorUpdater.notifyAppReady()
      const { bundle } = await CapacitorUpdater.current()
      if (bundle.id === BUILTIN) await storage.set(BUILTIN_VERSION_KEY, running)
      const next = nextHighWater(parseHighWater(storage.get(HIGH_WATER_KEY)), running, bundle.id)
      if (next) await storage.set(HIGH_WATER_KEY, JSON.stringify(next))
    } catch (err) {
      warn('tell the updater the app started')(err)
    }
  })()
}

type Beam = { url: string; appId: string }

/** Beam as this build knows it (mobile/beam.json). */
const BEAM: Beam = __MOBILE_BEAM__

/**
 * Points the plugin's reports at Beam, or at nothing. The shell's config has
 * `persistModifyUrl`, so the plugin keeps the URL and loads it on the next
 * start before it reports anything; this runs on every start as well, to
 * repair a URL that drifted from the setting.
 */
async function applyDiagnostics(beam: Beam, on: boolean): Promise<void> {
  await CapacitorUpdater.setStatsUrl({ url: on ? statsUrl(beam.url) : '' })
}

/**
 * "Send diagnostics" switched in 9f: stored, then applied to the plugin at
 * once. A shell without the updater refuses the call, which changes nothing.
 */
export async function setDiagnostics(on: boolean): Promise<void> {
  usePhoneUpdate.setState({ diagnostics: on })
  await saveDiagnostics(on)
  if (native()) await applyDiagnostics(BEAM, on).catch(warn('apply Send diagnostics'))
}

/**
 * `allowModifyUrl` lets any script in the WebView move the plugin's URLs,
 * and `persistModifyUrl` keeps them: every start puts the update URL back on
 * Beam and the channel URL back to nothing. A URL moved in between is used
 * until then, and what it serves must still be signed (`guard.ts` for an
 * old one).
 */
async function pinUrls(beam: Beam): Promise<void> {
  await CapacitorUpdater.setUpdateUrl({ url: `${beam.url}/api/updates` })
  await CapacitorUpdater.setChannelUrl({ url: '' })
}

/**
 * Wires the prompt to the plugin, applies "Send diagnostics" and, with it
 * on, sends this start's device_info. Once per start, beside boot.
 */
export async function startUpdates(beam: Beam, running: string): Promise<void> {
  const diagnostics = await loadDiagnostics().catch(() => true)
  usePhoneUpdate.setState({ diagnostics })
  if (!native()) return
  App.getInfo()
    .then((info) => usePhoneUpdate.setState({ shell: info.version }))
    .catch(warn("read the shell's version"))

  try {
    if (!(await CapacitorUpdater.isAutoUpdateEnabled()).enabled) return
    await pinUrls(beam).catch(warn("pin the updater's URLs"))
    await applyDiagnostics(beam, diagnostics).catch(warn('apply Send diagnostics'))
    usePhoneUpdate.getState().connect(source, storage.get(ANSWERED_KEY))
    // `updateAvailable` only: it comes after the plugin has decrypted the
    // bundle and checked its signed checksum. Never act on `downloadComplete`:
    // iOS emits it before the checksum is verified.
    await CapacitorUpdater.addListener('updateAvailable', ({ bundle }) => {
      usePhoneUpdate.getState().downloaded({ id: bundle.id, version: bundle.version }, running)
    })
  } catch (err) {
    warn('listen for updates')(err)
    return
  }
  if (diagnostics) void sendDeviceInfo(beam)
}

async function sendDeviceInfo(beam: Beam): Promise<void> {
  try {
    const [{ deviceId }, current, device] = await Promise.all([
      CapacitorUpdater.getDeviceId(),
      CapacitorUpdater.current(),
      Device.getInfo(),
    ])
    // Native HTTP, as the plugin's own stats go: no CORS, no WebView in between.
    await CapacitorHttp.post({
      url: statsUrl(beam.url),
      headers: { 'Content-Type': 'application/json' },
      data: deviceInfoEvent({
        appId: beam.appId,
        deviceId,
        platform: Capacitor.getPlatform(),
        osVersion: device.osVersion,
        bundleVersion: current.bundle.version,
        nativeVersion: current.native,
        model: device.model,
      }),
    })
  } catch (err) {
    warn('send the device model')(err)
  }
}
