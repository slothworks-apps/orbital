import { describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_OPTIONS, type HarnessEvent, type SessionHarness, type StepState } from '../lib/types'
import {
  foldLine,
  foldStands,
  gateImages,
  gateView,
  goBackLines,
  shortSummary,
  type GateFold,
} from '../mobile/harness/gate'

const T0 = Date.parse('2026-10-05T21:40:00Z')

function harness(state: StepState[], over: Partial<SessionHarness> = {}): SessionHarness {
  return {
    sessionId: 's1',
    templateId: 1,
    name: 'Build a component',
    steps: state.map((_, i) => ({
      id: `s${i}`,
      title: `Step title ${i + 1}`,
      instructions: '',
      mode: i === 3 || i === 6 ? 'gate' : 'auto',
      doneWhen: '',
    })),
    inputs: {},
    state,
    options: DEFAULT_HARNESS_OPTIONS,
    paused: false,
    pauseReason: null,
    pauseKind: null,
    pausedAt: null,
    removedAt: null,
    autoRounds: 0,
    idleNudges: 0,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  }
}

const done: StepState = { status: 'done', completedAt: T0 + 1000 }
const pending: StepState = { status: 'pending' }

function event(id: number, kind: HarnessEvent['kind'], at: number, detail: Record<string, unknown>): HarnessEvent {
  return { id, sessionId: 's1', at, kind, detail }
}

const waitingState: StepState = {
  status: 'awaiting_approval',
  summary: '18 of 24 stories match. Fixed 4 (padding in size sm). See /tmp/shots/focus-ring.png and docs/parity/Button.md.',
  evidence: 'Compared /tmp/shots/pressed-dark.png and /tmp/shots/focus-ring.png',
  openQuestions: ['Focus ring 2 px or 3 px?', 'Add shadow-press?'],
  startHead: '8be04d7aaaaaaa',
  endHead: 'c40a1e5bbbbbbb',
  startMessageUuid: 'u-4',
}

describe('gateView', () => {
  it('a waiting gate is the card with everything it answers', () => {
    const h = harness([done, done, done, waitingState, pending, pending, pending])
    const events = [event(1, 'ticked', T0 + 5000, { step: 's3', index: 3, verify: 'passed', gate: true })]
    const view = gateView({ harness: h, events, fold: null })
    expect(view).toMatchObject({
      kind: 'waiting',
      index: 3,
      step: 4,
      total: 7,
      title: 'Step title 4',
      openQuestions: ['Focus ring 2 px or 3 px?', 'Add shadow-press?'],
      images: ['/tmp/shots/focus-ring.png', '/tmp/shots/pressed-dark.png'],
      range: '8be04d7..c40a1e5',
      verifyPassed: true,
      next: { step: 5, title: 'Step title 5', gate: false },
    })
  })

  it('verify passed only when the last tick says so', () => {
    const h = harness([done, done, done, waitingState, pending, pending, pending])
    const events = [
      event(1, 'ticked', T0 + 5000, { step: 's3', index: 3, verify: 'passed' }),
      event(2, 'ticked', T0 + 9000, { step: 's3', index: 3 }),
    ]
    const view = gateView({ harness: h, events, fold: null })
    expect(view.kind === 'waiting' && view.verifyPassed).toBe(false)
  })

  it('the reviewer reading is its own card, naming the diff and the files', () => {
    const h = harness([done, done, done, { ...waitingState, reviewing: true }, pending, pending, pending])
    const view = gateView({ harness: h, events: [], fold: null })
    expect(view.kind).toBe('reviewing')
    expect(view.kind === 'reviewing' && view.reading).toBe(
      'reading · diff 8be04d7..c40a1e5 · /tmp/shots/focus-ring.png · docs/parity/Button.md · /tmp/shots/pressed-dark.png',
    )
  })

  it('a standing gate wins over an old fold', () => {
    const h = harness([done, done, done, waitingState, pending, pending, pending])
    const fold: GateFold = { kind: 'approved', index: 2, total: 7, at: T0 }
    expect(gateView({ harness: h, events: [], fold }).kind).toBe('waiting')
  })

  it('approved just now folds into one line', () => {
    const h = harness([done, done, done, done, { status: 'active' }, pending, pending])
    const fold: GateFold = { kind: 'approved', index: 3, total: 7, at: T0 }
    expect(gateView({ harness: h, events: [], fold })).toEqual({
      kind: 'fold',
      mark: '✓',
      text: 'Approved step 4 · on to step 5',
    })
  })

  it('gone back folds with the rewind line', () => {
    const h = harness([done, done, done, { status: 'active' }, pending, pending, pending])
    const fold: GateFold = { kind: 'rewound', index: 3, total: 7, at: T0 }
    expect(gateView({ harness: h, events: [], fold })).toEqual({
      kind: 'fold',
      mark: '↺',
      text: 'Back at the start of step 4 · the agent starts it again',
    })
  })

  it('a reopened step is the note, with when', () => {
    const h = harness([done, done, done, { status: 'active' }, pending, pending, pending])
    const events = [
      event(1, 'advanced', T0 + 1000, { step: 's3', index: 3 }),
      event(2, 'reopened', T0 + 9000, { step: 's3', index: 3 }),
    ]
    expect(gateView({ harness: h, events, fold: null })).toEqual({ kind: 'reopened', step: 4, at: T0 + 9000 })
  })

  it('a step simply at work, or no harness, draws nothing', () => {
    const h = harness([done, done, done, { status: 'active' }, pending, pending, pending])
    expect(gateView({ harness: h, events: [], fold: null }).kind).toBe('none')
    expect(gateView({ harness: null, events: [], fold: null }).kind).toBe('none')
  })

  it('the last step approved says every step is done', () => {
    expect(foldLine({ kind: 'approved', index: 6, total: 7, at: T0 }).text).toBe('Approved step 7 · every step is done')
  })
})

