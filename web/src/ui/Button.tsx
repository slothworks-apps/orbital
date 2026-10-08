import type { ButtonHTMLAttributes } from 'react'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?:
    | 'primary'
    | 'ghost'
    | 'danger'
    | 'warning'
    | 'warning-outline'
    | 'accent-outline'
    | 'cta'
    | 'pill'
    | 'pill-active'
    | 'pill-muted'
    | 'pill-danger'
    | 'strip'
    | 'toggle'
    | 'toggle-on'
    | 'lit'
    | 'primary-unready'
    | 'choice'
    | 'choice-on'
    | 'pill-quiet'
    | 'quiet'
    | 'hairline'
  size?: 'sm' | 'md' | 'lg' | 'field' | 'pill' | 'strip' | 'icon' | 'row' | 'choice' | 'choice-touch' | 'wide' | 'notice' | 'notice-link'
  /** Layout-only passthrough (margin, grid-area). Never use to override variant/size styling. */
  className?: string
}

/**
 * Variants transcribed from the export's buttons. The filled pair (1d's
 * "Launch session", 1b's stop confirm) are 700-weight with a coloured bloom
 * and near-black ink; the outlined pair carry the same hue as text on a
 * transparent fill. `danger` has no counterpart in any artboard — it is
 * Orbital's own destructive treatment.
 */
const variantClasses: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary: 'bg-accent text-space-deep font-bold shadow-[0_0_24px_rgba(89,228,243,.4)] hover:bg-text-soft',
  warning: 'bg-warning text-[#1a1000] font-bold shadow-[0_0_24px_rgba(255,187,123,.4)] hover:brightness-110',
  ghost: 'bg-transparent text-text-soft font-semibold border border-[rgba(150,205,255,.18)] hover:bg-white/5',
  'accent-outline': 'bg-transparent text-accent font-semibold border border-accent/45 hover:bg-accent/10',
  // 1b's composer Stop: amber outline, never a filled block — it sits inside
  // the reply well and must not outweigh Send.
  'warning-outline': 'bg-transparent text-warning font-semibold border border-[rgba(251,169,98,.5)] hover:bg-warning/10',
  danger: 'bg-transparent text-red-400 font-semibold border border-red-400/40 hover:bg-red-400/10',
  // The map's floating "New session" (1a). Deliberate deviation from the
  // export: it specifies the same two greys at .85/.9 alpha over a 16px
  // backdrop blur, which reads as see-through wherever the button sits over a
  // planet rather than over empty space. Same colours, opaque — and with the
  // fill solid the blur has nothing left to blur, so it goes too.
  cta: 'bg-gradient-to-b from-[#141c2e] to-[#0a0e1a] border border-accent/45 text-text-bright font-semibold shadow-[0_0_24px_rgba(89,228,243,.2),0_12px_30px_rgba(0,0,0,.5)] hover:border-accent/70',
  // The error log's row actions (canvas 5b/5c): hairline pills whose active
  // state ("Hide detail") lights the fill, and a muted rank for dev records.
  pill: 'bg-transparent text-[rgba(220,235,255,.8)] font-semibold border border-[rgba(150,205,255,.14)] hover:border-[rgba(150,205,255,.3)] hover:bg-white/5',
  'pill-active':
    'bg-[rgba(150,205,255,.14)] text-text-bright font-semibold border border-[rgba(150,205,255,.3)]',
  'pill-muted':
    'bg-transparent text-[rgba(190,212,238,.6)] font-semibold border border-[rgba(150,205,255,.1)] hover:bg-white/5',
  // The MCP dialog's confirming Remove (canvas `Feature - MCP dialog` 12a/12b): the error-log
  // red, oklch(60% .2 25) → #de3b3d, as a hairline and a wash, with oklch(86% .08 25) → #ffbdb7 ink.
  'pill-danger':
    'bg-[#de3b3d]/14 text-[#ffbdb7] font-semibold border border-[#de3b3d]/55 hover:bg-[#de3b3d]/25',
  // Canvas 27a: the composer strip's Cancel / Cancel rewind — a hairline
  // chip in regular weight that lights its fill on hover.
  strip:
    'bg-transparent text-[rgba(220,235,255,.9)] border border-[rgba(150,205,255,.18)] hover:border-[rgba(150,205,255,.3)] hover:bg-[rgba(150,205,255,.14)] hover:text-text-bright',
  // Canvas 27a/27c: the ↶ next to Send, a neutral chip at rest and the
  // lit chip while its mode is on (`aria-pressed` says which).
  toggle:
    'bg-transparent text-[rgba(200,220,245,.75)] border border-[rgba(150,205,255,.18)] hover:border-[rgba(150,205,255,.3)] hover:text-text-bright',
  'toggle-on': 'bg-[rgba(150,205,255,.14)] text-text-bright border border-[rgba(150,205,255,.3)]',
  // Canvas 44a: the Settings row's confirming Remove and Add directory — the
  // lit neutral chip, in the row's weight, never a hue.
  lit: 'bg-[rgba(150,205,255,.14)] text-text-bright font-semibold border border-[rgba(150,205,255,.3)] hover:bg-[rgba(150,205,255,.2)]',
  // `Feature - MCP approval` 47e "START SESSION · DISABLED → READY": the
  // primary before it can be pressed, an outline in the muted ink rather than
  // a dimmed fill. Pair it with `aria-disabled`, not `disabled`, which
  // would fade it a second time.
  'primary-unready':
    'bg-transparent text-[rgba(160,190,225,.5)] font-bold border border-[rgba(150,205,255,.14)] cursor-default',
  // 47e CHOICE: one of two equal answers, resting and active. No hue for yes
  // or no — the active state is the lit neutral chip.
  choice:
    'bg-transparent text-[rgba(200,220,245,.75)] font-semibold border border-[rgba(150,205,255,.14)] hover:border-[rgba(150,205,255,.3)]',
  'choice-on': 'bg-[rgba(150,205,255,.14)] text-text-bright font-semibold border border-[rgba(150,205,255,.3)]',
  // 47a/47b View file: a hairline chip in regular weight, quieter than `pill`.
  'pill-quiet':
    'bg-transparent text-[rgba(200,220,245,.85)] border border-[rgba(150,205,255,.14)] hover:border-[rgba(150,205,255,.3)]',
  // Canvas `Feature - Notifications off` 1a: the tip's Settings →, text only
  // until hovered, then the faint wash.
  quiet: 'bg-transparent text-[rgba(200,220,245,.8)] font-medium hover:bg-[rgba(150,205,255,.08)] hover:text-text-bright',
  // 1d's Open System Settings: the quiet hairline, bright ink, no fill.
  hairline: 'bg-transparent text-text-bright font-semibold border border-[rgba(150,205,255,.14)] hover:bg-[rgba(150,205,255,.08)]',
}

