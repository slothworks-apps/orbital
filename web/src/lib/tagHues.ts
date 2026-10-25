/** The design canvas's 8-swatch hue picker, verbatim from artboard 1e. */
export const HUE_SWATCHES = [210, 250, 290, 330, 20, 60, 110, 150]

/**
 * The hue a new tag gets: the first swatch no tag wears yet (canvas
 * `Feature - Tag chips` 80e, "the next free one"), or the swatches in turn
 * once every one is taken.
 */
export function nextTagHue(tags: ReadonlyArray<{ hue: number }>): number {
  return HUE_SWATCHES.find((h) => !tags.some((t) => t.hue === h)) ?? HUE_SWATCHES[tags.length % HUE_SWATCHES.length]
}