describe('foldStands', () => {
  const fold: GateFold = { kind: 'approved', index: 3, total: 7, at: T0 }
  it('stands until the agent writes after the answer', () => {
    expect(foldStands(fold, [{ role: 'assistant', timestamp: new Date(T0 - 1).toISOString() }])).toBe(true)
    expect(
      foldStands(fold, [
        { role: 'assistant', timestamp: new Date(T0 - 1).toISOString() },
        { role: 'user', timestamp: new Date(T0 + 5).toISOString() },
      ]),
    ).toBe(true)
    expect(foldStands(fold, [{ role: 'assistant', timestamp: new Date(T0 + 5).toISOString() }])).toBe(false)
  })
})

describe('gateImages', () => {
  it('picks image paths out of the words, in order, once each', () => {
    expect(
      gateImages([
        'Shots in /tmp/a.png and docs/x.md, then /tmp/b.webp.',
        'Again /tmp/a.png; https://example.com/c.png is a URL',
        undefined,
      ]),
    ).toEqual(['/tmp/a.png', '/tmp/b.webp'])
  })
  it('nothing named, nothing shown', () => {
    expect(gateImages(['18 of 24 stories match.', null])).toEqual([])
  })
})

describe('shortSummary', () => {
  it('first sentence and the open questions', () => {
    expect(shortSummary('18 of 24 stories match. Fixed 4 (padding).', 2)).toBe('18 of 24 stories match. 2 open questions.')
    expect(shortSummary('One line only', 0)).toBe('One line only')
    expect(shortSummary(undefined, 1)).toBe('1 open question.')
  })
})

describe('goBackLines', () => {
  const h = harness([done, done, done, waitingState, pending, pending, pending])

  it('with a range: the commits stay in git', () => {
    expect(goBackLines(h, 3, false)).toEqual({
      eyebrow: 'GO BACK · STEP 04',
      title: 'Go back to the start of step 4?',
      body: 'The conversation returns to the message that sent the agent on to step 4, and the agent starts the step again.',
      detail: ['Commits stay in git · 8be04d7..c40a1e5', 'Orbital never resets files for you'],
      confirm: 'Go back to step 4',
    })
  })

  it('without a range: only that files are never reset', () => {
    const bare = harness([done, done, done, { ...waitingState, startHead: undefined }, pending, pending, pending])
    expect(goBackLines(bare, 3, false).detail).toEqual(['Orbital never resets files for you'])
  })

  it('with something running: says it stops', () => {
    expect(goBackLines(h, 3, true).body.startsWith('The turn and anything running in the session stop. ')).toBe(true)
  })
})
