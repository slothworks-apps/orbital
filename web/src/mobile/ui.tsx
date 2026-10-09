import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { usePresence } from '../ui/usePresence'
import { registerSheet } from './state'

/**
 * One phone screen (9a–9i): the header pinned at the top, the body
 * scrolling under it (or, with `scroll={false}`, handing the height to a
 * child that scrolls itself — the transcript), an optional footer pinned
 * at the bottom.
 */
export function MobileScreen({
  header,
  children,
  footer,
  scroll = true,
  divider = true,
  glow = false,
}: {
  header?: ReactNode
  children: ReactNode
  footer?: ReactNode
  scroll?: boolean
  /** The header's bottom rule; 9a's list header runs straight into its chips without one. */
  divider?: boolean
  /** 9a's faint violet and cyan light behind the list. */
  glow?: boolean
}) {
  return (
    <main className="relative flex h-full min-h-0 flex-col">
      {glow && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_320px_260px_at_20%_10%,rgba(110,80,220,.13),transparent),radial-gradient(ellipse_360px_300px_at_90%_85%,rgba(40,170,220,.08),transparent)]"
        />
      )}
      {header && (
        <header className={['relative shrink-0', divider ? 'border-b border-panel-border bg-[rgba(5,7,13,.92)]' : ''].join(' ')}>
          {header}
        </header>
      )}
      <div className={['relative', scroll ? 'min-h-0 flex-1 overflow-y-auto' : 'flex min-h-0 flex-1 flex-col'].join(' ')}>
        {children}
      </div>
      {footer && <div className="relative shrink-0">{footer}</div>}
    </main>
  )
}

/**
 * 9a–9i's two button kinds: filled cyan for the screen's one action, outlined
 * for the rest. `sheet` is the pair inside a bottom sheet (canvas 10b, 10g):
 * a tighter glow on the primary, a smaller label and a brighter rule on the
 * secondary.
 */
type ButtonProps = {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  type?: 'button' | 'submit'
  variant?: 'screen' | 'sheet'
}

/**
 * `ready={false}` is the primary that cannot be pressed yet because the
 * user still has something to choose (canvas `Feature - MCP approval`
 * 47c/47d): an outline in the muted ink rather than the faded fill
 * `disabled` gives, announced as `aria-disabled`. A press does nothing.
 */
