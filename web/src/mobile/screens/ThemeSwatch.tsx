/** Per size: the strip's corner, and each block's height and width (canvas `Feature - Colour themes` 1k A–C). */
const SIZE = {
  sm: { strip: 'rounded-[4px]', block: 'h-3 w-2.5' },
  md: { strip: 'rounded-[5px]', block: 'h-[22px] w-3' },
} as const

/** The live tokens a theme's swatch stands for: space · panel · accent. */
const LIVE = ['bg-space', 'bg-panel', 'bg-accent'] as const

/**
 * A theme's three blocks, space · panel · accent. With `colours`, a theme's
 * own (the list, where each row shows what it would paint); without, the
 * live tokens (the Appearance row of the theme painted now).
 */
export function ThemeSwatch({
  colours,
  size,
}: {
  colours?: readonly [string, string, string]
  size: keyof typeof SIZE
}) {
  const { strip, block } = SIZE[size]
  return (
    <span aria-hidden className={`flex shrink-0 overflow-hidden ring-1 ring-line/12 ${strip}`}>
      {LIVE.map((token, i) =>
        colours ? (
          <span key={i} className={`block ${block}`} style={{ background: colours[i] }} />
        ) : (
          <span key={i} className={`block ${block} ${token}`} />
        ),
      )}
    </span>
  )
}
