import { App } from '@capacitor/app'
import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { Device } from '@capacitor/device'
import { CapacitorUpdater } from '@capgo/capacitor-updater'
import { deviceInfoEvent, statsUrl } from './beam'
import { loadDiagnostics, saveDiagnostics } from './diagnostics'
import { stashForRestart } from './restartStash'
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
    await CapacitorUpdater.set({ id: bundle.id })
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
 * Once the app is up: tells the plugin this bundle started, so it is not
 * rolled back. Called after the first screen rendered without a crash.
 */
export function notifyStarted(): void {
  if (!native()) return
  CapacitorUpdater.notifyAppReady().catch(warn('tell the updater the app started'))
}

type Beam = { url: string; appId: string }

/**
 * Points the plugin's reports at Beam, or at nothing. The shell's config has
 * `persistModifyUrl`, so the plugin keeps the URL and loads it on the next
 * start before it reports anything; this runs on every start as well, to
 * repair a URL that drifted from the setting.
 */
async function applyDiagnostics(beam: Beam, on: boolean): Promise<void> {
  await CapacitorUpdater.setStatsUrl({ url: on ? statsUrl(beam.url) : '' })
}

/** Set once the updater is known to be on; only then is there a stats URL to change. */
let beamForSettings: Beam | null = null

/** "Send diagnostics" switched in 9f: stored, then applied to the plugin at once. */
export async function setDiagnostics(on: boolean): Promise<void> {
  usePhoneUpdate.setState({ diagnostics: on })
  await saveDiagnostics(on)
  if (native() && beamForSettings) await applyDiagnostics(beamForSettings, on)
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
    beamForSettings = beam
    await applyDiagnostics(beam, diagnostics).catch(warn('apply Send diagnostics'))
    usePhoneUpdate.getState().connect(source, storage.get(ANSWERED_KEY))
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
