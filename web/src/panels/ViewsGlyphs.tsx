/** Glyphs of Settings → Labs → Views (canvas `Feature - Views` 69f), shared by the desktop's rows and the phone's. */

/** 69f's view glyph: a 13×11 window, its title bar and a small square. */
export function ViewsGlyph() {
  return (
    <span className="relative box-border block h-[11px] w-[13px] flex-none rounded-[2.5px] border-[1.4px] border-current">
      <span className="absolute left-0 right-0 top-[2px] h-[1.4px] bg-current" />
      <span className="absolute left-[2px] top-[4.6px] h-[3px] w-[3px] rounded-[0.6px] bg-current opacity-60" />
    </span>
  )
}

/** 69f's lock on a built-in host: a 9×11 padlock. */
export function LockGlyph() {
  return (
    <span title="built in" className="relative block h-[11px] w-[9px] flex-none">
      <span className="absolute left-[1.5px] top-0 box-border h-[6px] w-[6px] rounded-t-[3px] border-[1.3px] border-b-0 border-current" />
      <span className="absolute bottom-0 left-0 h-[6px] w-[9px] rounded-[1.5px] bg-current" />
    </span>
  )
}
