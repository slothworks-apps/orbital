type Size = 'md' | 'sm'

/**
 * Each size's box, the rule between the groups, and the gap. `md` is the
 * pairing confirm's (canvas 9o, 9e); `sm` the joining card's in Settings →
 * Devices (canvas 50b), where everything sits on one even gap.
 */
const SIZES: Record<Size, { box: string; rule: string; row: string }> = {
  md: {
    box: 'h-fit min-h-14 w-10 rounded-[10px] fs-28',
    rule: 'mx-1 h-[2px] w-2.5 rounded-full bg-[rgba(150,205,255,.35)]',
    row: 'gap-2',
  },
  sm: {
    box: 'h-fit min-h-12 w-[34px] rounded-[9px] fs-24',
    rule: 'h-[2px] w-2 bg-[rgba(160,190,225,.4)]',
    row: 'gap-1.5',
  },
}

/** One character of the fingerprint, boxed as the phone boxes it (canvas 9o, 9e). */
function CodeBox({ char, size }: { char: string; size: Size }) {
  return (
    <span
      className={`flex items-center justify-center border border-[rgba(150,205,255,.24)] bg-[rgba(4,8,16,.6)] font-mono text-text-bright ${SIZES[size].box}`}
    >
      {char}
    </span>
  )
}

/**
 * The six-character pairing fingerprint in six boxes, a short rule between
 * the two groups of three: the same drawing on the Mac's confirm (9o) and on
 * the phone's step 2 (9e), so the two can be compared at a glance.
 */
export function FingerprintBoxes({ value, size = 'md' }: { value: string; size?: Size }) {
  const chars = value.split('')
  const s = SIZES[size]
  return (
    <div className={`flex items-center justify-center ${s.row}`} aria-label={`Code ${value}`}>
      {chars.slice(0, 3).map((c, i) => (
        <CodeBox key={i} char={c} size={size} />
      ))}
      <span aria-hidden className={`block ${s.rule}`} />
      {chars.slice(3).map((c, i) => (
        <CodeBox key={i + 3} char={c} size={size} />
      ))}
    </div>
  )
}
