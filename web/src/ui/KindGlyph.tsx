/**
 * The device-kind glyph — screen, rack or handset, told by shape alone, pure
 * CSS in `currentColor` so it takes the ink of whatever holds it (canvas 50k
 * "KIND GLYPHS", component `Device Glyph`). 12 × 11 px at `scale={1}`; `scale={3}`
 * is the join confirmation's and the phone's device sheet's size, drawn with
 * `zoom` the way the canvas does rather than a transform, so the box still
 * reserves its own (now 3×) space.
 */
export interface KindGlyphProps {
  /** An unrecognised kind reads as `desktop` — the group's own default. */
  kind: string
  scale?: 1 | 3
  /**
   * No tooltip of its own: inside something that has one (a device chip's
   * `name · kind · state`), the glyph's bare kind would hide it.
   */
  untitled?: boolean
}

export function KindGlyph({ kind, scale = 1, untitled = false }: KindGlyphProps) {
  const isHeadless = kind === 'headless'
  const isPhone = kind === 'phone'
  const isDesktop = !isHeadless && !isPhone

  return (
    <span
      title={untitled ? undefined : kind}
      style={{
        display: 'grid',
        placeItems: 'center',
        width: 12,
        height: 11,
        flex: 'none',
        color: 'inherit',
        lineHeight: 0,
        fontSize: 0,
        zoom: scale,
      }}
    >
      {isDesktop && (
        <span style={{ position: 'relative', display: 'block', width: 12, height: 11 }}>
          <span
            style={{
              position: 'absolute', left: 0, top: 0, width: 12, height: 8.4,
              boxSizing: 'border-box', border: '1.2px solid currentColor', borderRadius: 2,
            }}
          />
          <span
            style={{
              position: 'absolute', left: 3.5, bottom: 0, width: 5, height: 1.2,
              borderRadius: 1, background: 'currentColor',
            }}
          />
        </span>
      )}
      {isHeadless && (
        <span style={{ display: 'flex', flexDirection: 'column', gap: 1.6, width: 12 }}>
          {[0, 1].map((i) => (
            <span
              key={i}
              style={{
                position: 'relative', display: 'block', height: 4.6,
                boxSizing: 'border-box', border: '1.2px solid currentColor', borderRadius: 1.5,
              }}
            >
              <span
                style={{
                  position: 'absolute', right: 1.4, top: 1, width: 1.2, height: 1.2,
                  borderRadius: '50%', background: 'currentColor',
                }}
              />
            </span>
          ))}
        </span>
      )}
      {isPhone && (
        <span
          style={{
            position: 'relative', display: 'block', width: 7.6, height: 11,
            boxSizing: 'border-box', border: '1.2px solid currentColor', borderRadius: 2,
          }}
        >
          <span
            style={{
              position: 'absolute', left: '50%', bottom: 1, width: 2.4, height: 1,
              marginLeft: -1.2, borderRadius: 1, background: 'currentColor',
            }}
          />
        </span>
      )}
    </span>
  )
}
