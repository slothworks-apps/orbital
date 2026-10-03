import { useEffect, useRef, useState } from 'react'
import { stateColor } from '../lib/stateStyle'
import { StateDot } from '../ui/StateDot'
import { useBanner, type BannerContent } from './notify'
import { GLYPH_HOLLOW_PX, GLYPH_SOLID_PX } from './screens/Glyph'
import { glyphFor } from './sessionList'
import { openFromNotice, useMobile } from './state'

/** How far up a touch must travel before the banner goes (9g's swipe up). */
const SWIPE_DISMISS_PX = 30

/** The needs-input group's edge on the list (9a), worn by the banner that announces one (9g). */
const INPUT_EDGE = 'border-[color-mix(in_oklch,var(--state-input)_45%,transparent)]'

/**
 * 9g's in-app banner (spec § 6.5): under the status bar, one at a time, gone
 * after `BANNER_MS`, on a swipe up, or on "View". Sizes are provisional; the
 * fidelity pass owns them.
 */
export function Banner() {
  const current = useBanner((s) => s.current)
  if (!current) return null
  // Keyed by when it arrived, so a replacement slides in afresh.
  return <BannerCard key={current.at} banner={current} />
}

function BannerCard({ banner }: { banner: BannerContent }) {
  const { sessionId, title, needsInput, line } = banner
  const dismiss = useBanner((s) => s.dismiss)
  const [shown, setShown] = useState(false)
  const touchY = useRef<number | null>(null)

  // Mounted off-screen, then moved in on the next frame: the slide down.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  const view = () => {
    if (sessionId) openFromNotice(() => useMobile.getState().openSession(sessionId))
    dismiss()
  }

  return (
    <div
      role="status"
      onTouchStart={(event) => {
        touchY.current = event.touches[0]?.clientY ?? null
      }}
      onTouchMove={(event) => {
        const y = event.touches[0]?.clientY
        if (touchY.current === null || y === undefined) return
        if (y - touchY.current < -SWIPE_DISMISS_PX) {
          touchY.current = null
          dismiss()
        }
      }}
      onTouchEnd={() => {
        touchY.current = null
      }}
      className={[
        'fixed inset-x-3 top-[calc(env(safe-area-inset-top)+8px)] z-30 rounded-[12px] border bg-panel-solid pb-1 pl-3 pr-2 pt-2 shadow-[0_8px_24px_rgba(0,0,0,.45)] transition-transform duration-200 ease-out motion-reduce:transition-none',
        needsInput ? INPUT_EDGE : 'border-panel-border',
        shown ? 'translate-y-0' : '-translate-y-[calc(100%+env(safe-area-inset-top)+8px)]',
      ].join(' ')}
    >
      <div className="flex items-center gap-3">
        {needsInput && (
          // The list's needs-input glyph, in a ring of its colour.
          <span
            aria-hidden
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${INPUT_EDGE}`}
          >
            <StateDot
              dot={glyphFor('needs_input', false)}
              color={stateColor('needs_input')}
              solidPx={GLYPH_SOLID_PX}
              hollowPx={GLYPH_HOLLOW_PX}
            />
          </span>
        )}
        <div className="min-w-0 flex-1">
          {/* The title truncates; " needs input" after it always shows (9g). */}
          <div className="flex min-w-0 text-[14px] font-semibold text-text-bright">
            <span className="truncate">{title}</span>
            {needsInput && <span className="shrink-0 whitespace-pre"> needs input</span>}
          </div>
          <div className={`truncate text-[12.5px] ${needsInput ? 'text-[var(--state-input)]' : 'text-text-soft'}`}>
            {line}
          </div>
        </div>
        {sessionId && (
          <button
            type="button"
            onClick={view}
            className="min-h-11 shrink-0 rounded-[10px] border border-accent/40 px-3 text-[14px] font-semibold text-accent"
          >
            View
          </button>
        )}
      </div>
      {/* The grip: the banner goes on a swipe up. */}
      <span aria-hidden className="mx-auto mt-1 block h-[3px] w-7 rounded-full bg-[rgba(160,190,225,.3)]" />
    </div>
  )
}
