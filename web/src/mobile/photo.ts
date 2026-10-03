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
