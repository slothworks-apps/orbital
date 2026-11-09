import type { Meta, StoryObj } from '@storybook/react-vite'
import { useRef } from 'react'
import { userEvent } from 'storybook/test'
import { BILLING, DEMO_EPOCH } from '../../../site/demo/fake/fixtures'
import { HARNESS_ENABLED_KEY } from '../lib/experimental'
import { DEFAULT_HARNESS_OPTIONS, type SessionHarness, type StepState } from '../lib/types'
import { useOrbital } from '../store/store'
import { Badge } from '../ui/Badge'
import { HarnessPill } from './HarnessPill'

const STEPS: SessionHarness['steps'] = [
  { id: 'read', title: 'Read how the sender posts today', instructions: '', mode: 'auto', doneWhen: 'The call site is named.' },
  { id: 'retry', title: 'Wrap the post in withRetry', instructions: '', mode: 'auto', doneWhen: 'The sender retries on 5xx.' },
  { id: 'review', title: 'Review the backoff with me', instructions: '', mode: 'gate', doneWhen: 'Approved.' },
  { id: 'tests', title: 'Cover the retry with tests', instructions: '', mode: 'auto', doneWhen: 'npm test passes.' },
]

function harness(state: StepState[], fields: Partial<SessionHarness> = {}): SessionHarness {
  return {
    sessionId: BILLING.id,
    templateId: 1,
    name: 'Feature with a review gate',
    steps: STEPS,
    inputs: {},
    state,
    options: DEFAULT_HARNESS_OPTIONS,
    paused: false,
    pauseReason: null,
    pauseKind: null,
    pausedAt: null,
    removedAt: null,
    autoRounds: 3,
    idleNudges: 0,
    createdAt: DEMO_EPOCH,
    updatedAt: DEMO_EPOCH,
    ...fields,
  }
}

const done: StepState = { status: 'done' }
const pending: StepState = { status: 'pending' }

const HARNESSES = {
  working: harness([done, { status: 'active' }, pending, pending]),
  gate: harness([done, done, { status: 'awaiting_approval', openQuestions: ['Five attempts or three?'] }, pending]),
  reviewing: harness([done, done, { status: 'awaiting_approval', reviewing: true }, pending]),
  paused: harness([done, { status: 'active' }, pending, pending], { paused: true, pauseKind: 'user', pausedAt: DEMO_EPOCH }),
  finished: harness([done, done, done, done]),
} satisfies Record<string, SessionHarness>

/** The Harness switch on, and the session's harness already read. */
function seedStore(which: keyof typeof HARNESSES): () => () => void {
  return () => {
    const before = useOrbital.getState()
    useOrbital.setState({
      settings: { ...before.settings, [HARNESS_ENABLED_KEY]: 'true' },
      harnesses: { [BILLING.id]: HARNESSES[which] },
    })
    return () => useOrbital.setState(before, true)
  }
}

/** The docked detail panel's header, 450px wide, with the state row the pill aligns to. */
function PillDemo({ edge }: { edge: 'over' | 'inside' }) {
  const stateRowRef = useRef<HTMLDivElement | null>(null)
  return (
    <div className="flex justify-end" style={{ height: 260, paddingRight: 340 }}>
      <div className="relative h-full" style={{ width: 450 }}>
        <HarnessPill session={BILLING} stateRowRef={stateRowRef} edge={edge} />
        <div className="h-full overflow-hidden rounded-[14px] border border-line/14 bg-panel/90 px-[22px] pt-5">
          <div className="fs-15 font-semibold text-ink-100">{BILLING.title}</div>
          <div ref={stateRowRef} className="mt-3 flex items-center gap-2.5">
            <Badge variant="status" state="working" />
          </div>
        </div>
      </div>
    </div>
  )
}

/** Hovers the pill; the flyout follows after its delay. */
const hoverPill: Story['play'] = async ({ canvasElement }) => {
  const pill = await new Promise<HTMLElement>((resolve) => {
    const find = () => {
      const el = canvasElement.querySelector<HTMLElement>('[data-harness-pill]')
      if (el) resolve(el)
      else requestAnimationFrame(find)
    }
    find()
  })
  await userEvent.hover(pill)
}

const meta = {
  title: 'Panels/HarnessPill',
  component: PillDemo,
  parameters: { layout: 'fullscreen' },
  beforeEach: seedStore('working'),
  args: { edge: 'over' },
} satisfies Meta<typeof PillDemo>
export default meta

type Story = StoryObj<typeof meta>

/** Step 2 of 4 at work: the cyan dot and one segment per step. */
export const Working: Story = {}

/** The hover flyout: the step, its state and the way in. */
export const Flyout: Story = { play: hoverPill }

/** A gate waiting for your OK, with an open question. */
export const Gate: Story = { beforeEach: seedStore('gate'), play: hoverPill }

/** The reviewer is reading the gate: the eye. */
export const Reviewing: Story = { beforeEach: seedStore('reviewing'), play: hoverPill }

/** Paused by hand: two bars. */
export const Paused: Story = { beforeEach: seedStore('paused'), play: hoverPill }

/** Every step done. */
export const Finished: Story = { beforeEach: seedStore('finished') }

/** A detached window: inside its own right edge, not half over it. */
export const Inside: Story = { args: { edge: 'inside' } }
