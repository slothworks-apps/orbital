import { useAppUpdate } from '../store/appUpdate'
import type { UpdateAction, UpdateBridge, UpdatePrompt, UpdateState } from './desktop'

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
 *                       { version?, n?, percent?, mb? })
 *
 * The buttons move it the way main would, roughly; Check now answers
 * "up to date".
 */

type DemoName = 'avail' | 'dl' | 'one' | 'two' | 'wait' | 'closed' | 'none'
type DemoOptions = { version?: string; n?: number; percent?: number; mb?: number }

export function installUpdateDemo(): void {
  let opts: Required<DemoOptions> = { version: '0.26.0', n: 2, percent: 42, mb: 131 }
  let checkedAt = Date.now() - 2 * 60 * 60 * 1000
  let listener: (state: UpdateState) => void = () => {}
  let current: UpdateState = { phase: 'none', checkedAt }

  const prompt = (name: DemoName): UpdatePrompt => {
    const { version, n, percent, mb } = opts
    switch (name) {
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

  const show = (next: UpdatePrompt) => {
    current = { ...next, checkedAt }
    listener(current)
  }

  const set = (name: DemoName, options: DemoOptions = {}) => {
    opts = { ...opts, ...options }
    show(prompt(name))
  }

  const act = (action: UpdateAction) => {
    const next: Record<UpdateAction, () => UpdatePrompt> = {
      download: () => ({ phase: 'downloading', version: opts.version, percent: 0, totalMB: opts.mb }),
      skip: () => ({ phase: 'none' }),
      ok: () => ({ phase: 'none' }),
      close: () => prompt('closed'),
      'restart-now': () => ({ phase: 'restarting', version: opts.version }),
      'restart-when-idle': () =>
        opts.n === 0 ? { phase: 'restarting', version: opts.version } : prompt('wait'),
      'cancel-wait': () => prompt('two'),
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
}
