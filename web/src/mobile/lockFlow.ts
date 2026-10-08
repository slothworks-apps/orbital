import { authenticate, readDeviceLock } from './platform/deviceLock'
import { useMobile } from './state'

/**
 * Every system prompt goes through here, so the trips out of the foreground
 * it causes are not taken for the user leaving (`authenticating`). One
 * prompt at a time: a second ask while one is up gets the first's answer.
 */
let inFlight: Promise<boolean> | null = null

export function confirmIdentity(): Promise<boolean> {
  if (inFlight) return inFlight
  useMobile.setState({ authenticating: true })
  const current = authenticate().finally(() => {
    inFlight = null
    useMobile.setState({ authenticating: false })
  })
  inFlight = current
  return current
}

/**
 * 9t's prompt (canvas 9t: the screen draws first and the prompt opens over
 * it). Success returns to wherever the app was; a cancel leaves 9t with its
 * Unlock button.
 */
export async function unlock(): Promise<void> {
  useMobile.setState({ lock: 'locked' })
  if (await confirmIdentity()) useMobile.setState({ lock: 'open' })
}

/** 9s's check, at boot and on every return to the foreground. */
export async function recheckScreenLock(): Promise<void> {
  const { secure, label } = await readDeviceLock()
  useMobile.setState({ screenLock: !secure, lockLabel: label })
}
