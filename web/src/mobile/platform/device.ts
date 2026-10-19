import { Capacitor } from '@capacitor/core'
import { Device } from '@capacitor/device'
import { osName } from '@orbital/shared/remote/device'
import { osVersionText } from '@orbital/shared/remote/groupWords'
import { deviceName } from './parse'

/**
 * What the Mac's confirm dialog and its device list call this phone (9e,
 * 9o), and the OS version its hello names (`Android 15`, canvas 50s);
 * `osVersion` absent when the plugin does not say.
 */
export async function thisDevice(): Promise<{ name: string; platform: string; osVersion?: string }> {
  const info = await Device.getInfo().catch(() => null)
  const platform = Capacitor.getPlatform()
  const version = info?.osVersion?.trim() ?? ''
  return {
    name: deviceName(info), platform,
    ...(version !== '' ? { osVersion: osVersionText(osName(platform), version) } : {}),
  }
}
