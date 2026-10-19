import type { ButtonHTMLAttributes } from 'react'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?:
    | 'primary'
    | 'primary-flat'
    | 'primary-plain'
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
    | 'outline'
    | 'ink'
    | 'dashed-link'
  size?: 'sm' | 'md' | 'lg' | 'field' | 'pill' | 'strip' | 'icon' | 'row' | 'choice' | 'choice-touch' | 'wide' | 'notice' | 'notice-link' | 'notice-dialog' | 'check' | 'member' | 'member-line' | 'beside-field' | 'over-code' | 'chooser' | 'inline' | 'link-mono'
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
  // Canvas 50a's Show code / New code over the QR: the primary's fill and ink, flat — no bloom, 600 weight.
  'primary-flat': 'bg-accent text-space-deep font-semibold hover:bg-text-soft',
  // Canvas 50g's Choose this folder: the primary's fill, ink and 700 weight, with no bloom.
  'primary-plain': 'bg-accent text-space-deep font-bold hover:bg-text-soft',
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
  // Canvas 50a's Remove, Leave…, Copy and Join: a brighter hairline than `hairline`, bright ink.
  outline: 'bg-transparent text-text-bright font-semibold border border-[rgba(150,205,255,.2)] hover:bg-[rgba(150,205,255,.08)]',
  // Canvas 50a's confirming Remove and Leave: filled with the bright ink, dark text, no hue.
  ink: 'bg-text-bright text-space font-semibold hover:bg-text-soft',
  // Canvas 50a's Pair by hand and 50u's Settings → Updates ›: a quiet text link
  // underlined by a dashed hairline, no box — ink and type from its size or its line.
  'dashed-link': 'cursor-pointer bg-transparent border-b border-dashed border-[rgba(160,190,225,.5)] text-left',
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
  // `Feature - Notice toast` 1b's Done under WHAT'S NEW: 8px/16px at 13px.
  'notice-dialog': 'px-4 py-2 text-[13px]',
  // `Feature - App update`'s Check now in Settings › Updates: 6px/12px at 12.5px.
  check: 'px-3 py-1.5 text-[12.5px]',
  // Canvas 50a's row actions (Remove, Cancel, Leave…): 32px tall, 14px sides, 12.5px.
  member: 'h-8 px-3.5 text-[12.5px]',
  // `Feature - Remote update` 50q's Update and Try again on the line under a row: 30px tall, 12px sides, 12px.
  'member-line': 'h-[30px] px-3 text-xs',
  // Canvas 50a's Copy, Join and New code beside a field: 31px tall, 12px sides, 12px.
  'beside-field': 'h-[31px] px-3 text-xs',
  // Canvas 50a's Show code / New code over the QR: 30px tall, 12px sides, 12px.
  'over-code': 'h-[30px] px-3 text-xs',
  // Canvas 50g's folder chooser footer (Cancel, Choose this folder): 7px/14px
  // at 12.5px. 50g gives the hairlined Cancel 13px sides; one size is kept for both.
  chooser: 'px-3.5 py-[7px] text-[12.5px]',
  // A link inside a line of text (50a's Pair by hand): no padding, the line's own type and ink.
  inline: '',
  // 50u's Settings → Updates › under this device: mono 10.5 with its tracking, in the row's brighter ink.
  'link-mono': 'font-mono text-[10.5px] tracking-[0.04em] text-[rgba(200,220,245,.85)]',
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
  const link = variant === 'dashed-link'
  // A link has no box to round: a radius would bend its underline at the ends.
  const rounding = link
    ? ''
    : variant === 'cta' || variant.startsWith('pill')
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
  // A link takes the family of its line, or of its size.
  const family = size === 'strip' ? 'font-mono' : link ? '' : 'font-sans'

  return (
    <button
      type={type}
      data-variant={variant}
      data-size={size}
      className={[
        // A link stays a button's own inline box, so it sits in its line of text.
        link ? '' : 'inline-flex items-center justify-center gap-2 transition-colors',
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
