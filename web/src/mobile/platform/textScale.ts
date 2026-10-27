import { Capacitor } from '@capacitor/core'
import { applyTextScales, clampTextScale } from '../../lib/textScale'

/**
 * The phone's text follows the system's text size (spec
 * 2026-10-27-text-size-design § On the phone). Android's WebView already
 * applies the system font scale to every size through `textZoom`, so only
 * iOS is read here: WKWebView leaves Dynamic Type to the page.
 */

/** iOS body text at the default Dynamic Type size, in px. */
const IOS_DEFAULT_BODY_PX = 17

/** Dynamic Type as a multiplier: what `-apple-system-body` resolves to against its default. */
function dynamicTypeScale(doc: Document): number {
  const probe = doc.createElement('span')
  probe.style.font = '-apple-system-body'
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  doc.body.appendChild(probe)
  const px = parseFloat(getComputedStyle(probe).fontSize)
  probe.remove()
  return clampTextScale(px / IOS_DEFAULT_BODY_PX)
}

/** Read at boot and on every return to the foreground, where a change made in Settings shows. */
export function applySystemTextScale(): void {
  if (Capacitor.getPlatform() !== 'ios') return
  const scale = dynamicTypeScale(document)
  applyTextScales(document.documentElement, { app: scale, transcript: scale })
}
