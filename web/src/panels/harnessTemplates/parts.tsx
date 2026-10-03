/**
 * Small pieces Settings → Harness templates draws in more than one place:
 * the anchored popover shell, the ◯ / ▢ scope mark, the tag pill, the
 * segmented pair and the text field that underlines an unknown `{{key}}`
 * (canvas Feature - Harness 30j–30m).
 */

import { useEffect, useRef } from 'react'
import type { CSSProperties, ReactNode, RefObject, TextareaHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import { tagColor, type TemplateScope } from '../../lib/types'
import { EscapeBoundary, useEscapeLayer } from '../../ui/escapeLayer'
import { usePopupPosition } from '../../ui/usePopupPosition'
import { keyedParts } from './logic'

/** Mono section label: 30k's ABOUT / INPUTS / HOW IT RUNS / STEPS. */
export const SECTION_LABEL = 'font-mono text-[10px] tracking-[0.18em] text-[rgba(160,190,225,.6)]'
/** Mono field label inside a step (30k: INSTRUCTIONS, DONE WHEN). */
export const FIELD_LABEL = 'font-mono text-[9px] tracking-[0.16em] text-[rgba(160,190,225,.5)]'
/** 30j / 30k: the secondary header button (Draft…, Draft with the assistant…). */
export const SECONDARY_BUTTON =
  'whitespace-nowrap rounded-lg border border-[rgba(150,205,255,.18)] px-3 py-[7px] text-[12.5px] font-semibold text-[rgba(220,235,255,.9)] transition-colors hover:bg-white/5'
/** 30k's Save, 30l's Draft into editor: the filled accent button, no bloom. */
export const PRIMARY_BUTTON =
  'whitespace-nowrap rounded-lg bg-accent px-3.5 py-[7px] font-bold text-space-deep transition-colors hover:bg-text-soft disabled:cursor-not-allowed disabled:opacity-40'
/** The "unknown key" / "unused" mark: amber, oklch(85% .12 60) = --color-warning. */
export const KEY_WARNING = 'rgba(255,187,123,.85)'

/**
 * A popover hung off an anchor (30l, 30m): portalled, placed by
 * `usePopupPosition`, closed by Escape and by a press outside. A press inside
 * another of these popovers is not outside — the example-session picker and
 * the scope picker open from inside the Draft… popover.
 */
export function Popover({
  open,
  anchorRef,
  onClose,
  width,
  align = 'right',
  radius = 10,
  className,
  children,
}: {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  width: number
  align?: 'left' | 'right'
  radius?: 10 | 12
  className?: string
  children: ReactNode
}) {
  const popupRef = useRef<HTMLDivElement | null>(null)
  useEscapeLayer(open, onClose)
  usePopupPosition(open, anchorRef, popupRef, { gap: 6, align })
  const latest = useRef(onClose)
  latest.current = onClose

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target
      if (!(target instanceof Element)) return
      if (anchorRef.current?.contains(target) || popupRef.current?.contains(target)) return
      if (target.closest('[data-harness-popover]')) return
      latest.current()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open, anchorRef])

  if (!open) return null
  return createPortal(
    <EscapeBoundary>
      <div
        ref={popupRef}
        data-harness-popover=""
        // 30l / 30m: a flat rgba(10,16,28,.96) fill, a .16 hairline, one soft drop shadow.
        className={[
          'orbital-no-drag fixed z-[60] flex flex-col overflow-y-auto border border-[rgba(150,205,255,.16)] bg-[rgba(10,16,28,.96)] text-text-bright shadow-[0_24px_60px_rgba(0,0,0,.6)]',
          radius === 12 ? 'rounded-xl' : 'rounded-[10px]',
          className ?? '',
        ].join(' ')}
        style={{ width: `${width}px`, maxWidth: 'calc(100vw - 16px)' }}
      >
        {children}
      </div>
    </EscapeBoundary>,
    document.body,
  )
}

/** The ◯ / ▢ mark the start view and Settings draw for a scope (30j, 30m). */
export function ScopeMark({ scope, size = 7, border = 1.3 }: { scope: TemplateScope | 'global' | 'project'; size?: 7 | 8; border?: 1.3 | 1.4 }) {
  const kind = typeof scope === 'string' ? scope : scope.kind
  return (
    <span
      aria-hidden
      className="inline-block shrink-0 border-[rgba(200,220,245,.7)]"
      style={{ width: size, height: size, borderWidth: border, borderStyle: 'solid', borderRadius: kind === 'global' ? '50%' : 2 }}
    />
  )
}

export function scopeName(scope: TemplateScope): string {
  return scope.kind === 'global' ? 'global' : scope.name
}

/**
 * A tag as 30j's TAGS column and 30k's Tags row draw it: hue dot, name. A
 * name no tag in Orbital carries gets no dot. `null` is 30j's "no tag".
 */
