import { isReadOnly } from '../../lib/types'
import { SEGMENT_INK } from '../harness/StepsSheet'
import type { SlotProps } from '../session/slot'
import { sessionSupports } from '../version'
import { figureOf, progressTones } from './figure'
import { ListGlyph, openProgressSheet, useProgressSheetOpen } from './ProgressSheet'
import { useProgressFold } from '../../lib/useProgressList'

/**
 * Header row 2, after the state, where a harness shows its segments (canvas
 * 67g): the list glyph, one segment per counted item and "3/7 ▸", one 44 px
 * target that opens the list's sheet. Only while the session has a list the
 * Mac serves and no harness leads: once one is attached the list is frozen
 * and the row is the harness's (`HarnessProgress`). Still, like the harness's.
 */
export function ProgressReadout({ session }: SlotProps) {
  const fold = useProgressFold(session.id)
  const open = useProgressSheetOpen(session.id)
  const supported = sessionSupports('progressList', session.id)
  const figure = session.progress
  if (!supported || !figure || figure.frozen || session.harnessStep || isReadOnly(session)) return null
  const tones = progressTones(fold.list, figure)

  return (
    <button
      type="button"
      aria-label={`Progress: ${figure.done} of ${figure.total} done`}
      onClick={() => openProgressSheet(session.id)}
      className={[
        'flex h-11 min-w-11 shrink-0 items-center gap-[7px] rounded-[10px] px-2.5 font-mono fs-10.5 text-ink-500/85',
        // Canvas 67g: the readout keeps a fill while its sheet is open.
        open ? 'bg-line/14' : '',
      ].join(' ')}
    >
      <span className="flex text-ink-500/75">
        <ListGlyph />
      </span>
      {/* Canvas 67g: 5 × 10 px segments, 2 px apart, as the harness's (10b). */}
      <span aria-hidden className="flex gap-0.5">
        {tones.map((tone, i) => (
          <span key={i} className="block h-2.5 w-[5px] rounded-[1.5px]" style={{ background: SEGMENT_INK[tone] }} />
        ))}
      </span>
      {figureOf(figure)}
      <span aria-hidden className="fs-9 text-ink-900/60">
        ▸
      </span>
    </button>
  )
}
