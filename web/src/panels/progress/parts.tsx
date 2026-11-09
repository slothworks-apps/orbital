import type { ProgressItem, ProgressItemState } from '@orbital/shared/progress'

/**
 * An item's mark (canvas `Feature - Progress list` 67c, `MK`): a hollow ring
 * to do, the cyan dot in progress, the mint dot done, a dash dropped. The
 * harness's colours without amber (67h 1), round so nothing reads as a box
 * to tick (67h 3). Nothing moves.
 */
const MARK: Record<ProgressItemState, string> = {
  pending: 'size-[7px] rounded-full border-[1.3px] border-solid border-ink-900/50',
  in_progress: 'size-[7px] rounded-full border-[1.3px] border-solid border-accent bg-accent',
  done: 'size-[7px] rounded-full border-[1.3px] border-solid border-success/75 bg-success/75',
  dropped: 'h-[1.4px] w-[7px] rounded-[1px] bg-ink-900/55',
}

/** The title's ink and weight per state (67c `MK`); dropped is struck through. */
const TITLE: Record<ProgressItemState, string> = {
  pending: 'font-medium text-ink-600/66',
  in_progress: 'font-semibold text-ink-100',
  done: 'font-medium text-ink-200/82',
  dropped: 'font-medium text-ink-900/60 line-through decoration-ink-900/55',
}

export function ItemMark({ state }: { state: ProgressItemState }) {
  return <span aria-hidden className={`box-border block flex-none ${MARK[state]}`} />
}

/** The words a screen reader gets for a mark, which is only drawn. */
const STATE_WORDS: Record<ProgressItemState, string> = {
  pending: 'to do',
  in_progress: 'in progress',
  done: 'done',
  dropped: 'dropped',
}

/**
 * One item (67c in the slot, 67d unfolded in a transcript row): the mark, the
 * title on one line — cut, the whole of it on hover — and under a dropped
 * item its reason. `note` is the small mono line under it ("added 14:22").
 * Nothing about it is pressable (67h 3).
 */
export function ItemRow({ item, note, size }: { item: ProgressItem; note?: string | null; size: 'slot' | 'row' }) {
  const slot = size === 'slot'
  return (
    <li className={['flex flex-none gap-2.5', slot ? 'py-[5px]' : 'py-0.5'].join(' ')}>
      <span className={['grid w-3 flex-none place-items-center', slot ? 'h-[18px]' : 'h-[17px]'].join(' ')}>
        <ItemMark state={item.state} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span
          title={item.title}
          className={['truncate', slot ? 'fs-12.5 leading-[18px]' : 'fs-12 leading-[17px]', TITLE[item.state]].join(' ')}
        >
          <span className="sr-only">{STATE_WORDS[item.state]}: </span>
          {item.title}
        </span>
        {item.state === 'dropped' && item.reason && (
          <span
            className={[
              'line-clamp-2 text-pretty',
              slot ? 'fs-12 leading-[1.5] text-ink-600/74' : 'fs-11.5 leading-[1.45] text-ink-600/70',
            ].join(' ')}
          >
            {item.reason}
          </span>
        )}
        {note && <span className="font-mono fs-10 tracking-[0.03em] text-ink-900/58">{note}</span>}
      </span>
    </li>
  )
}
