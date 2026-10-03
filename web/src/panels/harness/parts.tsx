import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { MARKER, type StepKind } from './model'

/**
 * What the panel's shell hands each view for its header (30b): the first
 * row's frame (a drag region in a detached window), the swap strip above it,
 * and the ✕.
 */
export interface Chrome {
  row: (children: ReactNode) => ReactNode
  swapStrip: ReactNode
  close: ReactNode
  inWindow: boolean
}

/** The header block every view opens with: 16/18/14 padding over a hairline (30b). */
export function HeaderBlock({ chrome, children, pb = 14 }: { chrome: Chrome; children: ReactNode; pb?: number }) {
  return (
    <div className="orbital-band-controls relative border-b border-[rgba(150,205,255,.1)] px-[18px] pt-4" style={{ paddingBottom: pb }}>
      {chrome.swapStrip}
      {children}
    </div>
  )
}

/** Canvas 30d's marker: 9 px, ● auto or ◆ gate, border 1.4 px; nothing moves. */
export function Marker({ kind, gate, size = 9 }: { kind: StepKind; gate: boolean; size?: number }) {
  const m = MARKER[kind]
  return (
    <span
      aria-hidden
      className="block shrink-0 box-border"
      style={{
        width: size,
        height: size,
        borderRadius: gate ? 1.5 : '50%',
        transform: gate ? 'rotate(45deg)' : undefined,
        border: `1.4px ${m.stroke} ${m.border}`,
        background: m.fill,
        boxShadow: m.shadow,
      }}
    />
  )
}

/** Canvas 30b's switch: 26 × 14, a 10 px knob; acts at once, never confirmed (30f). */
export function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <label className="flex cursor-pointer select-none items-center gap-2 text-[12px] text-[rgba(220,235,255,.88)]">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={() => onChange(!on)}
        className="relative block h-[14px] w-[26px] shrink-0 rounded-[7px]"
        style={{ background: on ? 'oklch(85% .12 205)' : 'rgba(150,205,255,.16)' }}
      >
        <span
          aria-hidden
          className="absolute top-[2px] block size-[10px] rounded-full transition-[left] duration-150 ease-out"
          style={{ left: on ? 14 : 2, background: on ? '#03111a' : 'rgba(200,220,245,.7)' }}
        />
      </button>
      {label}
    </label>
  )
}

/** Section label: mono 9, tracking .18em (30d INSTRUCTIONS, 30e SUMMARY). */
export function Label({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`font-mono text-[9px] tracking-[0.18em] text-[rgba(160,190,225,.5)] ${className}`}>{children}</div>
}

/** The panel's small uppercase kicker: HARNESS (30b). */
export function Kicker({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[9.5px] tracking-[0.18em] text-[rgba(160,190,225,.55)]">{children}</span>
}

/** The scope chip beside HARNESS (30b): "project · orbital". */
export function ScopeChip({ text }: { text: string }) {
  return (
    <span className="rounded-[4px] border border-[rgba(150,205,255,.14)] px-[7px] py-[2px] font-mono text-[9.5px] tracking-[0.04em] text-[rgba(200,220,245,.75)]">
      {text}
    </span>
  )
}

/** The scope marks (30c): ▢ project, ◯ global. */
export function ScopeMark({ kind }: { kind: 'project' | 'global' }) {
  return (
    <span
      aria-hidden
      className="block size-[7px] shrink-0 box-border border-[1.3px] border-[rgba(200,220,245,.7)]"
      style={{ borderRadius: kind === 'project' ? 2 : '50%' }}
    />
  )
}

/** The 22 px header buttons (30b's ⋯ and ✕). */
export function HeadButton({
  label,
  children,
  ...rest
}: { label: string; children: ReactNode; ref?: Ref<HTMLButtonElement> } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      className="grid size-[22px] shrink-0 place-items-center rounded-[6px] text-[13px] tracking-[0.05em] text-[rgba(200,220,245,.7)] hover:bg-[rgba(150,205,255,.09)] hover:text-[#e8eef8]"
      {...rest}
    >
      {children}
    </button>
  )
}

/** 30b's ✕: two 1.4 px strokes in a 9 px box. */
export function CloseGlyph() {
  return (
    <span aria-hidden className="relative block size-[9px]">
      <span className="absolute left-1/2 top-0 -ml-[0.7px] block h-full w-[1.4px] rotate-45 rounded-[1px] bg-current" />
      <span className="absolute left-1/2 top-0 -ml-[0.7px] block h-full w-[1.4px] -rotate-45 rounded-[1px] bg-current" />
    </span>
  )
}

/** The dashed top seam the side slot's panels share (11b, 30b). */
export function DashedSeam() {
  return (
    <div
      aria-hidden
      className="absolute inset-x-0 top-0 h-px"
      style={{ background: 'repeating-linear-gradient(90deg, rgba(150,205,255,.4) 0 4px, transparent 4px 10px)' }}
    />
  )
}

/** A link-like mono action in the accent (30d RECORD →, 30e Show diff →). */
export function AccentLink({ children, onClick, className = '' }: { children: ReactNode; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`font-mono text-[10px] tracking-[0.08em] text-[oklch(85%_.12_205)] hover:brightness-110 ${className}`}
    >
      {children}
    </button>
  )
}

/** The hairline secondary button (30b Reopen, 30e ↶ Go back here). */
export function OutlineButton({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-[7px] rounded-[7px] border border-[rgba(150,205,255,.2)] px-[14px] py-[7px] text-[12px] font-semibold text-[rgba(220,235,255,.9)] hover:border-[rgba(150,205,255,.35)] hover:text-[#e8eef8] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  )
}

/** 30b Approve: the only filled button on the panel. */
export function FilledButton({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-[7px] bg-[oklch(85%_.12_205)] px-[14px] py-[7px] text-[12px] font-bold text-[#03111a] hover:brightness-[1.08] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  )
}
