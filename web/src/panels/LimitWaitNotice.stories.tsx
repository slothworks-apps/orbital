import type { Meta, StoryObj } from '@storybook/react-vite'
import { BILLING, SETTINGS } from '../../../site/demo/fake/fixtures'
import { AUTO_CONTINUE_KEY } from '../lib/limits'
import type { LimitWait } from '../lib/types'
import { useOrbital } from '../store/store'
import { LimitWaitNotice } from './LimitWaitNotice'

const WAIT: LimitWait = {
  resetsAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
  windowKind: 'session',
  windowLabel: '5-hour window',
  cancelled: false,
  willContinue: true,
  queued: [],
}

/** The auto-continue setting the notice reads when the wait does not carry it. */
function autoContinue(on: boolean): () => () => void {
  return () => {
    const before = useOrbital.getState()
    useOrbital.setState({ settings: { ...SETTINGS, [AUTO_CONTINUE_KEY]: on ? 'true' : 'false' } })
    return () => useOrbital.setState(before, true)
  }
}

const meta = {
  title: 'Panels/LimitWaitNotice',
  component: LimitWaitNotice,
  args: { sessionId: BILLING.id, wait: WAIT, hue: 210 },
  beforeEach: autoContinue(true),
  render: (args) => (
    <div className="w-[450px]">
      <LimitWaitNotice {...args} />
    </div>
  ),
} satisfies Meta<typeof LimitWaitNotice>
export default meta

type Story = StoryObj<typeof meta>

/** Auto-continue on: continues at the reset, with Cancel. */
export const Continues: Story = {}

/** Cancelled for this wait: resets, with Undo. */
export const Cancelled: Story = { args: { wait: { ...WAIT, cancelled: true, willContinue: false } } }

/** Auto-continue off in Settings: the reset time and the way to Settings. */
export const AutoContinueOff: Story = {
  args: { wait: { ...WAIT, willContinue: false, autoContinue: false, continueText: 'Continue' } },
}

/** Messages written during the wait: queued under the row, dashed in the tag's hue. */
export const Queued: Story = {
  args: {
    wait: {
      ...WAIT,
      queued: ['Also cover the 429 case in the retry.', 'And log the attempt number.'],
    },
  },
}
