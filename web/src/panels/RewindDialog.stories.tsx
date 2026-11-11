import type { Meta, StoryObj } from '@storybook/react-vite'
import { BILLING, DEMO_EPOCH, MESSAGES, QUIET, subagent } from '../../../site/demo/fake/fixtures'
import type { ApiSession, BackgroundTask } from '../lib/types'
import { useOrbital } from '../store/store'
import { useRewindUi } from '../store/rewind'
import { RewindDialog } from './RewindDialog'

const MINUTE = 60_000

const TESTS: BackgroundTask = {
  id: 'task-tests',
  kind: 'shell',
  label: 'Run the webhook tests',
  command: 'npm test -- --watch webhooks',
  hasOutput: true,
  state: 'running',
  startedAt: DEMO_EPOCH - 4 * MINUTE,
}

/** Working, with a subagent and a shell still running beside the turn. */
const WORKING: ApiSession = {
  ...BILLING,
  subagents: [subagent(BILLING.id, 1, 'Check the retry helper', 'working')],
  backgroundTasks: [TESTS],
}

/** The turn over, one shell still running. */
const IDLE = { ...QUIET[0], backgroundTasks: [{ ...TESTS, label: 'Paginate fixtures', command: 'npm run seed' }] }

/**
 * Seeds the session and its transcript, and parks a pick that waits on the
 * dialog — what a pick on a session with something running does.
 */
function pick(session: ApiSession): () => () => void {
  return () => {
    const before = useOrbital.getState()
    useOrbital.setState({
      sessions: { [session.id]: session },
      transcripts: { [session.id]: MESSAGES[session.id] ?? [] },
    })
    useRewindUi.setState({
      picked: { sessionId: session.id, messageId: 'm1', uuid: 'u1', hiddenCount: 4, confirming: true },
    })
    return () => {
      useOrbital.setState(before, true)
      useRewindUi.setState({ picked: null })
    }
  }
}

const meta = {
  title: 'Panels/RewindDialog',
  component: RewindDialog,
  parameters: { layout: 'fullscreen' },
  args: { sessionId: WORKING.id },
  render: (args) => (
    <div className="min-h-screen">
      <RewindDialog {...args} />
    </div>
  ),
} satisfies Meta<typeof RewindDialog>
export default meta

type Story = StoryObj<typeof meta>

/** Mid-turn: the turn, the subagent and the shell listed, each with how long it has run. */
export const Working: Story = { beforeEach: pick(WORKING) }

/** Mid-turn with nothing else running: no list. */
export const TurnOnly: Story = { beforeEach: pick(BILLING), args: { sessionId: BILLING.id } }

/** The turn over, a background task still running: the TASKS RUNNING wording. */
export const TasksRunning: Story = { beforeEach: pick(IDLE), args: { sessionId: IDLE.id } }