// `lg` is the dialog footer button (1d: 9px/18px at 13px); `sm` is 1b's
// in-panel Send/Stop (7px/14px at 12px).
const sizeClasses: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'px-3.5 py-[7px] text-xs',
  md: 'px-3.5 py-1.5 text-sm',
  lg: 'px-[18px] py-[9px] text-[13px]',
  // 1d's Browse…: beside an `lg` field and as tall as it, so no padding of
  // its own on the vertical.
  field: 'px-3.5 text-[12.5px]',
  // 5b's row pills: 4px/10px at 11px.
  pill: 'px-2.5 py-1 text-[11px]',
  // 27a's strip chip: 3px/9px at mono 10.5.
  strip: 'px-[9px] py-[3px] text-[10.5px]',
  // 27a's ↶: a 30px square, Send's height at `sm`.
  icon: 'h-[30px] w-[30px] p-0',
  // 44a's in-row buttons (Done, Browse…, Cancel, Remove): 6px/12px at 12px.
  row: 'px-3 py-1.5 text-xs',
  // 47a/47b's Allow / Don't allow: 34px tall at 12.5px, the width the grid gives.
  choice: 'h-[34px] px-2 text-[12.5px]',
  // 47c/47d's: the phone's 44px row at 14px.
  'choice-touch': 'h-11 px-2 text-[14px]',
  // 9o's Reject / Accept: 40px tall at 13.5px, sharing the card's width.
  wide: 'h-10 flex-1 px-3.5 text-[13.5px]',
  // 1a's tip actions: 7px/14px at 13px, and 7px/11px for the text-only Settings →.
  notice: 'px-3.5 py-[7px] text-[13px]',
  'notice-link': 'px-[11px] py-[7px] text-[13px]',
}

export function Button({
  variant = 'primary',
  size = 'md',
  type = 'button',
  className,
  ...rest
}: ButtonProps) {
  // Radius is resolved here rather than merged from two class lists: Tailwind
  // resolves same-property utilities by stylesheet order, not by the order
  // they appear in `class`, so a variant and a size both naming a radius
  // would pick a winner arbitrarily.
  const rounding =
    variant === 'cta' || variant.startsWith('pill')
      ? 'rounded-full'
      : size === 'strip'
        ? 'rounded-[6px]'
        : size === 'field'
          ? 'rounded-[9px]'
          : size === 'sm' || size === 'icon' || size === 'row'
            ? 'rounded-[7px]'
            : size === 'choice-touch'
              ? 'rounded-[12px]'
              : 'rounded-lg'
  // The same for the family: the strip chip is mono, and two font utilities
  // on one element would be settled by stylesheet order.
  const family = size === 'strip' ? 'font-mono' : 'font-sans'

  return (
    <button
      type={type}
      data-variant={variant}
      data-size={size}
      className={[
        'inline-flex items-center justify-center gap-2 transition-colors',
        family,
        'disabled:cursor-not-allowed disabled:opacity-40',
        rounding,
        variantClasses[variant],
        sizeClasses[size],
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    />
  )
}
