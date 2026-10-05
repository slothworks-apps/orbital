import type { ReactNode } from 'react'

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

/** 9a–9i's two button kinds: filled cyan for the screen's one action, outlined for the rest. */
type ButtonProps = { children: ReactNode; onClick?: () => void; disabled?: boolean; type?: 'button' | 'submit' }

export function PrimaryButton({ children, onClick, disabled, type = 'button' }: ButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="flex h-13 w-full items-center justify-center gap-2.5 rounded-[14px] bg-[oklch(85%_.12_205)] px-4 text-[15px] font-bold text-[#03111a] shadow-[0_0_22px_oklch(85%_.12_205/.3)] disabled:opacity-35 disabled:shadow-none"
    >
      {children}
    </button>
  )
}

export function SecondaryButton({ children, onClick, disabled, type = 'button' }: ButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="flex h-13 w-full items-center justify-center rounded-[14px] border border-[rgba(150,205,255,.2)] px-4 text-[15px] font-semibold text-text-bright disabled:opacity-40"
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
