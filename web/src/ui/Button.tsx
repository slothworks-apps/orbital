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
  size?: 'sm' | 'md' | 'lg' | 'field' | 'pill' | 'strip' | 'icon' | 'row' | 'choice' | 'choice-touch' | 'wide' | 'notice' | 'notice-link' | 'notice-dialog' | 'check' | 'member' | 'member-quiet' | 'member-line' | 'beside-field' | 'over-code' | 'chooser' | 'inline' | 'link-mono' | 'grant-summary' | 'command' | 'login-row' | 'login-card' | 'touch'
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
  primary: 'bg-accent text-space-deep font-bold shadow-[0_0_24px_color-mix(in_oklab,_var(--color-accent)_40%,_transparent)] hover:bg-ink-300',
  // Canvas 50a's Show code / New code over the QR: the primary's fill and ink, flat — no bloom, 600 weight.
  'primary-flat': 'bg-accent text-space-deep font-semibold hover:bg-ink-300',
  // Canvas 50g's Choose this folder: the primary's fill, ink and 700 weight, with no bloom.
  'primary-plain': 'bg-accent text-space-deep font-bold hover:bg-ink-300',
  warning: 'bg-warning text-[#1a1000] font-bold shadow-[0_0_24px_color-mix(in_oklab,_var(--color-warning)_40%,_transparent)] hover:brightness-110',
  ghost: 'bg-transparent text-ink-300 font-semibold border border-line/18 hover:bg-white/5',
  'accent-outline': 'bg-transparent text-accent font-semibold border border-accent/45 hover:bg-accent/10',
  // 1b's composer Stop: amber outline, never a filled block — it sits inside
  // the reply well and must not outweigh Send.
  'warning-outline': 'bg-transparent text-warning font-semibold border border-warning-deep/50 hover:bg-warning/10',
  danger: 'bg-transparent text-red-400 font-semibold border border-red-400/40 hover:bg-red-400/10',
  // The map's floating "New session" (1a). Deliberate deviation from the
  // export: it specifies the same two greys at .85/.9 alpha over a 16px
  // backdrop blur, which reads as see-through wherever the button sits over a
  // planet rather than over empty space. Same colours, opaque — and with the
  // fill solid the blur has nothing left to blur, so it goes too.
  cta: 'bg-gradient-to-b from-raised to-panel border border-accent/45 text-ink-100 font-semibold shadow-[0_0_24px_color-mix(in_oklab,_var(--color-accent)_20%,_transparent),0_12px_30px_rgba(0,0,0,.5)] hover:border-accent/70',
  // The error log's row actions (canvas 5b/5c): hairline pills whose active
  // state ("Hide detail") lights the fill, and a muted rank for dev records.
  pill: 'bg-transparent text-ink-200/80 font-semibold border border-line/14 hover:border-line/30 hover:bg-white/5',
  'pill-active':
    'bg-line/14 text-ink-100 font-semibold border border-line/30',
  'pill-muted':
    'bg-transparent text-ink-700/60 font-semibold border border-line/10 hover:bg-white/5',
  // The MCP dialog's confirming Remove (canvas `Feature - MCP dialog` 12a/12b): the error-log
  // red, oklch(60% .2 25) → #de3b3d, as a hairline and a wash, with oklch(86% .08 25) → #ffbdb7 ink.
  'pill-danger':
    'bg-danger/14 text-[#ffbdb7] font-semibold border border-danger/55 hover:bg-danger/25',
  // Canvas 27a: the composer strip's Cancel / Cancel rewind — a hairline
  // chip in regular weight that lights its fill on hover.
  strip:
    'bg-transparent text-ink-200/90 border border-line/18 hover:border-line/30 hover:bg-line/14 hover:text-ink-100',
  // Canvas 27a/27c: the ↶ next to Send, a neutral chip at rest and the
  // lit chip while its mode is on (`aria-pressed` says which).
  toggle:
    'bg-transparent text-ink-500/75 border border-line/18 hover:border-line/30 hover:text-ink-100',
  'toggle-on': 'bg-line/14 text-ink-100 border border-line/30',
  // Canvas 44a: the Settings row's confirming Remove and Add directory — the
  // lit neutral chip, in the row's weight, never a hue.
  lit: 'bg-line/14 text-ink-100 font-semibold border border-line/30 hover:bg-line/20',
  // `Feature - MCP approval` 47e "START SESSION · DISABLED → READY": the
  // primary before it can be pressed, an outline in the muted ink rather than
  // a dimmed fill. Pair it with `aria-disabled`, not `disabled`, which
  // would fade it a second time.
  'primary-unready':
    'bg-transparent text-ink-900/50 font-bold border border-line/14 cursor-default',
  // 47e CHOICE: one of two equal answers, resting and active. No hue for yes
  // or no — the active state is the lit neutral chip.
  choice:
    'bg-transparent text-ink-500/75 font-semibold border border-line/14 hover:border-line/30',
  'choice-on': 'bg-line/14 text-ink-100 font-semibold border border-line/30',
  // 47a/47b View file: a hairline chip in regular weight, quieter than `pill`.
  'pill-quiet':
    'bg-transparent text-ink-500/85 border border-line/14 hover:border-line/30',
  // Canvas `Feature - Notifications off` 1a: the tip's Settings →, text only
  // until hovered, then the faint wash.
  quiet: 'bg-transparent text-ink-500/80 font-medium hover:bg-line/8 hover:text-ink-100',
  // 1d's Open System Settings: the quiet hairline, bright ink, no fill.
  hairline: 'bg-transparent text-ink-100 font-semibold border border-line/14 hover:bg-line/8',
  // Canvas 50a's Remove, Leave…, Copy and Join: a brighter hairline than `hairline`, bright ink.
  outline: 'bg-transparent text-ink-100 font-semibold border border-line/20 hover:bg-line/8',
  // Canvas 50a's confirming Remove and Leave: filled with the bright ink, dark text, no hue.
  ink: 'bg-ink-100 text-space font-semibold hover:bg-ink-300',
  // Canvas 50a's Pair by hand and 50u's Settings → Updates ›: a quiet text link
  // underlined by a dashed hairline, no box — ink and type from its size or its line.
  'dashed-link': 'cursor-pointer bg-transparent border-b border-dashed border-ink-900/50 text-left',
}

