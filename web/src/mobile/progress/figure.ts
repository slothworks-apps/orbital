import type { ProgressList } from '../../lib/progressList'

/** A segment of the header readout: one per counted item, in its state's ink. */
export type ProgressTone = 'done' | 'active' | 'pending'

/**
 * The readout's segments (canvas 67g `psegs`): a dropped item gets none.
 * From the held list when there is one; else from the session's figure,
 * which tells done from not done but not what is in progress.
 */
export function progressTones(list: ProgressList | null, figure: { done: number; total: number }): ProgressTone[] {
  if (list) {
    return list.items.flatMap((item): ProgressTone[] =>
      item.state === 'dropped' ? [] : [item.state === 'done' ? 'done' : item.state === 'in_progress' ? 'active' : 'pending'],
    )
  }
  return Array.from({ length: figure.total }, (_, i) => (i < figure.done ? 'done' : 'pending'))
}

/** "3/7", from the figure the session carries. Never a percentage. */
export function figureOf(figure: { done: number; total: number }): string {
  return `${figure.done}/${figure.total}`
}
