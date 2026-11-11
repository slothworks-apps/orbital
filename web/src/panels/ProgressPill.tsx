import type { RefObject } from 'react'
import type { ProgressItemState } from '@orbital/shared/progress'
import { useOrbital } from '../store/store'
import { progressListEnabled } from '../lib/experimental'
import { shortcutLabel } from '../lib/keymap'
import { flyoutReading } from '../lib/progressList'
import { useProgressFold } from '../lib/useProgressList'
import type { ApiSession } from '../lib/types'
import { ProgressGlyph } from '../ui/UtilityButton'
import { EdgePill } from './HarnessPill'

/** 67b `SEGC`: mint done, cyan in progress, faint to do; a dropped item has no segment. */
const SEGMENT: Record<Exclude<ProgressItemState, 'dropped'>, string> = {
  done: 'bg-success/75',
  in_progress: 'bg-accent',
  pending: 'bg-line/18',
}

/** 67h 2: past this many counted items the segments shrink, so 15 still fit beside the header. */
const TALL_SEGMENTS_MAX = 10

/**
 * The progress list's handle on the session panel's edge (canvas `Feature -
 * Progress list` 67b): the harness pill's shell and place, the list glyph on
 * top and one segment per counted item. Shown once the agent has written a
 * list, while the Labs switch is on; a harness attached takes the place, so
 * a frozen list has none. A press, or ⌘⇧P, toggles the list in the side slot.
 */
export function ProgressPill({
  session,
  stateRowRef,
  edge,
}: {
  session: ApiSession
  stateRowRef: RefObject<HTMLElement | null>
  edge: 'over' | 'inside'
}) {
  const enabled = useOrbital((s) => progressListEnabled(s.settings))
  const panelOpen = useOrbital((s) => s.progressPanel?.sessionId === session.id)
  const openProgress = useOrbital((s) => s.openProgress)
  const shown = enabled && session.progress != null && !session.progress.frozen
  const { list } = useProgressFold(shown ? session.id : undefined)
  if (!shown || !session.progress) return null

  const { done, total } = session.progress
  // The list once it is folded; until then the figure alone, done first.
  const states: Exclude<ProgressItemState, 'dropped'>[] = list
    ? list.items.flatMap((item) => (item.state === 'dropped' ? [] : [item.state]))
    : Array.from({ length: total }, (_, i) => (i < done ? 'done' : 'pending'))
  const tall = states.length <= TALL_SEGMENTS_MAX
  const reading = list ? flyoutReading(list) : null
  const figure = `${done}/${total}`

  return (
    <EdgePill
      stateRowRef={stateRowRef}
      edge={edge}
      panelOpen={panelOpen}
      label={`Progress: ${done} of ${total} done`}
      marker="data-progress-pill"
      onActivate={() => openProgress(session.id)}
      glyph={
        <span className="flex text-ink-500/75">
          <ProgressGlyph />
        </span>
      }
      segments={states.map((state, i) => (
        <span key={i} className={['block w-1 rounded-[1px]', tall ? 'h-2' : 'h-[5px]', SEGMENT[state]].join(' ')} />
      ))}
      flyout={
        <>
          <span className="flex items-center gap-2 font-mono fs-9.5 tracking-[0.16em] text-ink-900/60">
            PROGRESS
            <span className="flex-1" />
            <span className="tracking-[0.04em] text-ink-100">{figure}</span>
          </span>
          {reading && (
            <>
              <span className="line-clamp-2 fs-12.5 leading-[1.4] font-semibold text-ink-100">{reading.title}</span>
              <span className="font-mono fs-10 text-ink-900/70">{reading.line}</span>
            </>
          )}
          <span className="border-t border-solid border-line/8 pt-[7px] font-mono fs-9.5 text-ink-900/55">
            click · open the list · {shortcutLabel('session.progress')}
          </span>
        </>
      }
    />
  )
}
