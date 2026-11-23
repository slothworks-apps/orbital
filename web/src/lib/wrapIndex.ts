/**
 * The place `delta` steps from `current` in a list of `count`, wrapping at
 * both ends: the question card's ↑ ↓ (canvas 9d KEYS), where a list of three
 * rows that stops dead at either end makes the keyboard feel broken, and the
 * tip card's Next, ← and → (canvas 68c). An empty list gives 0.
 */
export function wrapIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return 0
  return (((current + delta) % count) + count) % count
}
