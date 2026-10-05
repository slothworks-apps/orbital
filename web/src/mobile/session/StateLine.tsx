import { timeAgo } from '../../lib/format'
import { stateColor } from '../../lib/stateStyle'
import { sessionStateKey } from '../../lib/types'
import { useNow } from '../../lib/useNow'
import { CLOCK_TICK_MS } from '../constants'
import { Glyph } from '../screens/Glyph'
import { useMobile } from '../state'
import { headerState, type HeaderStateKind } from '../stateWords'
import type { SlotProps } from './slot'

/**
 * The neutral ink of the still states: canvas 10k's limit wait, 10c's
 * reviewer and 10b's reopened step. Never amber — none of them asks anything.
 */
const NEUTRAL_INK: Record<Exclude<HeaderStateKind, 'plain' | 'gate'>, string> = {
  limit: 'rgba(200,215,235,.8)',
  reviewer: 'rgba(200,215,235,.75)',
  reopened: 'rgba(200,215,235,.75)',
}

/**
 * Header row 2, first: the state's mark and word (`stateWords.ts`), and on
 * a plain live state the age of the last activity. A gate's diamond and the
 * neutral states' hollow dot are still — no breathe, no pulse (canvas 10b,
 * 10k; `why-orbital`).
 */
export function StateLine({ session, offline }: SlotProps) {
  const asOf = useMobile((s) => s.asOf)
  const reopenedStep = useMobile((s) =>
    s.composerIntent?.sessionId === session.id && s.composerIntent.intent.kind === 'reopen'
      ? s.composerIntent.intent.step
      : null,
  )
  const now = useNow(true, CLOCK_TICK_MS)
  const state = headerState({ session, offline, asOf, now, reopenedStep })
  const key = sessionStateKey(session)
  const ink = state.kind === 'plain' || state.kind === 'gate' ? stateColor(key) : NEUTRAL_INK[state.kind]

  return (
    <span
      className="flex shrink-0 items-center gap-[7px] pr-2.5 font-mono text-[10.5px] tracking-[0.1em]"
      style={{ color: ink }}
    >
      {state.kind === 'plain' ? (
        <Glyph session={session} offline={offline} />
      ) : state.kind === 'gate' ? (
        // Canvas 10b: a 7 px square turned to a diamond, filled, still.
        <span
          aria-hidden
          className={['block h-[7px] w-[7px] shrink-0 rotate-45 rounded-[1.5px]', offline ? 'opacity-50' : ''].join(' ')}
          style={{ background: ink }}
        />
      ) : (
        // Canvas 10k, 10c: a hollow 7 px dot, still.
        <span
          aria-hidden
          className="box-border block h-[7px] w-[7px] shrink-0 rounded-full border-[1.5px] border-[rgba(200,215,235,.75)]"
        />
      )}
      {state.word}
      {/* Live, the last activity; offline, the word already says when. */}
      {state.age && session.lastAt !== null && <span>· {timeAgo(session.lastAt, now)}</span>}
    </span>
  )
}
