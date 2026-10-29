import type { ReactNode } from 'react'

/**
 * Pieces the walkthrough's screens share, with the canvas's literal values
 * (`Feature - Walkthrough.dc.html`, 21a–21h). None of them is a `ui/Button`
 * variant: the canvas's buttons here are tinted glass, not the app's filled
 * or outlined pair, and `Button` takes no fill through `className`.
 */

const TONES = {
  // Next, Narrate (canvas 21a/21b).
  lit: 'border-line/30 bg-line/14 text-ink-100 font-semibold',
  // Previous, Open the transcript (canvas 21b/21e).
  quiet: 'border-line/14 bg-transparent text-ink-100 font-semibold',
  // Start (canvas 21a).
  accent:
    'border-accent/60 bg-accent/12 text-ink-50 font-bold shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent)_8%,transparent)]',
} as const

const SIZES = {
  sm: 'rounded-[7px] px-3.5 py-[7px] fs-12.5', // canvas 21a/21b
  md: 'rounded-lg px-[18px] py-2.5 fs-13', // canvas 21e footer
  lg: 'rounded-[9px] px-[22px] py-3 fs-14', // canvas 21a Start
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
      <span aria-hidden className="block w-0.5 shrink-0 self-stretch rounded-[1px] bg-line/20" />
      <p
        className={[
          "whitespace-pre-wrap before:content-['“'] after:content-['”']",
          small ? 'fs-12.5 leading-[1.5] text-ink-600/75' : 'fs-13 leading-[1.55] text-ink-600/80',
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
  if (!onJump) return <span className="text-ink-300">{children}</span>
  return (
    <button type="button" onClick={onJump} className="border-b border-dashed border-line/30 text-ink-300">
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
  return <span aria-hidden className={['block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full', bright ? 'bg-ink-100' : 'bg-ink-900/50'].join(' ')} />
}
