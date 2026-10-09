import { usePhoneUpdate, type UpdateSource } from './state'

/**
 * A stand-in for the updater plugin, for checking the phone's UPDATE notice,
 * the restart frame and Settings' footer against the canvas in a plain
 * browser (`Feature - Phone update`). Never in a release: `main.tsx` imports
 * this only in a dev server, or in a build made with
 * `VITE_ORBITAL_UPDATE_DEMO=1`, and only with `?update-demo` in the URL.
 *
 * Drive it from the console or Playwright:
 *
 *   __orbitalUpdateDemo('ready' | 'closed' | 'restart' | 'none', { version?, shell? })
 *
 * The buttons move it the way the plugin would: Restart shows the restart
 * frame for a second and comes back to the same screen, × the receipt, OK
 * ends it. `shell` sets the native version Settings' footer shows.
 */

type DemoName = 'ready' | 'closed' | 'restart' | 'none'
type DemoOptions = { version?: string; shell?: string }

/** About as long as the reload takes on a phone. */
const RESTART_MS = 1000

export function installUpdateDemo(): void {
  let version = '0.8.1'
  const bundle = () => ({ id: `demo-${version}`, version })

  const source: UpdateSource = {
    restart: () =>
      new Promise((resolve) => {
        setTimeout(() => {
          usePhoneUpdate.setState({ shown: null })
          resolve()
        }, RESTART_MS)
      }),
    later: () => Promise.resolve(),
    answered: () => Promise.resolve(),
  }
  usePhoneUpdate.getState().connect(source, null)
  usePhoneUpdate.setState({ shell: '0.8.0' })

  const set = (name: DemoName, options: DemoOptions = {}) => {
    version = options.version ?? version
    if (options.shell) usePhoneUpdate.setState({ shell: options.shell })
    const shown = {
      ready: { phase: 'ready' as const, bundle: bundle() },
      closed: { phase: 'closed' as const, bundle: bundle() },
      restart: { phase: 'restarting' as const, bundle: bundle() },
      none: null,
    }[name]
    usePhoneUpdate.setState({ shown, answered: null })
    if (name === 'restart') void source.restart(bundle())
  }

  ;(window as { __orbitalUpdateDemo?: typeof set }).__orbitalUpdateDemo = set
}
