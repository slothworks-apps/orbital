import type { ReactNode } from 'react'

/**
 * Pieces the walkthrough's screens share, with the canvas's literal values
 * (`Feature - Walkthrough.dc.html`, 21a–21h). None of them is a `ui/Button`
 * variant: the canvas's buttons here are tinted glass, not the app's filled
 * or outlined pair, and `Button` takes no fill through `className`.
 */

const TONES = {
  // Next, Narrate (canvas 21a/21b).
  lit: 'border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)] text-text-bright font-semibold',
  // Previous, Open the transcript (canvas 21b/21e).
  quiet: 'border-[rgba(150,205,255,.14)] bg-transparent text-text-bright font-semibold',
  // Start, Back to the map (canvas 21a/21e).
  accent:
    'border-[oklch(85%_.12_205/.6)] bg-[oklch(85%_.12_205/.12)] text-[#f2f9ff] font-bold shadow-[0_0_0_3px_oklch(85%_.12_205/.08)]',
} as const

const SIZES = {
  sm: 'rounded-[7px] px-3.5 py-[7px] text-[12.5px]', // canvas 21a/21b
  md: 'rounded-lg px-[18px] py-2.5 text-[13px]', // canvas 21e footer
  lg: 'rounded-[9px] px-[22px] py-3 text-[14px]', // canvas 21a Start
} as const

interface WalkButtonProps {
  tone: keyof typeof TONES
  size: keyof typeof SIZES
  children: ReactNode
  disabled?: boolean
  onClick?(): void
  /** Renders a link styled as the button. */
  href?: string
}

export function WalkButton({ tone, size, children, disabled, onClick, href }: WalkButtonProps) {
  const cls = [
    'inline-flex items-center justify-center gap-2 border font-sans transition-colors',
    'disabled:cursor-not-allowed disabled:opacity-40',
    TONES[tone],
    SIZES[size],
  ].join(' ')
  if (href !== undefined) {
    return (
      <a href={href} className={cls}>
        {children}
      </a>
    )
  }
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={cls}>
      {children}
    </button>
  )
}

/**
 * The agent's own words (canvas 21b/21c/21d): a thin bar at the left and the
 * text in quotes. The quotes are CSS, so the text stays its own node — the
 * words are the transcript's, verbatim.
 */
export function Words({ children, small = false, clamp = false }: { children: string; small?: boolean; clamp?: boolean }) {
  return (
    <div className="flex gap-3">
      <span aria-hidden className="block w-0.5 shrink-0 self-stretch rounded-[1px] bg-[rgba(150,205,255,.2)]" />
      <p
        className={[
          "whitespace-pre-wrap before:content-['“'] after:content-['”']",
          small ? 'text-[12.5px] leading-[1.5] text-[rgba(200,214,235,.75)]' : 'text-[13px] leading-[1.55] text-[rgba(200,214,235,.8)]',
          clamp ? 'line-clamp-3' : '',
        ].join(' ')}
      >
        {children}
      </p>
    </div>
  )
}

/** A step number that jumps there (canvas 21b fate rows, 21e): soft ink, dashed underline. */
export function JumpLink({ onJump, children }: { onJump?(): void; children: ReactNode }) {
  if (!onJump) return <span className="text-text-soft">{children}</span>
  return (
    <button type="button" onClick={onJump} className="border-b border-dashed border-[rgba(150,205,255,.3)] text-text-soft">
      {children}
    </button>
  )
}

/** `+n −m`, in the two inks `ToolRow` uses for its skim. */
export function Counts({ counts }: { counts: { added: number; removed: number } | null }) {
  if (!counts || (counts.added === 0 && counts.removed === 0)) return null
  return (
    <span className="flex shrink-0 gap-1.5 tabular-nums">
      {counts.added > 0 && <span className="text-[oklch(82%_.14_145)]">+{counts.added}</span>}
      {counts.removed > 0 && <span className="text-[oklch(72%_.15_22)]">−{counts.removed}</span>}
    </span>
  )
}

/** A 6px dot that blinks while something is under way (canvas 21a pill, 21b ask well, 21e). */
export function BlinkDot({ bright = false }: { bright?: boolean }) {
  return <span aria-hidden className={['block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full', bright ? 'bg-text-bright' : 'bg-[rgba(160,190,225,.5)]'].join(' ')} />
}
