import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'

export interface DialogProps {
  open: boolean
  title: string
  /** Mono uppercase kicker above the title (e.g. "LAUNCH", "/clear"). */
  eyebrow?: string
  /**
   * Panel width and chrome, straight off the export:
   * `sm` = 440px stop confirm (1b), `md` = 560px clear confirm (1g),
   * `lg` = 660px form dialog with a ruled header (1d).
   */
  size?: 'sm' | 'md' | 'lg'
  /**
   * Which hue owns the frame — the accent everywhere except the stop confirm,
   * which the export frames in amber down to its corner brackets (1b).
   */
  tone?: 'accent' | 'warning'
  /** Renders the export's blinking dot before the eyebrow (1b's live-turn stop confirm). */
  eyebrowPulse?: boolean
  footer?: ReactNode
  /** Left side of the footer row — mono muted keyboard hints or captions. */
  footerCaption?: ReactNode
  onClose: () => void
  children?: ReactNode
}

/**
 * Corner brackets, 1.5px and hue-coloured, overhanging the frame by 1px. The
 * export sizes them with the panel: 16px on the 14px-radius confirms, 18px on
 * the 16px-radius form dialog.
 */
const cornerBase: Record<'tl' | 'tr' | 'bl' | 'br', string> = {
  tl: 'absolute -left-px -top-px border-l-[1.5px] border-t-[1.5px]',
  tr: 'absolute -right-px -top-px border-r-[1.5px] border-t-[1.5px]',
  bl: 'absolute -left-px -bottom-px border-l-[1.5px] border-b-[1.5px]',
  br: 'absolute -right-px -bottom-px border-r-[1.5px] border-b-[1.5px]',
}

const cornerRadius: Record<'sm' | 'md' | 'lg', Record<'tl' | 'tr' | 'bl' | 'br', string>> = {
  sm: {
    tl: 'h-4 w-4 rounded-tl-[14px]',
    tr: 'h-4 w-4 rounded-tr-[14px]',
    bl: 'h-4 w-4 rounded-bl-[14px]',
    br: 'h-4 w-4 rounded-br-[14px]',
  },
  md: {
    tl: 'h-4 w-4 rounded-tl-[14px]',
    tr: 'h-4 w-4 rounded-tr-[14px]',
    bl: 'h-4 w-4 rounded-bl-[14px]',
    br: 'h-4 w-4 rounded-br-[14px]',
  },
  lg: {
    tl: 'h-[18px] w-[18px] rounded-tl-2xl',
    tr: 'h-[18px] w-[18px] rounded-tr-2xl',
    bl: 'h-[18px] w-[18px] rounded-bl-2xl',
    br: 'h-[18px] w-[18px] rounded-br-2xl',
  },
}

const corners = ['tl', 'tr', 'bl', 'br'] as const

/** Width + radius + glass fill per artboard. */
const sizeClasses: Record<NonNullable<DialogProps['size']>, string> = {
  sm: 'w-[440px] rounded-[14px] bg-gradient-to-b from-[rgba(16,22,38,.94)] to-[rgba(8,12,22,.97)]',
  md: 'w-[560px] rounded-[14px] bg-gradient-to-b from-[rgba(16,22,38,.94)] to-[rgba(8,12,22,.97)]',
  lg: 'w-[660px] rounded-2xl bg-gradient-to-b from-[rgba(16,22,38,.9)] to-[rgba(8,12,22,.94)]',
}

/** Inner gutter: confirms sit at 24px, the form dialog at 26px. */
const gutter: Record<NonNullable<DialogProps['size']>, string> = {
  sm: 'px-6',
  md: 'px-6',
  lg: 'px-[26px]',
}

const BASE_SHADOW = '0 40px 120px rgba(0,0,0,.7), inset 0 1px 0 rgba(255,255,255,.07)'

/** Frame edge + bloom, keyed by tone. The bloom is a touch stronger on the confirms. */
const toneFrame = {
  accent: {
    border: 'border-accent/40',
    corner: 'border-accent',
    eyebrow: 'text-accent',
    dot: 'bg-accent shadow-[0_0_8px_#59e4f3]',
    bloom: '0 0 60px rgba(89,228,243,.12)',
  },
  warning: {
    border: 'border-[rgba(251,169,98,.4)]',
    corner: 'border-warning',
    eyebrow: 'text-warning',
    dot: 'bg-[#fba962] shadow-[0_0_8px_#fba962]',
    bloom: '0 0 60px rgba(251,169,98,.12)',
  },
} as const