// `lg` is the dialog footer button (1d: 9px/18px at 13px); `sm` is 1b's
// in-panel Send/Stop (7px/14px at 12px).
const sizeClasses: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'px-3.5 py-[7px] fs-12 leading-(--text-xs--line-height)',
  md: 'px-3.5 py-1.5 fs-14 leading-(--text-sm--line-height)',
  lg: 'px-[18px] py-[9px] fs-13',
  // 1d's Browse…: beside an `lg` field and as tall as it, so no padding of
  // its own on the vertical.
  field: 'px-3.5 fs-12.5',
  // 5b's row pills: 4px/10px at 11px.
  pill: 'px-2.5 py-1 fs-11',
  // 27a's strip chip: 3px/9px at mono 10.5.
  strip: 'px-[9px] py-[3px] fs-10.5',
  // 27a's ↶: a 30px square, Send's height at `sm`.
  icon: 'h-[30px] w-[30px] p-0',
  // 44a's in-row buttons (Done, Browse…, Cancel, Remove): 6px/12px at 12px.
  row: 'px-3 py-1.5 fs-12 leading-(--text-xs--line-height)',
  // 47a/47b's Allow / Don't allow: 34px tall at 12.5px, the width the grid gives.
  choice: 'h-fit min-h-[34px] px-2 fs-12.5',
  // 47c/47d's: the phone's 44px row at 14px.
  'choice-touch': 'h-fit min-h-11 px-2 fs-14',
  // 9o's Reject / Accept: 40px tall at 13.5px, sharing the card's width.
  wide: 'h-fit min-h-10 flex-1 px-3.5 fs-13.5',
  // 1a's tip actions: 7px/14px at 13px, and 7px/11px for the text-only Settings →.
  notice: 'px-3.5 py-[7px] fs-13',
  'notice-link': 'px-[11px] py-[7px] fs-13',
  // `Feature - Notice toast` 1b's Done under WHAT'S NEW: 8px/16px at 13px.
  'notice-dialog': 'px-4 py-2 fs-13',
  // `Feature - App update`'s Check now in Settings › Updates: 6px/12px at 12.5px.
  check: 'px-3 py-1.5 fs-12.5',
  // Canvas 50a's row actions (Remove, Cancel, Leave…): 32px tall, 14px sides, 12.5px.
  member: 'h-fit min-h-8 px-3.5 fs-12.5',
  // `Feature - Remote update` 50q's confirm Cancel, a quiet text button beside `member`s: 32px tall, 12px sides, 12.5px.
  'member-quiet': 'h-fit min-h-8 px-3 fs-12.5',
  // `Feature - Remote update` 50q's Update and Try again on the line under a row: 30px tall, 12px sides, 12px.
  'member-line': 'h-fit min-h-[30px] px-3 fs-12 leading-(--text-xs--line-height)',
  // Canvas 50a's Copy, Join and New code beside a field: 31px tall, 12px sides, 12px.
  'beside-field': 'h-fit min-h-[31px] px-3 fs-12 leading-(--text-xs--line-height)',
  // Canvas 50a's Show code / New code over the QR: 30px tall, 12px sides, 12px.
  'over-code': 'h-fit min-h-[30px] px-3 fs-12 leading-(--text-xs--line-height)',
  // Canvas 50g's folder chooser footer (Cancel, Choose this folder): 7px/14px
  // at 12.5px. 50g gives the hairlined Cancel 13px sides; one size is kept for both.
  chooser: 'px-3.5 py-[7px] fs-12.5',
  // A link inside a line of text (50a's Pair by hand): no padding, the line's own type and ink.
  inline: '',
  // 50u's Settings → Updates › under this device: mono 10.5 with its tracking, in the row's brighter ink.
  'link-mono': 'font-mono fs-10.5 tracking-[0.04em] text-ink-500/85',
  // `Feature - Device group 2` 50a's Permissions on this Mac · … line under a member: mono 10.5 in the
  // quiet ink, its summary and › in a row.
  'grant-summary': 'inline-flex items-center gap-[7px] pb-px pt-0.5 font-mono fs-10.5 text-ink-900/65',
  // `Feature - Feedback` 61c's Run in Orbital beside the command it runs: 6px/11px at 12px.
  command: 'px-[11px] py-1.5 fs-12 leading-(--text-xs--line-height)',
  // `Feature - Log in` 62a: the lost-login notice's Log in / Cancel on its title row, 5px/11px at 12px,
  // on one line however narrow the row (62c's Settings row too).
  'login-row': 'whitespace-nowrap px-[11px] py-[5px] fs-12 leading-(--text-xs--line-height)',
  // 62b: the same answer on a Desk card, 6px/14px at 12px.
  'login-card': 'px-3.5 py-1.5 fs-12 leading-(--text-xs--line-height)',
  // 62e: the phone notice's buttons, a 44px target at 14px.
  touch: 'h-fit min-h-11 px-[18px] fs-14',
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
          : size === 'sm' || size === 'icon' || size === 'row' || size === 'command' || size === 'login-row' || size === 'login-card'
            ? 'rounded-[7px]'
            : size === 'touch'
              ? 'rounded-[9px]'
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
