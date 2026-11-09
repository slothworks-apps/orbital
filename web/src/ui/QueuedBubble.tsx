import { swatch } from '../lib/palette'

/**
 * A message that has not gone out yet: the user's bubble, dashed in the tag
 * hue, with a mono caption saying when it will — the limit wait's queue
 * (canvas `Feature - Plan limits`, phone 10k) and a worktree launch's first
 * prompt and queue (canvas 66c `qb()`, 66d). One shape; each family keeps
 * the edge, fill, ink and caption its artboard draws.
 */
export type QueuedBubbleKind = 'limit' | 'setup'
export type QueuedBubbleSurface = 'panel' | 'phone'

interface Look {
  /** The dashed edge's alpha in the tag hue. */
  edge: number
  /** The fill's alpha in the tag hue, 0 for none. */
  fill: number
  /** The text's `ink-100` alpha. */
  ink: number
  /** Gap between the bubble and its caption. */
  gapPx: number
  /** The bubble's widest share of the row. */
  maxPct: number
  /** The text's size, and the caption's type. */
  size: string
  caption: string
}

const LOOKS: Record<QueuedBubbleKind, Record<QueuedBubbleSurface, Look>> = {
  limit: {
    // `Feature - Plan limits`: the queue under the wait notice, washed in the hue.
    panel: { edge: 0.3, fill: 0.06, ink: 0.8, gapPx: 4, maxPct: 86, size: 'fs-13', caption: 'fs-10 text-ink-900/55' },
    // Canvas 10k: no fill on the phone.
    phone: { edge: 0.4, fill: 0, ink: 0.85, gapPx: 4, maxPct: 84, size: 'fs-14', caption: 'fs-10 text-ink-900/60' },
  },
  setup: {
    // 66c `qb()`: no fill, `T(210, .4)`, ink `rgba(232,238,248,.86)`, caption 9.5px / 10px on the phone.
    panel: { edge: 0.4, fill: 0, ink: 0.86, gapPx: 5, maxPct: 86, size: 'fs-13', caption: 'fs-9.5 tracking-[0.04em] text-ink-900/60' },
    phone: { edge: 0.4, fill: 0, ink: 0.86, gapPx: 5, maxPct: 86, size: 'fs-14.5', caption: 'fs-10 tracking-[0.04em] text-ink-900/60' },
  },
}

/** 10k: a queue whose Mac is asleep is drawn fainter, and says nothing about when. */
const ASLEEP = { edge: 0.3, ink: 0.7 }

export function QueuedBubble({
  kind,
  surface,
  text,
  caption,
  hue,
  asleep = false,
}: {
  kind: QueuedBubbleKind
  surface: QueuedBubbleSurface
  text: string
  /** When it goes out; none while its device is asleep. */
  caption?: string
  hue: number
  asleep?: boolean
}) {
  const look = LOOKS[kind][surface]
  const tint = (alpha: number) => `oklch(var(--tb-l) var(--tb-c) ${hue} / ${alpha})`
  return (
    <div
      data-queued-bubble={kind}
      className="flex w-full flex-none flex-col items-end"
      style={{ gap: look.gapPx }}
    >
      <div
        data-selectable
        className={[
          'whitespace-pre-wrap border border-dashed px-3.5 py-2.5 leading-[1.5] [text-wrap:pretty]',
          surface === 'phone' ? 'rounded-[16px_16px_5px_16px]' : 'rounded-[12px_12px_4px_12px]',
          look.size,
        ].join(' ')}
        style={{
          maxWidth: `${look.maxPct}%`,
          borderColor: tint(asleep ? ASLEEP.edge : look.edge),
          background: look.fill > 0 ? tint(look.fill) : undefined,
          color: swatch('ink-100', asleep ? ASLEEP.ink : look.ink),
        }}
      >
        {text}
      </div>
      {caption !== undefined && !asleep && (
        <span className={`min-h-3.5 whitespace-nowrap font-mono ${look.caption}`}>{caption}</span>
      )}
    </div>
  )
}
