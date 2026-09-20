import { useOrbital } from '../store/store'

/**
 * The pressable file path (spec: 2026-09-19-file-viewer-design § The
 * pressable path; canvas 8a/8e). One component used by all three sites —
 * tool-row labels, expanded INPUT values and assistant prose. A real
 * `<button>` in tab order (⏎/space opens), `stopPropagation` on press so
 * the row it sits in never toggles.
 *
 * Canvas 8e: hit pad `1px 5px`, radius 4, negative margin `0 -5px` so row
 * metrics hold; resting dotted underline `rgba(150,205,255,.3)` at 2px
 * offset; hover pill `rgba(150,205,255,.12)` + solid `oklch(85% .12 205/.8)`
 * underline at `.12s ease` (faster than the row's `.16s` — the smaller
 * target answers first); active fill `.18`; focus ring
 * `0 0 0 2px oklch(85% .12 205 / .55)`.
 */

/** Where the button sits — only ink and box metrics differ (canvas 8a). */
export type PathButtonVariant = 'row' | 'input' | 'prose'

export interface PathButtonProps {
  /** The path as written — shown verbatim and sent to the store on press. */
  path: string
  /** Parsed `:line` target, if the site carried one. */
  line?: number | null
  variant?: PathButtonVariant
  /**
   * Display suffix after the path (`:42`, or `:42:7` from a prose match —
   * the column stays in the hit area even though only the line is kept).
   * Defaults to `:line` when a line is set.
   */
  suffix?: string
}

const VARIANT_CLASSES: Record<PathButtonVariant, string> = {
  // 8a collapsed-row label: #e8eef8 ink over the row's own mono type.
  row: 'mx-[-5px] px-[5px] py-px text-[#e8eef8]',
  // 8a INPUT frame: the value's slightly softer ink, same box.
  input: 'mx-[-5px] px-[5px] py-px text-[rgba(220,235,255,.9)]',
  // 8a assistant prose: mono 11.5px inside 13px prose, tighter box.
  prose: 'mx-[-4px] px-[4px] py-px font-mono text-[11.5px] text-[#e8eef8]',
}

export function PathButton({ path, line = null, variant = 'row', suffix }: PathButtonProps) {
  const openFile = useOrbital((s) => s.openFile)
  // OPEN state (8e): the path whose file is currently open renders dimmed,
  // no underline emphasis, and pressing it is a no-op.
  const isOpen = useOrbital((s) => s.ui.fileViewer?.path === path)
  const lineSuffix = suffix ?? (line !== null ? `:${line}` : '')

  return (
    <button
      type="button"
      data-path-button
      data-open={isOpen || undefined}
      onClick={(event) => {
        event.stopPropagation()
        if (isOpen) return
        openFile(path, line)
      }}
      className={[
        'group/path inline rounded-[4px] border-0 bg-transparent underline underline-offset-2',
        '[font:inherit] transition-[background-color,color,text-decoration-color] duration-[120ms] ease-[ease]',
        VARIANT_CLASSES[variant],
        isOpen
          ? // 8e OPEN: dimmed pill, faded dotted underline, dead press.
            'cursor-default bg-[rgba(150,205,255,.06)] text-[rgba(200,220,245,.6)] decoration-dotted decoration-[rgba(150,205,255,.2)]'
          : [
              'cursor-pointer decoration-dotted decoration-[rgba(150,205,255,.3)]',
              'hover:bg-[rgba(150,205,255,.12)] hover:text-[#f2f9ff] hover:decoration-solid hover:decoration-[oklch(85%_.12_205_/_.8)]',
              'active:bg-[rgba(150,205,255,.18)]',
              'focus-visible:bg-[rgba(150,205,255,.08)] focus-visible:shadow-[0_0_0_2px_oklch(85%_.12_205_/_.55)] focus-visible:outline-none',
            ].join(' '),
      ].join(' ')}
    >
      {path}
      {lineSuffix && (
        <span
          className={
            isOpen
              ? 'text-[rgba(160,190,225,.45)]'
              : 'text-[rgba(160,190,225,.6)] group-hover/path:text-[rgba(190,215,240,.75)]'
          }
        >
          {lineSuffix}
        </span>
      )}
    </button>
  )
}
