import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { claudeDirMark, claudeDirMonograms, type ClaudeDirMarkInfo } from '../lib/claudeDirs'
import { useOrbital } from '../store/store'

/**
 * Which of the mark's sizes this is, named for where it is used (canvas 44f
 * "Sizes"). `map` is drawn in `Planet.tsx` itself — an opaque tile with a
 * dark ring that holds over stars and orbits — and is not one of these.
 */
export type ClaudeDirMarkSize = 'desktop' | 'phone' | 'sheet'

const SIZES = {
  /** 44b/44c/44e: sidebar meta line, detail chip, dialog trigger and menu rows, the waits list. */
  desktop: 'min-w-[14px] h-[14px] px-[2.5px] rounded-[4px] text-[8.5px]',
  /** 44d's list row and New session row; 44a's Settings rows and 44e's group heads use it too. */
  phone: 'min-w-4 h-4 px-[3px] rounded-[4.5px] text-[9.5px]',
  /** 44d's bottom sheet rows. */
  sheet: 'min-w-[18px] h-[18px] px-[3px] rounded-[5px] text-[10px]',
} as const satisfies Record<ClaudeDirMarkSize, string>

/**
 * A Claude directory's mark (canvas 44f "Mark"): a filled, borderless square
 * tile carrying the directory's monogram. Everything else Orbital uses to show
 * a status is round, coloured or both, and its key hints are outlined boxes —
 * so a filled square in one neutral ink reads as neither. It never moves and
 * never takes a hue.
 */
export function ClaudeDirMark({
  mono,
  title,
  size = 'desktop',
  missing = false,
}: {
  mono: string
  /** The tooltip (`claudeDirTooltip`); omitted where the name and path sit beside it. */
  title?: string
  size?: ClaudeDirMarkSize
  /** 44a: a directory missing on disk keeps its mark at .55. */
  missing?: boolean
}) {
  return (
    <span
      data-claude-dir-mark
      title={title}
      aria-hidden={title === undefined ? true : undefined}
      className={[
        'inline-grid flex-none place-items-center box-border bg-[rgba(200,215,235,.2)] font-mono font-semibold leading-none tracking-normal text-[#eef4fc]',
        SIZES[size],
        missing ? 'opacity-55' : '',
      ].join(' ')}
    >
      {mono}
    </span>
  )
}

/**
 * A session's directory mark, read from the store: null with fewer than two
 * directories (canvas 44f "One directory") or for a directory the list does
 * not hold. Selects the list itself, which only changes on a reload, so a
 * re-render elsewhere does not rebuild the monograms.
 */
export function useClaudeDirMark(claudeDirId: number | null | undefined): ClaudeDirMarkInfo | null {
  const dirs = useOrbital(useShallow((s) => s.claudeDirs))
  const monograms = useMemo(() => claudeDirMonograms(dirs), [dirs])
  return useMemo(() => claudeDirMark(dirs, claudeDirId, monograms), [dirs, claudeDirId, monograms])
}

/** Every directory's monogram, for a picker that lists them all. */
export function useClaudeDirMonograms(): Map<number, string> {
  const dirs = useOrbital(useShallow((s) => s.claudeDirs))
  return useMemo(() => claudeDirMonograms(dirs), [dirs])
}

/**
 * The session's directory in the detail header (canvas 44b): the mark and the
 * name in a hairline chip, after the tag chip. Read-only — a session never
 * changes directory — and radius 5, because the tag beside it is the pill.
 */
export function ClaudeDirChip({ mark }: { mark: ClaudeDirMarkInfo }) {
  return (
    <span
      data-claude-dir-chip
      title={mark.title}
      className="box-border flex min-w-0 max-w-40 items-center gap-1.5 rounded-[5px] border border-[rgba(150,205,255,.16)] py-[3px] pl-[5px] pr-[9px] font-mono text-[10.5px] text-[rgba(214,230,248,.88)]"
    >
      <ClaudeDirMark mono={mark.mono} />
      <span className="min-w-0 truncate">{mark.name}</span>
    </span>
  )
}
