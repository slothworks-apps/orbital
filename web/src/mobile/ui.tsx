import type { ReactNode } from 'react'
import { Logo } from '../ui/Logo'

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
}: {
  header?: ReactNode
  children: ReactNode
  footer?: ReactNode
  scroll?: boolean
}) {
  return (
    <main className="flex h-full min-h-0 flex-col">
      {header && <header className="shrink-0 border-b border-panel-border bg-[rgba(5,7,13,.92)]">{header}</header>}
      <div className={scroll ? 'min-h-0 flex-1 overflow-y-auto' : 'flex min-h-0 flex-1 flex-col'}>{children}</div>
      {footer && <div className="shrink-0">{footer}</div>}
    </main>
  )
}

type ButtonProps = { children: ReactNode; onClick?: () => void; disabled?: boolean; type?: 'button' | 'submit' }

export function PrimaryButton({ children, onClick, disabled, type = 'button' }: ButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="min-h-11 w-full rounded-[10px] border border-[rgba(89,228,243,.45)] bg-[rgba(89,228,243,.12)] px-4 text-[15px] font-semibold text-text-bright disabled:opacity-40"
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
      className="min-h-11 w-full rounded-[10px] border border-panel-border px-4 text-[15px] text-text-soft disabled:opacity-40"
    >
      {children}
    </button>
  )
}

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
      className={[
        'relative h-7 w-12 shrink-0 rounded-full border transition-colors duration-150',
        checked ? 'border-[rgba(89,228,243,.6)] bg-[rgba(89,228,243,.35)]' : 'border-panel-border bg-[rgba(150,205,255,.08)]',
        disabled ? 'opacity-40' : '',
      ].join(' ')}
    >
      <span
        aria-hidden
        className={[
          'absolute top-0.5 h-5.5 w-5.5 rounded-full bg-text-bright transition-transform duration-150',
          checked ? 'translate-x-5.5' : 'translate-x-0.5',
        ].join(' ')}
      />
    </button>
  )
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="px-4 pb-1.5 pt-5 font-mono text-[10.5px] tracking-[0.14em] text-text-muted">{children}</div>
}

/**
 * The Orbital mark at screen size (9e paired, 9h): `ui/Logo`'s drawing
 * scaled up. `checked` adds the check of "Paired with"; `muted` is 9h's
 * grey mark — no red, no icon.
 */
export function MobileMark({ checked = false, muted = false }: { checked?: boolean; muted?: boolean }) {
  return (
    <div className={['relative flex h-12 w-12 items-center justify-center', muted ? 'opacity-50 grayscale' : ''].join(' ')}>
      <span className="block [&>svg]:h-12 [&>svg]:w-12">
        <Logo />
      </span>
      {checked && (
        <span
          aria-hidden
          className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full border border-[rgba(89,228,243,.5)] bg-space text-[11px] text-accent"
        >
          ✓
        </span>
      )}
    </div>
  )
}
