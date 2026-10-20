import { showWhatsNewDemo } from '../panels/WhatsNew'
import { useAppUpdate } from '../store/appUpdate'
import type { UpdateAction, UpdateBridge, UpdateExtras, UpdatePrompt, UpdateState } from './desktop'

/**
 * A stand-in for the desktop app's update bridge, for checking the UPDATE
 * notice and Settings › Updates against the canvas in a plain browser
 * (`Feature - App update`). Never in a release: `main.tsx` imports this only
 * in a dev server, or in a build made with `VITE_ORBITAL_UPDATE_DEMO=1`, and
 * only with `?update-demo` in the URL.
 *
 * Drive it from the console or Playwright:
 *
 *   __orbitalUpdateDemo('avail' | 'dl' | 'one' | 'two' | 'wait' | 'closed' | 'none',
 *                       { version?, n?, percent?, mb?, by? })
 *
 * and an update another member started (canvas 50v): 'remote-dl',
 * 'remote-wait' (Update when sessions finish), 'remote-wait-dl' (the same
 * while it still downloads), 'remote-last', 'remote-busy' (a session started
 * here), 'receipt' (after the restart: WHAT'S NEW with who updated this Mac
 * heading it).
 *
 *   __orbitalWhatsNew()
 *
 * shows WHAT'S NEW for the running version as after a local update, whatever
 * this Mac remembers (`panels/WhatsNew`).
 *
 * The buttons move it the way main would, roughly; Check now answers
 * "up to date".
 */

type DemoName =
  | 'avail' | 'dl' | 'one' | 'two' | 'wait' | 'closed' | 'none'
  | 'remote-dl' | 'remote-wait' | 'remote-wait-dl' | 'remote-last' | 'remote-busy' | 'receipt'
type DemoOptions = { version?: string; n?: number; percent?: number; mb?: number; by?: string }
type DemoState = UpdatePrompt & UpdateExtras

export function installUpdateDemo(): void {
  let opts: Required<DemoOptions> = { version: '0.26.0', n: 2, percent: 42, mb: 131, by: 'Pixel 8' }
  let checkedAt = Date.now() - 2 * 60 * 60 * 1000
  let listener: (state: UpdateState) => void = () => {}
  let current: UpdateState = { phase: 'none', checkedAt }

  const prompt = (name: DemoName): DemoState => {
    const { version, n, percent, mb, by } = opts
    switch (name) {
      case 'remote-dl':
        return { phase: 'downloading', version, percent, totalMB: mb, remote: { by, working: n } }
      case 'remote-wait':
        return { phase: 'waiting', version, workingCount: n, remote: { by, working: n, wait: true } }
      case 'remote-wait-dl':
        return { phase: 'downloading', version, percent, totalMB: mb, remote: { by, working: n, wait: true } }
      case 'remote-last':
        return { phase: 'restarting', version, remote: { by, working: n } }
      case 'remote-busy':
        return { phase: 'ready', version, workingCount: n, buttons: 'two', sessionStarted: true }
      case 'receipt':
        return { phase: 'none', receipt: { by, at: Date.now(), stopped: n, version } }
      case 'avail':
        return { phase: 'available', version, totalMB: mb }
      case 'dl':
        return { phase: 'downloading', version, percent, totalMB: mb }
      case 'one':
        return { phase: 'ready', version, workingCount: n, buttons: 'one' }
      case 'two':
        return { phase: 'ready', version, workingCount: n, buttons: 'two' }
      case 'wait':
        return { phase: 'waiting', version, workingCount: n }
      case 'closed':
        return { phase: 'closed', version }
      case 'none':
        return { phase: 'none' }
    }
  }

  const show = (next: DemoState) => {
    current = { ...next, checkedAt }
    listener(current)
  }

  const set = (name: DemoName, options: DemoOptions = {}) => {
    opts = { ...opts, ...options }
    show(prompt(name))
  }

  const act = (action: UpdateAction) => {
    const next: Record<UpdateAction, () => DemoState> = {
      download: () => ({ phase: 'downloading', version: opts.version, percent: 0, totalMB: opts.mb }),
      skip: () => ({ phase: 'none' }),
      ok: () => ({ phase: 'none' }),
      close: () => prompt('closed'),
      'restart-now': () => ({ phase: 'restarting', version: opts.version }),
      'restart-when-idle': () =>
        opts.n === 0 ? { phase: 'restarting', version: opts.version } : prompt('wait'),
      // A member's wait cancelled while it downloads goes on as this Mac's own download.
      'cancel-wait': () => (current.phase === 'downloading' ? prompt('dl') : prompt('two')),
      'receipt-close': () => ({ phase: 'none' }),
    }
    show(next[action]())
  }

  const bridge: UpdateBridge = {
    onUpdateState: (cb) => {
      listener = cb
    },
    getUpdateState: () => Promise.resolve(current),
    updateAction: act,
    checkForUpdates: async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
      checkedAt = Date.now()
      show(current)
      return { kind: 'up-to-date' }
    },
  }

  useAppUpdate.getState().connect(bridge)
  ;(window as { __orbitalUpdateDemo?: typeof set }).__orbitalUpdateDemo = set
  ;(window as { __orbitalWhatsNew?: () => void }).__orbitalWhatsNew = showWhatsNewDemo
}
