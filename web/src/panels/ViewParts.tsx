import { createContext, type ReactNode } from 'react'

/**
 * The small pieces a generated view is drawn with (spec
 * 2026-11-18-generated-views-design; canvas `Feature - Views` 69a–69e): its
 * window glyph, the line an updated view leaves in its old place, the
 * mono line over a message sent from a view, and the quiet panels that stand
 * where the page would be.
 */

/**
 * 69b: the window glyph — a 13×11 frame with a title bar and a small square,
 * in `currentColor`. `scale` grows it for the media tile (69d: `scale(2.2)`).
 */
export function ViewGlyph({ scale }: { scale?: number }) {
  return (
    <span
      aria-hidden
      className="flex"
      style={scale ? { transform: `scale(${scale})`, margin: '8px 0' } : undefined}
    >
      <span className="relative block h-[11px] w-[13px] flex-none rounded-[2.5px] border-[1.4px] border-current">
        <span className="absolute inset-x-0 top-[2px] block h-[1.4px] bg-current" />
        <span className="absolute left-[2px] top-[4.6px] block h-[3px] w-[3px] rounded-[0.6px] bg-current opacity-60" />
      </span>
    </span>
  )
}

/**
 * 69c UPDATED: where a view was before the session updated it — one dashed
 * line, the name, "updated below" and jump ↓. It cannot be opened: the old
 * content is not kept.
 */
export function ViewUpdatedRow({ title, onJump }: { title: string; onJump: () => void }) {
  return (
    <button
      type="button"
      data-view-updated
      onClick={onJump}
      className="flex w-full items-center gap-2 rounded-[9px] border border-dashed border-line/16 bg-transparent px-[11px] py-[7px] text-left font-mono fs-10.5 text-ink-900/60"
    >
      <ViewGlyph />
      <span className="min-w-0 truncate text-ink-200/80">{title}</span>
      <span className="flex-none">· updated below</span>
      <span className="flex-1" />
      <span className="flex-none text-sky">jump ↓</span>
    </button>
  )
}

/**
 * 69c SENT: the mono line over the bubble of a message a view sent, "from
 * <title> ↑", which jumps back to the view. The error variant (not on the
 * canvas) says the error came from it.
 */
export function FromViewLine({ title, error, onJump }: { title: string; error?: boolean; onJump?: () => void }) {
  return (
    <button
      type="button"
      data-from-view
      onClick={onJump}
      disabled={!onJump}
      className="flex items-center gap-1.5 border-0 bg-transparent p-0 font-mono fs-10 text-ink-900/60 disabled:cursor-default"
    >
      <ViewGlyph />
      {error ? 'error from ' : 'from '}
      <span className="text-ink-200/80">{title}</span>
      {onJump ? ' ↑' : ''}
    </button>
  )
}

/** 69c ASLEEP → LOADING: the glyph over one static mono line, on the dimmed floor. No spinner, no shimmer. */
export function ViewPlaceholder({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-full place-items-center bg-space/60">
      <div className="flex flex-col items-center gap-1.5 text-ink-900/60">
        <ViewGlyph />
        <span className="font-mono fs-10.5 tracking-[0.06em]">{children}</span>
      </div>
    </div>
  )
}

/**
 * Jumps to a view's newest row from elsewhere in the transcript — a message
 * it sent ("from <title> ↑"). Null outside a transcript, or while Labs →
 * Views is off; `has` says whether the view is one this transcript holds.
 */
export const ViewJumpContext = createContext<{ jump: (viewId: string) => void; has: (viewId: string) => boolean } | null>(null)