export function TagPill({
  name,
  hue,
  size,
  onRemove,
}: {
  name: string | null
  hue?: number
  /** `row` is 30j's list cell (2px 8px, 10.5px); `field` is 30k's editor chip (3px 9px, 11px, lit). */
  size: 'row' | 'field'
  onRemove?: () => void
}) {
  const dot = hue === undefined ? 'transparent' : tagColor(hue)
  return (
    <span
      className={[
        'inline-flex items-center rounded-full border font-semibold',
        size === 'row'
          ? 'gap-[5px] border-[rgba(150,205,255,.14)] px-2 py-0.5 text-[10.5px] text-[rgba(220,235,255,.8)]'
          : 'gap-1.5 border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)] px-[9px] py-[3px] text-[11px] text-text-bright',
      ].join(' ')}
    >
      <span
        aria-hidden
        className={size === 'row' ? 'block h-[5px] w-[5px] rounded-full' : 'block h-1.5 w-1.5 rounded-full'}
        style={{ background: dot }}
      />
      {name ?? 'no tag'}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
          className="-mr-0.5 leading-none text-[rgba(160,190,225,.6)] hover:text-text-bright"
        >
          ×
        </button>
      )}
    </span>
  )
}

/**
 * The segmented pair 30k and 30l draw for auto / gate, Global / project and
 * Opus / Sonnet: a mono shell, the active half tinted in the accent. Each
 * segment is a button the caller wires.
 */
export function SegShell({ label, radius, children }: { label: string; radius: 7 | 8; children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label={label}
      className={[
        'inline-flex flex-none overflow-hidden whitespace-nowrap border border-[rgba(150,205,255,.18)] font-mono',
        radius === 7 ? 'rounded-[7px]' : 'rounded-lg bg-[rgba(4,8,16,.5)]',
      ].join(' ')}
    >
      {children}
    </div>
  )
}

export function Seg({
  active,
  first = false,
  pad,
  onClick,
  children,
  buttonRef,
  ...aria
}: {
  active: boolean
  first?: boolean
  /** 30k scope / 30l model: 6px 11px at 11.5px; 30k auto / gate: 6px 10px at 11px. */
  pad: 'wide' | 'narrow'
  onClick: () => void
  children: ReactNode
  buttonRef?: RefObject<HTMLButtonElement | null>
  'aria-haspopup'?: 'dialog'
  'aria-expanded'?: boolean
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-pressed={active}
      onClick={onClick}
      {...aria}
      className={[
        'py-1.5 transition-colors',
        pad === 'wide' ? 'px-[11px] text-[11.5px]' : 'px-2.5 text-[11px]',
        first ? '' : 'border-l border-[rgba(150,205,255,.12)]',
        active ? 'bg-accent/10 font-semibold text-accent' : 'text-[rgba(220,235,255,.85)] hover:bg-white/5',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

/** One step text drawn with its `{{key}}` runs; an unknown key is underlined (30k). */
export function KeyedText({ text, known }: { text: string; known: ReadonlySet<string> }) {
  return (
    <>
      {keyedParts(text, known).map((part, i) =>
        part.unknown ? (
          <span key={i} className="underline underline-offset-[3px]" style={{ textDecorationColor: KEY_WARNING }} title={`No input is called “${part.key}”`}>
            {part.text}
          </span>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  )
}

/**
 * A textarea that grows with its text and underlines an unknown `{{key}}`
 * (30k). The underline is drawn by a mirror behind the transparent field:
 * the same box, padding and type, its text transparent, so only the
 * underline shows through.
 */
export function KeyedTextArea({
  value,
  onChange,
  known,
  box,
  type,
  minHeight,
  ...rest
}: {
  value: string
  onChange: (value: string) => void
  known: ReadonlySet<string>
  /** Fill, border and radius of the field (the wrapper's). */
  box: string
  /** Padding and type, shared by the field and its mirror. */
  type: string
  minHeight?: number
} & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>) {
  const style: CSSProperties = { minHeight }
  return (
    <div className={['relative focus-within:border-[rgba(150,205,255,.32)]', box].join(' ')}>
      <div aria-hidden className={['pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-transparent', type].join(' ')}>
        {keyedParts(value, known).map((part, i) =>
          part.unknown ? (
            <span key={i} className="underline underline-offset-[3px]" style={{ textDecorationColor: KEY_WARNING }}>
              {part.text}
            </span>
          ) : (
            <span key={i}>{part.text}</span>
          ),
        )}
      </div>
      <textarea
        {...rest}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={1}
        style={style}
        className={[
          'relative block w-full resize-none bg-transparent [field-sizing:content] placeholder:text-[rgba(160,190,225,.4)] focus:outline-none',
          type,
        ].join(' ')}
      />
    </div>
  )
}
