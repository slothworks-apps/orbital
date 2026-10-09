import { Preferences } from '@capacitor/preferences'

/**
 * 9f's "Send diagnostics" (spec 2026-10-09-phone-ota-updates-design →
 * Privacy): the updater plugin's own reports to Beam — install results,
 * foreground and background, the WebView's errors and crashes — and the
 * phone's device_info event. On unless it reads `false`. The update check
 * itself does not depend on it: without it there are no updates.
 */
export const DIAGNOSTICS_KEY = 'orbital.diagnostics'

export async function loadDiagnostics(): Promise<boolean> {
  const { value } = await Preferences.get({ key: DIAGNOSTICS_KEY })
  return value !== 'false'
}

export function saveDiagnostics(on: boolean): Promise<void> {
  return Preferences.set({ key: DIAGNOSTICS_KEY, value: on ? 'true' : 'false' })
}
