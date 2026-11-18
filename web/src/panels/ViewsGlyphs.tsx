/** The lock of a built-in CDN host in Settings → Labs → Views (canvas `Feature - Views` 69f), on the desktop and the phone. */

/** 69f's lock on a built-in host: a 9×11 padlock. */
export function LockGlyph() {
  return (
    <span title="built in" className="relative block h-[11px] w-[9px] flex-none">
      <span className="absolute left-[1.5px] top-0 box-border h-[6px] w-[6px] rounded-t-[3px] border-[1.3px] border-b-0 border-current" />
      <span className="absolute bottom-0 left-0 h-[6px] w-[9px] rounded-[1.5px] bg-current" />
    </span>
  )
}
