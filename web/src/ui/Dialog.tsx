import { useCallback, useLayoutEffect, useRef, useState } from 'react'
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
  variant?: 'frame' | 'card' | 'review'
  /**
   * Caps the frame's height (canvas 5b/61a: the error log stops at 720px);
   * past it the body scrolls inside. The viewport stays the cap below that.
   */
  maxHeight?: number
  /**
   * Keeps the top edge where it opened. A centred dialog whose content
   * changes in place (a row leaving the error log, a state line growing)
   * would otherwise move as a whole — half the change at the top, half at
   * the bottom. Anchored, it opens centred and then grows and shrinks from
   * its bottom edge only, still capped at the viewport.
   */
  anchorTop?: boolean
  /**
   * Card variant only: content between the muted eyebrow and the title
   * (canvas 50c: the kind tile above the join sentence; `cDone`: the
   * checkmark above "<name> joined"). Unset everywhere else, so no other
   * caller's layout changes.
   */
  beforeTitle?: ReactNode
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
  sm: 'w-[440px] bg-gradient-to-b from-raised/94 to-space-deep/97',
  md: 'w-[560px] bg-gradient-to-b from-raised/94 to-space-deep/97',
  lg: 'w-[660px] bg-gradient-to-b from-raised/90 to-space-deep/94',
  xl: 'w-[760px] bg-gradient-to-b from-raised/90 to-space-deep/94',
}

/** Inner gutter: confirms sit at 24px, the form dialogs at 26px. */
const gutter: Record<NonNullable<DialogProps['size']>, string> = {
  sm: 'px-6',
  md: 'px-6',
  lg: 'px-[26px]',
  xl: 'px-[26px]',
}

const BASE_SHADOW = '0 40px 120px color-mix(in oklab, var(--color-shadow) 70%, transparent), inset 0 1px 0 color-mix(in oklab, var(--color-highlight) 7%, transparent)'

/** Frame edge + bloom, keyed by tone. The bloom is a touch stronger on the confirms. */
const toneFrame = {
  accent: {
    border: 'border-accent/40',
    corner: 'border-accent',
    eyebrow: 'text-accent',
    dot: 'bg-accent shadow-[0_0_8px_var(--color-accent)]',
    bloom: '0 0 60px color-mix(in oklab, var(--color-accent) 12%, transparent)',
  },
  warning: {
    border: 'border-warning-deep/40',
    corner: 'border-warning',
    eyebrow: 'text-warning',
    dot: 'bg-warning-deep shadow-[0_0_8px_var(--color-warning-deep)]',
    bloom: '0 0 60px color-mix(in oklab, var(--color-warning-deep) 12%, transparent)',
  },
} as const

