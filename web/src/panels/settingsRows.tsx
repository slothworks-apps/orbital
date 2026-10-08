import type { ReactNode } from 'react'

/**
 * The Settings dialog's row primitives, shared by `Settings.tsx` and the
 * sections that live in their own files (`MobileSection.tsx`).
 */

/** Debounce for the free-text fields — the rest of this panel's controls
 * (cards, segmented steps, toggles, selects) are discrete clicks and PATCH
 * immediately. */
export const DEBOUNCE_MS = 400

/** Mono section kicker inside the settings content column (canvas 1h):
 * 8px/4px above the first group, 14px/4px above every later one. */
export function SectionLabel({ children, first = false }: { children: ReactNode; first?: boolean }) {
  return (
    <div
      className={`pb-1 font-mono text-[10px] tracking-[0.18em] text-[rgba(160,190,225,.6)] ${first ? 'pt-2' : 'pt-3.5'}`}
    >
      {children}
    </div>
  )
}

/** One settings row per canvas 1h: label + description left, 320px control
 * column right, 13px vertical padding over a hairline top rule.
 *
 * `dimmed` is a row with nothing to act on yet (canvas `Feature -
 * Notifications off` 1c, background-only while every event is off): its words
 * at .45, the same as a disabled control beside them. */
export function Row({
  title,
  desc,
  dimmed = false,
  children,
}: {
  title: string
  desc: string
  dimmed?: boolean
  children: ReactNode
}) {
  return (
    <div className="grid grid-cols-[1fr_320px] items-start gap-6 border-t border-[rgba(150,205,255,.08)] py-[13px]">
      <div className={dimmed ? 'opacity-45' : undefined}>
        <div className="text-[13.5px] font-semibold text-text-bright">{title}</div>
        <div className="mt-1 text-[12px] leading-[1.5] text-[rgba(160,190,225,.7)] [text-wrap:pretty]">
          {desc}
        </div>
      </div>
      <div className="flex min-w-0 flex-col items-start gap-2.5">{children}</div>
    </div>
  )
}
