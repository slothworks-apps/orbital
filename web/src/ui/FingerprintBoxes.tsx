/** One character of the fingerprint, boxed as the phone boxes it (canvas 9o, 9e). */
function CodeBox({ char }: { char: string }) {
  return (
    <span className="flex h-14 w-10 items-center justify-center rounded-[10px] border border-[rgba(150,205,255,.24)] bg-[rgba(4,8,16,.6)] font-mono text-[28px] text-text-bright">
      {char}
    </span>
  )
}

/**
 * The six-character pairing fingerprint in six boxes, a short rule between
 * the two groups of three: the same drawing on the Mac's confirm (9o) and on
 * the phone's step 2 (9e), so the two can be compared at a glance.
 */
export function FingerprintBoxes({ value }: { value: string }) {
  const chars = value.split('')
  return (
    <div className="flex items-center justify-center gap-2" aria-label={`Code ${value}`}>
      {chars.slice(0, 3).map((c, i) => (
        <CodeBox key={i} char={c} />
      ))}
      <span aria-hidden className="mx-1 block h-[2px] w-2.5 rounded-full bg-[rgba(150,205,255,.35)]" />
      {chars.slice(3).map((c, i) => (
        <CodeBox key={i + 3} char={c} />
      ))}
    </div>
  )
}
