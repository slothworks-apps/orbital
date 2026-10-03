import type { HarnessEvent, SessionHarness } from '../../lib/types'
import { RecordView } from './RecordView'
import { RunningView } from './RunningView'
import { StepDiffView } from './StepDiffView'
import type { Chrome } from './parts'

/** What the slot shows: the checklist, a step's record (30e left), or its diff (30e right). */
export type HarnessNav = { kind: 'list' } | { kind: 'record'; index: number } | { kind: 'diff'; index: number }

/** One step back through the slot's views; null at the checklist. */
export function navBack(nav: HarnessNav): HarnessNav | null {
  if (nav.kind === 'diff') return { kind: 'record', index: nav.index }
  if (nav.kind === 'record') return { kind: 'list' }
  return null
}

/**
 * A harness in a column: the checklist, a record or a diff, as `nav` says.
 * The side slot and session stats → Harness (a removed harness, read-only)
 * both draw it.
 */
export function HarnessBody({
  sessionId,
  harness,
  events,
  chrome,
  readOnly,
  nav,
  setNav,
  onFull,
  onGoBack,
}: {
  sessionId: string
  harness: SessionHarness
  events: readonly HarnessEvent[]
  chrome: Chrome
  readOnly: boolean
  nav: HarnessNav
  setNav: (nav: HarnessNav) => void
  onFull: (() => void) | null
  onGoBack: ((index: number) => void) | null
}) {
  const index = nav.kind === 'list' ? -1 : Math.min(nav.index, harness.steps.length - 1)
  if (nav.kind === 'diff' && index >= 0) {
    return (
      <StepDiffView
        sessionId={sessionId}
        harness={harness}
        index={index}
        chrome={chrome}
        onBack={() => setNav({ kind: 'record', index })}
      />
    )
  }
  if (nav.kind === 'record' && index >= 0) {
    const state = harness.state[index]
    return (
      <RecordView
        sessionId={sessionId}
        harness={harness}
        events={events}
        index={index}
        chrome={chrome}
        onBack={() => setNav({ kind: 'list' })}
        onDiff={() => setNav({ kind: 'diff', index })}
        onGoBack={onGoBack && state?.startMessageUuid && state.status !== 'pending' ? () => onGoBack(index) : null}
      />
    )
  }
  return (
    <RunningView
      sessionId={sessionId}
      harness={harness}
      events={events}
      chrome={chrome}
      readOnly={readOnly}
      onRecord={(i) => setNav({ kind: 'record', index: i })}
      onFull={onFull}
    />
  )
}
