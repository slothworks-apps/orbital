/**
 * 32-bit FNV-1a over a string, as an unsigned integer. For anything that
 * needs a stable number from an id: the same string always gives the same
 * value, on every device and every run.
 */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