export function PrimaryButton({
  children, onClick, disabled, type = 'button', variant = 'screen', ready = true,
}: ButtonProps & { ready?: boolean }) {
  return (
    <button
      type={type}
      onClick={ready ? onClick : undefined}
      disabled={disabled}
      aria-disabled={ready ? undefined : true}
      className={[
        'flex h-13 w-full items-center justify-center gap-2.5 rounded-[14px] px-4 text-[15px] font-bold',
        ready
          ? 'bg-[oklch(85%_.12_205)] text-[#03111a] disabled:opacity-35 disabled:shadow-none'
          : 'cursor-default border border-[rgba(150,205,255,.14)] bg-transparent text-[rgba(160,190,225,.5)]',
        !ready ? '' : variant === 'sheet' ? 'shadow-[0_0_18px_oklch(85%_.12_205/.3)]' : 'shadow-[0_0_22px_oklch(85%_.12_205/.3)]',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

export function SecondaryButton({ children, onClick, disabled, type = 'button', variant = 'screen' }: ButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={[
        'flex h-13 w-full items-center justify-center rounded-[14px] border px-4 font-semibold text-text-bright disabled:opacity-40',
        variant === 'sheet' ? 'border-[rgba(150,205,255,.22)] text-[14px]' : 'border-[rgba(150,205,255,.2)] text-[15px]',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

/**
 * 9f's switch: a 40×24 track inside a 56×44 target. On, the track is lit cyan
 * and the knob goes dark; off, a faint track and a pale knob.
 */
export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="grid h-11 w-14 shrink-0 place-items-center disabled:opacity-40"
    >
      <span
        aria-hidden
        className={[
          'relative block h-6 w-10 rounded-full transition-[background-color] duration-[180ms] ease-out',
          checked ? 'bg-[oklch(85%_.12_205)] shadow-[0_0_10px_oklch(85%_.12_205/.45)]' : 'bg-[rgba(150,205,255,.16)]',
        ].join(' ')}
      >
        <span
          className={[
            'absolute top-[3px] block h-[18px] w-[18px] rounded-full transition-[left] duration-[180ms] ease-out',
            checked ? 'left-[19px] bg-[#03111a]' : 'left-[3px] bg-[rgba(220,235,255,.85)]',
          ].join(' ')}
        />
      </span>
    </button>
  )
}

/** 9f's section label over a card: mono caps, indented to the card's text. */
export function SectionLabel({ children, first = false }: { children: ReactNode; first?: boolean }) {
  return (
    <div className={['px-1 pb-2 font-mono text-[10px] tracking-[0.16em] text-[rgba(160,190,225,.6)]', first ? 'pt-3' : 'pt-5'].join(' ')}>
      {children}
    </div>
  )
}

/** 9d's section label, with the list's hint on its right. */
export function FieldLabel({ children, hint }: { children: string; hint?: string }) {
  return (
    <div className="flex items-baseline font-mono text-[10px] tracking-[0.16em] text-[rgba(160,190,225,.6)]">
      {children}
      {hint && <span className="ml-auto min-w-0 truncate pl-3 tracking-[0.04em] text-[rgba(160,190,225,.45)]">{hint}</span>}
    </div>
  )
}

/** 9f's grouped card: rows inside, hairlines between them. */
export const CARD = 'overflow-hidden rounded-[14px] border border-[rgba(150,205,255,.12)] bg-[rgba(10,16,28,.6)]'

/**
 * 9h and 9i's mark: the Orbital ring and its moon drawn in grey — news, not
 * an error, so no red and no warning icon.
 */
export function QuietMark() {
  return (
    <span aria-hidden className="relative block h-16 w-16 rounded-full border-[1.5px] border-[rgba(200,215,235,.4)]">
      <span className="absolute -right-1.5 top-1 block h-3 w-3 rounded-full border-[1.5px] border-[rgba(200,215,235,.4)] bg-space" />
    </span>
  )
}

/**
 * The message's inset inside a notice screen: `default` is canvas 9i
 * (0 28px 40px); `wide` is 9s (0 32px 60px), a shorter message held a
 * little higher and narrower.
 */
const NOTICE_INSETS = {
  default: 'px-7 pb-10',
  wide: 'px-8 pb-15',
} as const

/** A 9h/9i/9s screen: the message centred in the space, the actions pinned at the bottom. */
export function NoticeScreen({
  children, actions, inset = 'default',
}: { children: ReactNode; actions: ReactNode; inset?: keyof typeof NOTICE_INSETS }) {
  return (
    <MobileScreen footer={<div className="flex flex-col gap-2 px-4 pb-1.5 pt-2.5">{actions}</div>}>
      <div className={['flex min-h-full flex-col items-center justify-center gap-4 text-center', NOTICE_INSETS[inset]].join(' ')}>
        <QuietMark />
        {children}
      </div>
    </MobileScreen>
  )
}

/**
 * The Orbital mark lit in the accent: a ring with its moon on the rim.
 * `paired` is 9e's paired step, with the check inside; `lock` is 9t, the
 * bare mark with a slightly softer glow.
 */
export function LitMark({ variant }: { variant: 'paired' | 'lock' }) {
  return (
    <span
      aria-hidden
      className={[
        'relative grid h-[72px] w-[72px] place-items-center rounded-full border-2 border-[oklch(85%_.12_205)] text-[26px] text-[oklch(85%_.12_205)]',
        variant === 'paired' ? 'shadow-[0_0_30px_oklch(85%_.12_205/.4)]' : 'shadow-[0_0_30px_oklch(85%_.12_205/.35)]',
      ].join(' ')}
    >
      {variant === 'paired' && '✓'}
      <span className="absolute right-0.5 top-0.5 block h-3.5 w-3.5 rounded-full bg-[oklch(85%_.12_205)] shadow-[0_0_12px_oklch(85%_.12_205)]" />
    </span>
  )
}

/**
 * The dropdown shell every phone sheet is drawn in (canvas 10i, "ONE SHEET";
 * 10b and 10g's confirms use the same one): a dimmed backdrop whose tap
 * dismisses, and a panel rising from the bottom edge with a grab handle.
 * Render it inside a `SheetPresence` while open, and drop it to close; the
 * presence keeps it long enough to sink out. What is inside is the caller's
 * and can be swapped in place — 10i's End and Clear replace the menu with
 * their confirm in the same sheet, no second layer.
 */
/** How far down a touch on a `swipeToDismiss` sheet must travel before it goes. */
const SHEET_SWIPE_DISMISS_PX = 60

/**
 * Per variant: the backdrop, the panel and the grab handle's row.
 * `menu` is canvas 10i (the shell; 10b and 10g use the same values).
 * `question` is `Feature - MCP approval` 47c/47d: a step on top of a filled-in
 * form, so the form shows through a lighter dim with a slight blur, and the
 * panel is a column whose middle scrolls between a fixed head and foot, up
 * to 752 of 844 px — 92 px of the form always shows above it.
 */
const SHEET_VARIANTS = {
  menu: {
    backdrop: 'bg-[rgba(2,3,8,.62)]',
    panel:
      'rounded-t-[22px] border border-b-0 border-[rgba(150,205,255,.16)] bg-[rgba(10,16,28,.96)] px-2.5 shadow-[0_-20px_60px_rgba(0,0,0,.6)]',
    handle: 'h-[22px]',
  },
  question: {
    backdrop: 'bg-[rgba(2,4,9,.6)] backdrop-blur-[2px]',
    panel:
      'flex max-h-[calc(100%-92px)] flex-col rounded-t-[24px] border-t border-[rgba(150,205,255,.2)] bg-[linear-gradient(180deg,rgba(16,22,38,.97),rgba(8,12,22,.99))] shadow-[0_-20px_60px_rgba(0,0,0,.6),inset_0_1px_0_rgba(255,255,255,.07)]',
    handle: 'h-5 shrink-0',
  },
} as const

export function BottomSheet({
  label,
  onDismiss,
  variant = 'menu',
  swipeToDismiss = false,
  children,
}: {
  /** The sheet's accessible name: its title, or what its menu is for. */
  label: string
  /** Backdrop tap and the hardware back button — and a swipe down, with `swipeToDismiss`. */
  onDismiss: () => void
  variant?: keyof typeof SHEET_VARIANTS
  /**
   * A downward swipe on the sheet dismisses it too (47c "WHY A SHEET"). A
   * swipe that starts inside a list scrolled away from its top scrolls the
   * list instead; mark such a list `data-sheet-scroll`.
   */
  swipeToDismiss?: boolean
  children: ReactNode
}) {
  const entry = useRef({ dismiss: onDismiss })
  entry.current.dismiss = onDismiss
  useEffect(() => registerSheet(entry.current), [])
  const touchY = useRef<number | null>(null)
  const look = SHEET_VARIANTS[variant]

  // The canvas's bottom row is the phone's home indicator, so it becomes the
  // safe-area inset, and never less than that row.
  return (
    <div className="fixed inset-0 z-20 flex flex-col justify-end">
      <div aria-hidden onClick={onDismiss} className={['orbital-sheet-backdrop absolute inset-0', look.backdrop].join(' ')} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onTouchStart={
          swipeToDismiss
            ? (event) => {
                const scroller = (event.target as Element).closest('[data-sheet-scroll]')
                touchY.current = scroller && scroller.scrollTop > 0 ? null : event.touches[0].clientY
              }
            : undefined
        }
        onTouchMove={
          swipeToDismiss
            ? (event) => {
                if (touchY.current === null) return
                if (event.touches[0].clientY - touchY.current > SHEET_SWIPE_DISMISS_PX) {
                  touchY.current = null
                  onDismiss()
                }
              }
            : undefined
        }
        onTouchEnd={swipeToDismiss ? () => (touchY.current = null) : undefined}
        className={['orbital-sheet-panel relative pb-[max(22px,env(safe-area-inset-bottom))]', look.panel].join(' ')}
      >
        <div aria-hidden className={['grid place-items-center', look.handle].join(' ')}>
          <span className="block h-1 w-9 rounded-[2px] bg-[rgba(200,220,245,.3)]" />
        </div>
        {children}
      </div>
    </div>
  )
}

/** How long a closing sheet stays mounted while it sinks (`--sheet-exit` in `mobile.css`). */
const SHEET_EXIT_MS = 200

function present(node: ReactNode): boolean {
  return node !== null && node !== undefined && node !== false
}

/**
 * Where a sheet is opened: `<SheetPresence>{open && <SomeSheet … />}</SheetPresence>`.
 * When the condition turns false, the sheet it last rendered stays for
 * `SHEET_EXIT_MS` under `data-sheet-leaving`, so it sinks out instead of
 * vanishing — however it was closed: the backdrop, the back button, a swipe,
 * or the caller's own state after an action. Reopened meanwhile, it rises
 * again. An overlay that is not a `BottomSheet` opts in with the
 * `orbital-sheet-backdrop` and `orbital-sheet-panel` classes.
 */
export function SheetPresence({ children }: { children: ReactNode }) {
  const open = present(children)
  // The way in is a CSS animation that runs on mount, so it needs no hold.
  const { mounted } = usePresence(open, 0, SHEET_EXIT_MS)
  const [last, setLast] = useState(children)
  if (open && children !== last) setLast(children)
  if (!open && !mounted) return null

  return (
    <div
      className="contents"
      data-sheet-leaving={open ? undefined : ''}
      style={{ '--sheet-exit': `${SHEET_EXIT_MS}ms` } as CSSProperties}
    >
      {open ? children : last}
    </div>
  )
}

interface ConfirmProps {
  /** Mono caps over the title, in cyan: GO BACK · STEP 04, STOP TASK, /END, /CLEAR. */
  eyebrow: string
  title: string
  body: ReactNode
  /** 10b's mono well under the body (the commit range); absent elsewhere. */
  detail?: ReactNode
  confirmLabel: string
  /** The outlined button's label: Cancel, or 10g's "Keep running". */
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
  /** While the confirmed action is on its way, so it is not sent twice. */
  busy?: boolean
}

/**
 * What a deliberate action asks before it happens (spec 2026-10-05-mobile-next
 * § 0): eyebrow, title, body, then a cyan primary with an outlined Cancel
 * directly below. No red. On its own inside a `BottomSheet` (`ConfirmSheet`),
 * or swapped in place of a menu's rows (10i's /END and /CLEAR).
 */
export function ConfirmBody({
  eyebrow, title, body, detail, confirmLabel, cancelLabel = 'Cancel', onConfirm, onCancel, busy = false,
}: ConfirmProps) {
  // canvas 10b GO BACK, 10g STOP TASK: the sheet's text sits 18 px in, the
  // shell's 10 plus this block's 8 (10i's confirms nest the same way).
  return (
    <div className="px-2">
      <div className="pt-1.5 font-mono text-[10px] tracking-[0.2em] text-[oklch(85%_.12_205)]">{eyebrow}</div>
      <h2 className="mt-2 text-[19px] font-bold tracking-[-0.01em]">{title}</h2>
      <div className="mt-2.5 text-[13.5px] leading-[1.55] text-pretty text-[rgba(200,214,235,.85)]">{body}</div>
      {detail && (
        <div className="mt-3 rounded-[10px] border border-[rgba(150,205,255,.12)] bg-[rgba(3,6,12,.6)] px-3 py-2.5 font-mono text-[11px] leading-[1.6] text-[rgba(200,220,245,.8)]">
          {detail}
        </div>
      )}
      <div className="flex flex-col gap-2 pb-2.5 pt-[18px]">
        <PrimaryButton variant="sheet" onClick={onConfirm} disabled={busy}>{confirmLabel}</PrimaryButton>
        <SecondaryButton variant="sheet" onClick={onCancel}>{cancelLabel}</SecondaryButton>
      </div>
    </div>
  )
}

/** A confirm in a sheet of its own (canvas 10b GO BACK, 10g STOP TASK); the backdrop cancels. */
export function ConfirmSheet(props: ConfirmProps) {
  return (
    <BottomSheet label={props.title} onDismiss={props.onCancel}>
      <ConfirmBody {...props} />
    </BottomSheet>
  )
}

/**
 * The one cyan line an answer folds into at the end of the transcript (canvas
 * 10b `gateAck*`, 10i after End or Clear): a mark, then what just happened.
 */
export function AckLine({ mark, children, className = '' }: { mark: string; children: ReactNode; className?: string }) {
  return (
    <div
      role="status"
      className={`flex min-h-12 items-center gap-2.5 rounded-[12px] border border-[oklch(85%_.12_205/.35)] bg-[oklch(85%_.12_205/.1)] px-3 text-[13.5px] ${className}`}
    >
      <span aria-hidden className="text-[oklch(85%_.12_205)]">{mark}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}
