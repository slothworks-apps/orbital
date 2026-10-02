import { stateColor } from '../../lib/stateStyle'
import { sessionStateKey, type ApiSession } from '../../lib/types'
import { StateDot } from '../../ui/StateDot'
import { glyphFor } from '../sessionList'

/** 9p's glyph sizes, px; the fidelity pass owns them. */
export const GLYPH_SOLID_PX = 8
export const GLYPH_HOLLOW_PX = 9

type StateFields = Pick<ApiSession, 'status' | 'interruptedAt' | 'pendingDecision' | 'awaitingSubagents' | 'subagents' | 'backgroundTasks'>

export function Glyph({ session, offline }: { session: StateFields; offline: boolean }) {
  const key = sessionStateKey(session)
  return (
    <span className={['inline-flex w-[14px] shrink-0 justify-center', offline ? 'opacity-50' : ''].join(' ')}>
      <StateDot dot={glyphFor(key, offline)} color={stateColor(key)} solidPx={GLYPH_SOLID_PX} hollowPx={GLYPH_HOLLOW_PX} />
    </span>
  )
}
