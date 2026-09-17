import { permissionMode } from '../lib/permissionModes'
import type { PermissionMode } from '../lib/types'
import { Tooltip } from './Tooltip'

/**
 * The permission mode expressed as colour alone — 7px in a card (canvas 2d),
 * 8px in a readout (2e), with the canvas's 8px glow.
 *
 * Purely decorative: every place that draws one also says the mode in words,
 * so the dot is `aria-hidden` and never the only channel.
 */
export function ModeDot({
  mode,
  size = 7,
  className = '',
}: {
  mode: PermissionMode
  size?: number
  className?: string
}) {
  const descriptor = permissionMode(mode)
  if (!descriptor) return null
  return (
    <span
      aria-hidden
      data-mode={mode}
      // `block` because a bare span ignores width/height — see web/CLAUDE.md.
      className={`block shrink-0 rounded-full ${className}`}
      style={{
        width: size,
        height: size,
        background: descriptor.dot,
        boxShadow: `0 0 8px ${descriptor.dot}`,
      }}
    />
  )
}

/**
 * The detail-panel header's permission-mode readout (canvas 2d, 2e): a 24×22
 * box holding nothing but the dot, with the name and the description one
 * hover — or one Tab — away.
 *
 * It replaced a mono chip spelling the mode out, which spent ~90px of a 450px
 * header restating a word the user picked when they launched the session.
 *
 * Focusable on purpose. The box is the only thing in the header that carries
 * meaning in colour, so a keyboard user has to be able to reach it and hear
 * what it says; the `aria-label` carries the mode name and the tooltip
 * supplies the description through `aria-describedby`.
 */
export function ModeReadout({ mode }: { mode: PermissionMode }) {
  const descriptor = permissionMode(mode)
  if (!descriptor) return null
  return (
    <Tooltip title={descriptor.label} description={descriptor.description} align="right">
      <span
        tabIndex={0}
        // A graphic that carries meaning: `img` + a name is how a screen
        // reader gets the mode out of a coloured dot.
        role="img"
        data-mode={mode}
        aria-label={`permission mode: ${descriptor.label}`}
        className={[
          'flex h-[22px] w-6 items-center justify-center rounded-[5px] border',
          'border-[rgba(150,205,255,.2)] bg-[rgba(4,8,16,.5)] transition-colors',
          // 2e: the border goes accent on hover and on focus, so the box reads
          // as something you can point at rather than as a printed swatch.
          'outline-none hover:border-accent/55 focus-visible:border-accent/55',
        ].join(' ')}
      >
        <ModeDot mode={mode} size={8} />
      </span>
    </Tooltip>
  )
}
