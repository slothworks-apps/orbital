import { Capacitor } from '@capacitor/core'
import { Device } from '@capacitor/device'
import { deviceName } from './parse'

/** What the Mac's confirm dialog and its device list call this phone (9e, 9o). */
export async function thisDevice(): Promise<{ name: string; platform: string }> {
  const info = await Device.getInfo().catch(() => null)
  return { name: deviceName(info), platform: Capacitor.getPlatform() }
}
