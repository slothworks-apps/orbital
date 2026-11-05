import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

/**
 * The dropdown shell the browser bridge's lip, screenshot chip and sent
 * caption explain themselves in (canvas 64b-3, 64c-C, 64d-2): the whole page
 * title, the URL and one line about it.
 */

/** 64b-3 / 64c-C: the shell comes up after the pointer rests this long. */
export const BROWSER_HOVER_DELAY_MS = 350

/** Shows after `BROWSER_HOVER_DELAY_MS` of hover, hides at once on leave. */
export function useHoverDelay(): {
  shown: boolean
  onMouseEnter: () => void
  onMouseLeave: () => void
} {
  const [shown, setShown] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )
  return {
    shown,
    onMouseEnter: () => {
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => setShown(true), BROWSER_HOVER_DELAY_MS)
    },
    onMouseLeave: () => {
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = null
      setShown(false)
    },
  }
}

/**
 * 64b-3: 8px radius, 8px 10px padding, the panel fill at .96 inside a .16
 * hairline, a 0 12px 30px shadow; mono 10.5 at 1.55, muted .6 ink with the
 * title in full ink. Positioned by the caller, which knows what it hangs off.
 */
export function BrowserHoverCard({
  title,
  lines,
  className = '',
  style,
}: {
  title: string
  lines: ReactNode[]
  className?: string
  style?: CSSProperties
}) {
  return (
    <div
      data-browser-hover-card
      role="tooltip"
      style={style}
      className={[
        'pointer-events-none absolute z-[4] box-border rounded-[8px] border border-line/16 bg-panel/96 px-2.5 py-2',
        'shadow-[0_12px_30px_color-mix(in_oklab,_var(--color-shadow)_50%,_transparent)]',
        'whitespace-normal font-mono fs-10.5 leading-[1.55] tracking-normal text-ink-900/60',
        className,
      ].join(' ')}
    >
      <div className="text-ink-100 [overflow-wrap:anywhere]">{title}</div>
      {lines.map((line, i) => (
        <div key={i} className="[overflow-wrap:anywhere]">
          {line}
        </div>
      ))}
    </div>
  )
}
