import { Capacitor } from '@capacitor/core'
import { Device } from '@capacitor/device'
import { osName } from '@orbital/shared/remote/device'
import { osVersionText } from '@orbital/shared/remote/groupWords'
import { deviceName } from './parse'

/**
 * What the Mac's confirm dialog and its device list call this phone (9e,
 * 9o), the OS version its hello names (`Android 15`, canvas 50s), and the
 * model a bug report carries (`Feature - Feedback` 61g PHONE); `osVersion`
 * and `model` absent when the plugin does not say.
 */
export async function thisDevice(): Promise<{ name: string; platform: string; osVersion?: string; model?: string }> {
  const info = await Device.getInfo().catch(() => null)
  const platform = Capacitor.getPlatform()
  const version = info?.osVersion?.trim() ?? ''
  const model = info?.model?.trim() ?? ''
  return {
    name: deviceName(info), platform,
    ...(version !== '' ? { osVersion: osVersionText(osName(platform), version) } : {}),
    ...(model !== '' ? { model } : {}),
  }
}
