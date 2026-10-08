/**
 * The size a photo is sent at (spec § 6.2): the longer edge brought to
 * `max` and the other in proportion, rounded but never to 0. A photo
 * already within `max` is sent as it is, so `scaled` is false and its
 * bytes go untouched.
 */
export function fitWithin(w: number, h: number, max: number): { w: number; h: number; scaled: boolean } {
  const long = Math.max(w, h)
  if (long <= max) return { w, h, scaled: false }
  const k = max / long
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), scaled: true }
}

/** A camera-style name, `IMG_<HHMMSS>.jpg` in local time: the picker hands back a photo with none (canvas 9b). */
export function photoName(now: Date): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `IMG_${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}.jpg`
}

/**
 * The size a photo was taken at, from the plugin's `exif` — the plugin hands
 * back a photo already brought down (`PHOTO_PLUGIN_EDGE`), so the bitmap no
 * longer says. Both platforms name `PixelXDimension`/`PixelYDimension`
 * (Android as strings); Android's `ImageWidth`/`ImageLength` stand in when
 * they are missing. Exif counts the sensor's way round, before the plugin
 * turned the photo upright, so the pair is turned to `upright`'s
 * orientation. Null when the exif names no size.
 */
export function takenSize(exif: unknown, upright: { w: number; h: number }): { w: number; h: number } | null {
  if (typeof exif !== 'object' || exif === null) return null
  const e = exif as Record<string, unknown>
  const pair = (x: unknown, y: unknown) => {
    const w = dimension(x)
    const h = dimension(y)
    return w && h ? { w, h } : null
  }
  const size = pair(e.PixelXDimension, e.PixelYDimension) ?? pair(e.ImageWidth, e.ImageLength)
  if (!size) return null
  const turned = (size.w > size.h && upright.h > upright.w) || (size.w < size.h && upright.w > upright.h)
  return turned ? { w: size.h, h: size.w } : size
}

function dimension(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN
  return Number.isInteger(n) && n > 0 ? n : null
}
