import { createPortal } from 'react-dom'
import { EscapeBoundary, useEscapeLayer } from './escapeLayer'
import { usePresence } from './usePresence'
import {
  MODAL_CLOSED,
  MODAL_ENTER_DURATION,
  MODAL_ENTER_MS,
  MODAL_EXIT_DURATION,
  MODAL_EXIT_MS,
  MODAL_OPEN,
  MODAL_TRANSITION,
  SCRIM_CLOSED,
  SCRIM_OPEN,
  EXITING,
} from './motion'
import type { ReactNode } from 'react'

export interface DialogProps {
  open: boolean
  title: string
  /**
   * Mono uppercase kicker above the title (e.g. "LAUNCH", "/clear"). A node
   * for the MCP dialog's form, whose kicker is its "← SERVERS" back link
   * (canvas `Feature - MCP dialog` 12a).
   */
  eyebrow?: ReactNode
  /**
   * Panel width and chrome, straight off the export:
   * `sm` = 440px stop confirm (1b), `md` = 560px clear confirm (1g),
   * `lg` = 660px form dialog with a ruled header (1d),
   * `xl` = 760px error log (canvas 5b) — lg's chrome, one step wider.
   */
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /** Mono muted line on the ruled header's right, before the esc keycap
   * (5b: "12 entries · 3 unseen cleared"). */
  headerMeta?: ReactNode
  /**
   * A control on the ruled header, beside the esc keycap (canvas 44c: New
   * session's CLAUDE DIR trigger with four or more directories). The pair
   * then centres on the title block, the way 44c draws it.
   */
  headerAction?: ReactNode
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
  /**
   * The footer's far left, before the caption: the MCP dialog's "+ Add
   * server" and its form's "Remove server" (canvas 12a/12b), which sit where
   * the other dialogs put their hints.
   */
  footerLead?: ReactNode
  /**
   * A block between the scrolling body and the footer that stays put while
   * the body scrolls — the MCP dialog's restart banner and its "CLI refused"
   * block (canvas 12a/12b).
   */
  aboveFooter?: ReactNode
  /**
   * A block between the ruled header and the scrolling body that stays put
   * while the body scrolls — the `.mcp.json` question's intro over its list
   * of servers (canvas `Feature - MCP approval` 47a/47b). Its text is the
   * caller's; the dialog only places it.
   */
  lead?: ReactNode
  /**
   * The scrolling body's vertical inset: `form`, the field groups' 20px
   * (1d), or `list`, rows that carry their own padding and run up under a
   * `lead` (47a/47b: 4px over the first row, 12px under the last).
   */
  bodyInset?: 'form' | 'list'
  /**
   * Attaches to the dialog's own surface. The New Session dialog's image intake
   * needs it because 9d-D's drop target is the DIALOG, not the composer's well
   * — the same reason the detail panel arms its whole shell (canvas 9c-1) — and
   * that element is this component's, not the caller's.
   *
   * A callback ref, not a `useRef` object: the surface is unmounted between
   * opens, so an effect keyed on a ref object would bind its listeners on the
   * one render where the element did not exist yet. See `useImageDrop`.
   */
  surfaceRef?: (element: HTMLElement | null) => void
  /**
   * `card` (canvas `Feature - Mobile` 9o, the Mac's pairing confirmation):
   * one centred column — muted eyebrow, title, then the caller's content and
   * buttons — in a plain-bordered 460px card with no corner brackets, no
   * bloom and no footer row. `size`, `tone` and the footer props do not
   * apply to it.
   */
  variant?: 'frame' | 'card'
  /**
   * Paints the armed drop chrome over the frame (canvas 9c-1 / 9e drop state:
   * accent border `.45` over a matching inset ring `.12`). The caller owns the
   * drag itself and dims its own content.
   */
  dropArmed?: boolean
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

const XL_CORNERS = {
  tl: 'h-[18px] w-[18px] rounded-tl-2xl',
  tr: 'h-[18px] w-[18px] rounded-tr-2xl',
  bl: 'h-[18px] w-[18px] rounded-bl-2xl',
  br: 'h-[18px] w-[18px] rounded-br-2xl',
}

const cornerRadius: Record<
  'sm' | 'md' | 'lg' | 'xl',
  Record<'tl' | 'tr' | 'bl' | 'br', string>
> = {
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
  lg: XL_CORNERS,
  xl: XL_CORNERS,
}

const corners = ['tl', 'tr', 'bl', 'br'] as const

/**
 * Frame radius per artboard. Its own map because the armed drop overlay is
 * drawn as a second box over the frame and has to match it exactly — one
 * definition, so the two cannot drift.
 */
const frameRadius: Record<NonNullable<DialogProps['size']>, string> = {
  sm: 'rounded-[14px]',
  md: 'rounded-[14px]',
  lg: 'rounded-2xl',
  xl: 'rounded-2xl',
}

/** Width + glass fill per artboard. */
const sizeClasses: Record<NonNullable<DialogProps['size']>, string> = {
  sm: 'w-[440px] bg-gradient-to-b from-[rgba(16,22,38,.94)] to-[rgba(8,12,22,.97)]',
  md: 'w-[560px] bg-gradient-to-b from-[rgba(16,22,38,.94)] to-[rgba(8,12,22,.97)]',
  lg: 'w-[660px] bg-gradient-to-b from-[rgba(16,22,38,.9)] to-[rgba(8,12,22,.94)]',
  xl: 'w-[760px] bg-gradient-to-b from-[rgba(16,22,38,.9)] to-[rgba(8,12,22,.94)]',
}

/** Inner gutter: confirms sit at 24px, the form dialogs at 26px. */
const gutter: Record<NonNullable<DialogProps['size']>, string> = {
  sm: 'px-6',
  md: 'px-6',
  lg: 'px-[26px]',
  xl: 'px-[26px]',
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
  headerMeta,
  headerAction,
  footer,
  footerCaption,
  footerLead,
  aboveFooter,
  lead,
  bodyInset = 'form',
  surfaceRef,
  dropArmed = false,
  variant = 'frame',
  onClose,
  children,
}: DialogProps) {
  useEscapeLayer(open, onClose)
  // Held mounted through the close transition — a dialog that unmounts the
  // instant `open` goes false can only ever animate in.
  const { mounted, state } = usePresence(open, MODAL_ENTER_MS, MODAL_EXIT_MS)

  if (!mounted) return null

  const entered = state === 'entered'
  const duration = state === 'exiting' ? MODAL_EXIT_DURATION : MODAL_ENTER_DURATION
  const frame = toneFrame[tone]
  // Only the form dialogs (1d, 5b) rule off their header; the confirms run
  // the eyebrow, title and body together as one padded block.
  const ruledHeader = size === 'lg' || size === 'xl'

  // Portalled to <body> on purpose. `StopDialog`/`ClearDialog` are rendered
  // from inside `DetailPanel`, and any ancestor with a `backdrop-filter`,
  // `transform` or `filter` becomes the containing block for `position:
  // fixed` descendants, which would trap the overlay (scrim included) inside
  // the 450px panel instead of covering the viewport. The docked panels no
  // longer blur, but the portal keeps that from depending on their chrome.
  return createPortal(
    <EscapeBoundary>
    <div
      data-state={state}
      // On the way out it is still painted but must stop taking clicks and
      // leave the focus order — see EXITING in `ui/motion`.
      inert={state === 'exiting' || undefined}
      className={[
        'orbital-no-drag fixed inset-0 z-50 flex items-center justify-center bg-[rgba(2,4,9,.55)] p-6 backdrop-blur-[3px]',
        MODAL_TRANSITION,
        duration,
        entered ? SCRIM_OPEN : SCRIM_CLOSED,
        state === 'exiting' ? EXITING : '',
      ].join(' ')}
    >
      {variant === 'card' ? (
        // Canvas 9o: 460px, 28/30/24 padding, 16px radius, a .2 hairline and
        // a plain drop shadow; every row centred with a 16px gap.
        <div
          ref={surfaceRef}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          data-variant="card"
          style={{ boxShadow: '0 40px 100px rgba(0,0,0,.7)' }}
          className={[
            'relative flex max-h-full w-[460px] max-w-full flex-col items-center gap-4 overflow-y-auto rounded-2xl border border-[rgba(150,205,255,.2)] bg-gradient-to-b from-[rgba(14,20,34,.97)] to-[rgba(8,12,22,.99)] px-[30px] pb-6 pt-7 text-center font-sans text-text-bright',
            MODAL_TRANSITION,
            duration,
            entered ? MODAL_OPEN : MODAL_CLOSED,
          ].join(' ')}
        >
          {eyebrow && (
            <div className="font-mono text-[9.5px] tracking-[0.2em] text-[rgba(160,190,225,.55)]">{eyebrow}</div>
          )}
          <h2 className="text-xl font-bold text-text-bright">{title}</h2>
          {children}
        </div>
      ) : (
      <div
        ref={surfaceRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-size={size}
        data-tone={tone}
        data-drop-armed={dropArmed || undefined}
        style={{ boxShadow: `${BASE_SHADOW}, ${frame.bloom}` }}
        className={[
          'relative flex max-h-full max-w-full flex-col border font-sans text-text-bright backdrop-blur-[28px]',
          sizeClasses[size],
          frameRadius[size],
          frame.border,
          MODAL_TRANSITION,
          duration,
          entered ? MODAL_OPEN : MODAL_CLOSED,
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
                // The form dialogs run a notch larger than the confirms.
                ruledHeader ? 'mt-1 text-xl' : 'mt-2 text-[19px]',
              ].join(' ')}
            >
              {title}
            </h2>
          </div>
          {headerMeta != null && (
            <span className="shrink-0 self-start font-mono text-[10.5px] tracking-[0.06em] text-[rgba(160,190,225,.55)]">
              {headerMeta}
            </span>
          )}
          {/* Only the form dialogs carry a close affordance, and the export
              draws it as an `esc` keycap rather than an ✕. The confirms rely
              on their footer's "esc cancel" hint (1g/1b). */}
          {headerAction != null && <div className="flex shrink-0 items-center">{headerAction}</div>}
          {ruledHeader && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              className={`shrink-0 ${headerAction != null ? 'self-center' : 'self-start'} rounded border border-[rgba(150,205,255,.2)] px-[7px] py-[3px] font-mono text-[10px] text-[rgba(200,220,245,.7)] transition-colors hover:bg-white/5`}
            >
              esc
            </button>
          )}
        </header>
        {lead != null && (
          // 47a/47b: 18px under the header rule, 6px over the list.
          <div className={['shrink-0 pb-1.5 pt-[18px]', gutter[size]].join(' ')}>{lead}</div>
        )}
        <div
          className={[
            'min-h-0 flex-1 overflow-y-auto',
            bodyInset === 'list' ? 'pb-3 pt-1' : ruledHeader ? 'py-5' : 'pb-[18px] pt-2.5',
            gutter[size],
          ].join(' ')}
        >
          {children}
        </div>
        {aboveFooter != null && (
          <div className={['shrink-0 pb-3.5', gutter[size]].join(' ')}>{aboveFooter}</div>
        )}
        {(footer || footerCaption || footerLead) && (
          <footer
            className={[
              'flex shrink-0 items-center gap-2.5 border-t border-[rgba(150,205,255,.1)]',
              ruledHeader ? 'pt-4 pb-5' : 'pt-3.5 pb-[18px]',
              gutter[size],
            ].join(' ')}
          >
            {footerLead != null && <div className="flex min-w-0 items-center gap-2">{footerLead}</div>}
            <div className="min-w-0 flex-1 truncate font-mono text-[10.5px] tracking-[0.06em] text-[rgba(160,190,225,.55)]">
              {footerCaption}
            </div>
            <div className="flex shrink-0 items-center gap-2.5">{footer}</div>
          </footer>
        )}
        {/* The armed drop chrome (canvas 9c-1 / 9e): accent border at .45 over a
            matching inset ring at .12, arriving over .12s.

            Its own overlay element rather than classes on the frame, for the two
            reasons the detail panel's is: the frame already carries
            MODAL_TRANSITION, and a second transition-property utility on one
            element resolves by stylesheet order rather than by intent (see
            web/CLAUDE.md); and the frame's box-shadow is an inline style the
            inset ring would have to fight. It never takes the pointer, so the
            drag still reaches the surface's own listeners. */}
        <div
          aria-hidden
          className={[
            'pointer-events-none absolute inset-0 border transition-[border-color,box-shadow] duration-[120ms] ease-in',
            frameRadius[size],
            dropArmed
              ? 'border-[oklch(85%_.12_205_/_.45)] shadow-[inset_0_0_0_1px_oklch(85%_.12_205_/_.12)]'
              : 'border-transparent',
          ].join(' ')}
        />
      </div>
      )}
    </div>
    </EscapeBoundary>,
    document.body,
  )
}