export function Dialog({
  open,
  title,
  eyebrow,
  size = 'md',
  tone = 'accent',
  eyebrowPulse = false,
  footer,
  footerCaption,
  onClose,
  children,
}: DialogProps) {
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) return null

  const frame = toneFrame[tone]
  // Only the form dialog (1d) rules off its header; the confirms run the
  // eyebrow, title and body together as one padded block.
  const ruledHeader = size === 'lg'

  // Portalled to <body> on purpose. `StopDialog`/`ClearDialog` are rendered
  // from inside `DetailPanel`, whose glass uses `backdrop-filter` — and a
  // filtered ancestor becomes the containing block for `position: fixed`
  // descendants, which would trap the overlay (scrim included) inside the
  // 450px panel instead of covering the viewport.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(2,4,9,.55)] p-6 backdrop-blur-[3px]"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-size={size}
        data-tone={tone}
        style={{ boxShadow: `${BASE_SHADOW}, ${frame.bloom}` }}
        className={[
          'relative flex max-h-full max-w-full flex-col border font-sans text-text-bright backdrop-blur-[28px]',
          sizeClasses[size],
          frame.border,
        ].join(' ')}
      >
        {corners.map((corner) => (
          <span
            key={corner}
            aria-hidden
            data-corner={corner}
            className={`${cornerBase[corner]} ${cornerRadius[size][corner]} ${frame.corner}`}
          />
        ))}
        <header
          className={[
            'flex shrink-0 items-center gap-3 pt-[22px]',
            ruledHeader ? 'border-b border-[rgba(150,205,255,.1)] pb-[18px]' : 'pb-0',
            gutter[size],
          ].join(' ')}
        >
          <div className="min-w-0 flex-1">
            {eyebrow && (
              <div
                className={`flex items-center gap-2 font-mono text-[10px] tracking-[0.2em] ${frame.eyebrow}`}
              >
                {eyebrowPulse && (
                  <span
                    aria-hidden
                    className={`orbital-pulse h-[7px] w-[7px] shrink-0 rounded-full ${frame.dot}`}
                  />
                )}
                {eyebrow}
              </div>
            )}
            <h2
              className={[
                'truncate font-bold tracking-[-0.01em] text-text-bright',
                // 1d's form dialog runs a notch larger than the confirms.
                size === 'lg' ? 'mt-1 text-xl' : 'mt-2 text-[19px]',
              ].join(' ')}
            >
              {title}
            </h2>
          </div>
          {/* Only the form dialog carries a close affordance, and the export
              draws it as an `esc` keycap rather than an ✕. The confirms rely
              on their footer's "esc cancel" hint (1g/1b). */}
          {ruledHeader && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              className="shrink-0 self-start rounded border border-[rgba(150,205,255,.2)] px-[7px] py-[3px] font-mono text-[10px] text-[rgba(200,220,245,.7)] transition-colors hover:bg-white/5"
            >
              esc
            </button>
          )}
        </header>
        <div
          className={[
            'min-h-0 flex-1 overflow-y-auto',
            ruledHeader ? 'py-5' : 'pb-[18px] pt-2.5',
            gutter[size],
          ].join(' ')}
        >
          {children}
        </div>
        {(footer || footerCaption) && (
          <footer
            className={[
              'flex shrink-0 items-center gap-2.5 border-t border-[rgba(150,205,255,.1)]',
              ruledHeader ? 'pt-4 pb-5' : 'pt-3.5 pb-[18px]',
              gutter[size],
            ].join(' ')}
          >
            <div className="min-w-0 flex-1 truncate font-mono text-[10.5px] tracking-[0.06em] text-[rgba(160,190,225,.55)]">
              {footerCaption}
            </div>
            <div className="flex shrink-0 items-center gap-2.5">{footer}</div>
          </footer>
        )}
      </div>
    </div>,
    document.body,
  )
}
