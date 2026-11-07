import { linkableUrl } from '../lib/browserBridge'
import { BrowserHoverCard, useHoverDelay } from './BrowserHoverCard'

/**
 * What a sent turn carried from the browser, as a caption under it (canvas
 * `Feature - Browser bridge` 64c-D, 64d-1/2): the editor caption's twin — the
 * window glyph, what it was, and the page title as a pressable dashed path.
 * Hover gives the whole title and the URL; a press opens the page in the
 * default browser.
 */
export function BrowserCaption({
  kind,
  title,
  url,
  chars,
}: {
  kind: 'selection' | 'screenshot'
  title: string
  url: string
  /** A selection's length, for the hover's last line. */
  chars?: number
}) {
  const hover = useHoverDelay()
  const opens = linkableUrl(url)
  const shown = title || url
  const last = [
    chars !== undefined ? `${chars} char${chars === 1 ? '' : 's'}` : '',
    opens ? 'click opens it in your browser ↗' : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div
      data-sent-browser={kind}
      onMouseEnter={hover.onMouseEnter}
      onMouseLeave={hover.onMouseLeave}
      // 64d-1: mono 9.5 at .04em, .55 ink, 6px gaps, cut at the bubble's width.
      className="relative mt-[2px] flex max-w-full items-center gap-1.5 whitespace-nowrap font-mono fs-9.5 tracking-[0.04em] text-ink-900/55"
    >
      {/* 64d-1: the lip's window glyph at the caption's scale — 9×7, 1.1px at .5, a 1px bar. */}
      <span
        aria-hidden
        className="relative box-border block h-[7px] w-[9px] flex-none rounded-[1.5px] border-[1.1px] border-ink-900/50"
      >
        <span className="absolute inset-x-0 top-[1.1px] block h-px bg-ink-900/50" />
      </span>
      <span className="flex-none">{kind === 'selection' ? 'Selected in the browser —' : 'Screenshot from the browser —'}</span>
      {opens ? (
        <button
          type="button"
          // The link opens outside Orbital, as a link in a reply does.
          onClick={() => window.open(url, '_blank', 'noopener')}
          className="min-w-0 cursor-pointer truncate border-b border-dashed border-line/30 text-ink-300"
        >
          {shown}
        </button>
      ) : (
        <span className="min-w-0 truncate border-b border-dashed border-line/30 text-ink-300">{shown}</span>
      )}
      {hover.shown && (
        // 64d-2: 300px, its right edge on the caption's, 6px above it.
        <BrowserHoverCard
          title={shown}
          lines={[url, ...(last ? [last] : [])]}
          className="right-0 w-[300px]"
          style={{ bottom: 'calc(100% + 6px)' }}
        />
      )}
    </div>
  )
}
