import { useEffect, useRef, type ReactNode } from 'react'
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

export function PrimaryButton({ children, onClick, disabled, type = 'button', variant = 'screen' }: ButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={[
        'flex h-13 w-full items-center justify-center gap-2.5 rounded-[14px] bg-[oklch(85%_.12_205)] px-4 text-[15px] font-bold text-[#03111a] disabled:opacity-35 disabled:shadow-none',
        variant === 'sheet' ? 'shadow-[0_0_18px_oklch(85%_.12_205/.3)]' : 'shadow-[0_0_22px_oklch(85%_.12_205/.3)]',
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

/** A 9h/9i screen: the message centred in the space, the actions pinned at the bottom. */
export function NoticeScreen({ children, actions }: { children: ReactNode; actions: ReactNode }) {
  return (
    <MobileScreen footer={<div className="flex flex-col gap-2 px-4 pb-1.5 pt-2.5">{actions}</div>}>
      <div className="flex min-h-full flex-col items-center justify-center gap-4 px-7 pb-10 text-center">
        <QuietMark />
        {children}
      </div>
    </MobileScreen>
  )
}

/**
 * The dropdown shell every phone sheet is drawn in (canvas 10i, "ONE SHEET";
 * 10b and 10g's confirms use the same one): a dimmed backdrop whose tap
 * dismisses, and a panel rising from the bottom edge with a grab handle.
 * Render it while open, unmount it to close. What is inside is the caller's
 * and can be swapped in place — 10i's End and Clear replace the menu with
 * their confirm in the same sheet, no second layer.
 */
export function BottomSheet({
  label,
  onDismiss,
  children,
}: {
  /** The sheet's accessible name: its title, or what its menu is for. */
  label: string
  /** Backdrop tap and the hardware back button. */
  onDismiss: () => void
  children: ReactNode
}) {
  const entry = useRef({ dismiss: onDismiss })
  entry.current.dismiss = onDismiss
  useEffect(() => registerSheet(entry.current), [])

  // canvas 10i (the shell), 10b and 10g (the same values): backdrop, panel,
  // grab handle. The canvas's bottom row is the phone's home indicator, so it
  // becomes the safe-area inset, and never less than that row.
  return (
    <div className="fixed inset-0 z-20 flex flex-col justify-end">
      <div aria-hidden onClick={onDismiss} className="absolute inset-0 bg-[rgba(2,3,8,.62)]" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="relative rounded-t-[22px] border border-b-0 border-[rgba(150,205,255,.16)] bg-[rgba(10,16,28,.96)] px-2.5 pb-[max(22px,env(safe-area-inset-bottom))] shadow-[0_-20px_60px_rgba(0,0,0,.6)]"
      >
        <div aria-hidden className="grid h-[22px] place-items-center">
          <span className="block h-1 w-9 rounded-[2px] bg-[rgba(200,220,245,.3)]" />
        </div>
        {children}
      </div>
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
