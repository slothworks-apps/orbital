import { Capacitor, registerPlugin } from '@capacitor/core'
import { BiometricAuth, BiometryType, type CheckBiometryResult } from '@aparajita/capacitor-biometric-auth'

/**
 * The device's own lock (spec 2026-10-06-pairing-code-and-app-lock-design
 * § 2, § 3): whether a screen lock is set, what the system prompt
 * authenticates with, and the prompt itself. In a desktop browser (layout
 * work only) the device counts as secured and every prompt succeeds, the
 * same dev-only stance as `identity.ts`.
 */

/** What 9f's toggle is named after: "Require <label> to open". */
export type LockLabel = 'Face ID' | 'Touch ID' | 'fingerprint' | 'face unlock' | 'screen lock'

function native(): boolean {
  return Capacitor.isNativePlatform()
}

async function check(): Promise<CheckBiometryResult | null> {
  try {
    return await BiometricAuth.checkBiometry()
  } catch (err) {
    console.warn('[mobile] could not read the device lock', err)
    return null
  }
}

export interface DeviceLock {
  /**
   * A passcode, PIN, pattern or password is set; biometrics on top are
   * optional. A check that fails says yes: the plugin failing must not shut
   * the user out of the app behind 9s with nothing they can change.
   */
  secure: boolean
  label: LockLabel
}

/** Read at boot and on every return to the foreground: a lock or a face may have been set meanwhile. */
export async function readDeviceLock(): Promise<DeviceLock> {
  if (!native()) return { secure: true, label: 'screen lock' }
  const result = await check()
  return { secure: result?.deviceIsSecure ?? true, label: lockLabelOf(result) }
}

/** The enrolled biometry the prompt will use; "screen lock" when none is enrolled. */
export function lockLabelOf(result: Pick<CheckBiometryResult, 'isAvailable' | 'biometryType'> | null): LockLabel {
  if (!result?.isAvailable) return 'screen lock'
  switch (result.biometryType) {
    case BiometryType.faceId:
      return 'Face ID'
    case BiometryType.touchId:
      return 'Touch ID'
    case BiometryType.fingerprintAuthentication:
      return 'fingerprint'
    case BiometryType.faceAuthentication:
      return 'face unlock'
    default:
      return 'screen lock'
  }
}

/**
 * Where an iPhone sets its passcode, named after its hardware (9s on iOS,
 * which cannot open that page for the app): Face ID or Touch ID even when
 * neither is enrolled, since the Settings row is named after the sensor.
 */
export async function passcodeSettingsName(): Promise<string> {
  const result = native() ? await check() : null
  if (result?.biometryType === BiometryType.faceId) return 'Face ID & Passcode'
  if (result?.biometryType === BiometryType.touchId) return 'Touch ID & Passcode'
  return 'Passcode'
}

/**
 * The system prompt: biometrics, with the device's PIN or passcode as the
 * fallback. A cancel or a failure is `false`, never a throw.
 */
export async function authenticate(): Promise<boolean> {
  if (!native()) return true
  try {
    await BiometricAuth.authenticate({
      reason: 'Unlock Orbital',
      androidTitle: 'Unlock Orbital',
      cancelTitle: 'Cancel',
      allowDeviceCredential: true,
    })
    return true
  } catch {
    return false
  }
}

/** The Android shell's own plugin (`SecuritySettingsPlugin`, registered in MainActivity). Android only. */
const SecuritySettings = registerPlugin<{ open(): Promise<void> }>('SecuritySettings')

/** Whether 9s can take the user to the screen-lock settings; iOS has no such link for an app. */
export function canOpenSecuritySettings(): boolean {
  return Capacitor.getPlatform() === 'android'
}

export async function openSecuritySettings(): Promise<void> {
  try {
    await SecuritySettings.open()
  } catch (err) {
    console.warn('[mobile] could not open the security settings', err)
  }
}
