/**
 * Orbital wordmark ring: cyan orbit circle with a satellite dot, per the
 * design export's sidebar header (artboard 1a) — shared by the expanded
 * sidebar and the collapsed rail.
 */
export function Logo() {
  return (
    <span
      aria-hidden
      className="relative inline-block h-[18px] w-[18px] shrink-0 rounded-full border-[1.5px] border-accent shadow-[0_0_10px_rgba(126,231,255,.5)]"
    >
      <span className="absolute -right-[3px] top-[2px] h-[5px] w-[5px] rounded-full bg-accent shadow-[0_0_6px_rgba(126,231,255,.9)]" />
    </span>
  )
}