export function Dialog({
  open,
  title,
  eyebrow,
  beforeTitle,
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
  maxHeight,
  anchorTop = false,
  onClose,
  children,
}: DialogProps) {
  useEscapeLayer(open, onClose)
  // Held mounted through the close transition — a dialog that unmounts the
  // instant `open` goes false can only ever animate in.
  const { mounted, state } = usePresence(open, MODAL_ENTER_MS, MODAL_EXIT_MS)

  // `anchorTop`: the surface's top as a margin under the scrim's padding. It
  // never sits lower than centred for the current height — so content that
  // arrives after opening still lands centred, and growth never pushes the
  // bottom off screen — and a shrink leaves it where it is, which is the whole
  // point: the rows above a leaving one stay put. The height cap stays the
  // whole scrim, never "what is left below the anchor": a cap that depended
  // on the anchor would freeze the dialog at the height it opened with.
  const surface = useRef<HTMLElement | null>(null)
  const [anchor, setAnchor] = useState<number | null>(null)
  const setSurface = useCallback(
    (element: HTMLElement | null) => {
      surface.current = element
      surfaceRef?.(element)
    },
    [surfaceRef],
  )
  useLayoutEffect(() => {
    const element = surface.current
    const scrim = element?.parentElement
    if (!anchorTop || !mounted || !element || !scrim || typeof ResizeObserver === 'undefined') {
      setAnchor(null)
      return
    }
    const place = (fresh: boolean) => {
      const style = getComputedStyle(scrim)
      const room = scrim.clientHeight - parseFloat(style.paddingTop || '0') - parseFloat(style.paddingBottom || '0')
      // `offsetHeight` ignores the entrance's scale, so this is the resting size.
      const centred = Math.max(0, Math.round((room - element.offsetHeight) / 2))
      setAnchor((current) => (fresh || current === null ? centred : Math.min(current, centred)))
    }
    place(true)
    const observer = new ResizeObserver(() => place(false))
    observer.observe(element)
    // A resized window centres afresh.
    const recentre = () => place(true)
    window.addEventListener('resize', recentre)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', recentre)
    }
  }, [anchorTop, mounted])
  const anchored = anchorTop && anchor !== null

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
        // The review dialog stacks over the dialog it came from (canvas
        // 61a/61c): a plain .5 scrim, no second blur, and above the first.
        variant === 'review'
          ? 'orbital-no-drag fixed inset-0 z-[55] flex items-center justify-center bg-space/50 p-6'
          : 'orbital-no-drag fixed inset-0 z-50 flex items-center justify-center bg-space/55 p-6 backdrop-blur-[3px]',
        anchored ? '!items-start' : '',
        MODAL_TRANSITION,
        duration,
        entered ? SCRIM_OPEN : SCRIM_CLOSED,
        state === 'exiting' ? EXITING : '',
      ].join(' ')}
    >
      {variant === 'review' ? (
        // `Report Dialog` (canvas `Feature - Feedback` 61d): 900px, a 16px
        // radius over a .2 hairline, no corner brackets and no bloom. The
        // caller draws the header, body and footer; this owns the scrim, the
        // motion, Escape and the cap at the viewport.
        <div
          ref={setSurface}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          data-variant="review"
          style={{
            boxShadow: BASE_SHADOW,
            ...(anchored && { marginTop: anchor }),
          }}
          className={[
            'relative flex max-h-full w-[900px] max-w-full flex-col rounded-2xl border border-line/20 bg-gradient-to-b from-raised/97 to-space-deep/98 text-left font-sans text-ink-100 backdrop-blur-[28px]',
            MODAL_TRANSITION,
            duration,
            entered ? MODAL_OPEN : MODAL_CLOSED,
          ].join(' ')}
        >
          {children}
        </div>
      ) : variant === 'card' ? (
        // Canvas 9o: 460px, 28/30/24 padding, 16px radius, a .2 hairline and
        // a plain drop shadow; every row centred with a 16px gap.
        <div
          ref={setSurface}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          data-variant="card"
          style={{ boxShadow: '0 40px 100px color-mix(in oklab, var(--color-shadow) 70%, transparent)' }}
          className={[
            'relative flex max-h-full w-[460px] max-w-full flex-col items-center gap-4 overflow-y-auto rounded-2xl border border-line/20 bg-gradient-to-b from-panel-solid/97 to-space-deep/99 px-[30px] pb-6 pt-7 text-center font-sans text-ink-100',
            MODAL_TRANSITION,
            duration,
            entered ? MODAL_OPEN : MODAL_CLOSED,
          ].join(' ')}
        >
          {eyebrow && (
            <div className="font-mono fs-9.5 tracking-[0.2em] text-ink-900/55">{eyebrow}</div>
          )}
          {beforeTitle}
          <h2 className="fs-20 leading-(--text-xl--line-height) font-bold text-ink-100">{title}</h2>
          {children}
        </div>
      ) : (
      <div
        ref={setSurface}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-size={size}
        data-tone={tone}
        data-drop-armed={dropArmed || undefined}
        style={{
          boxShadow: `${BASE_SHADOW}, ${frame.bloom}`,
          ...(maxHeight !== undefined && { maxHeight: `min(100%, ${maxHeight}px)` }),
          ...(anchored && { marginTop: anchor }),
        }}
        className={[
          'relative flex max-h-full max-w-full flex-col border font-sans text-ink-100 backdrop-blur-[28px]',
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
            ruledHeader ? 'border-b border-line/10 pb-[18px]' : 'pb-0',
            gutter[size],
          ].join(' ')}
        >
          <div className="min-w-0 flex-1">
            {eyebrow && (
              <div
                className={`flex items-center gap-2 font-mono fs-10 tracking-[0.2em] ${frame.eyebrow}`}
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
                'truncate font-bold tracking-[-0.01em] text-ink-100',
                // The form dialogs run a notch larger than the confirms.
                ruledHeader ? 'mt-1 fs-20 leading-(--text-xl--line-height)' : 'mt-2 fs-19',
              ].join(' ')}
            >
              {title}
            </h2>
          </div>
          {headerMeta != null && (
            <span className="shrink-0 self-start font-mono fs-10.5 tracking-[0.06em] text-ink-900/55">
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
              className={`shrink-0 ${headerAction != null ? 'self-center' : 'self-start'} rounded border border-line/20 px-[7px] py-[3px] font-mono fs-10 text-ink-500/70 transition-colors hover:bg-white/5`}
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
              'flex shrink-0 items-center gap-2.5 border-t border-line/10',
              ruledHeader ? 'pt-4 pb-5' : 'pt-3.5 pb-[18px]',
              gutter[size],
            ].join(' ')}
          >
            {footerLead != null && <div className="flex min-w-0 items-center gap-2">{footerLead}</div>}
            <div className="min-w-0 flex-1 truncate font-mono fs-10.5 tracking-[0.06em] text-ink-900/55">
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
              ? 'border-accent/45 shadow-[inset_0_0_0_1px_oklch(85%_.12_205_/_.12)]'
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
