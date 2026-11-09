import type { Meta, StoryObj } from '@storybook/react-vite'
import { BILLING, DEMO_EPOCH } from '../../../site/demo/fake/fixtures'
import { EMPTY_OUTPUT } from '../lib/backgroundTasks'
import type { BackgroundTask } from '../lib/types'
import { useOrbital, type OrbitalState } from '../store/store'
import { TaskChip } from './TaskChip'

const MINUTE = 60_000

/** One of each kind and ending, as the billing session might have launched them. */
const TASKS: BackgroundTask[] = [
  {
    id: 'dev-server',
    kind: 'shell',
    label: 'Dev server',
    command: 'npm run dev -- --port 4000',
    intent: 'keep',
    state: 'running',
    startedAt: DEMO_EPOCH - 3 * 60 * MINUTE - 4 * MINUTE,
    toolUseId: 'billing-call-dev',
    hasOutput: true,
  },
  {
    id: 'watch-tests',
    kind: 'monitor',
    label: 'Watch the webhook tests',
    command: 'npx vitest --watch src/webhooks',
    state: 'running',
    startedAt: DEMO_EPOCH - 12 * MINUTE,
    hasOutput: true,
  },
  {
    id: 'lint',
    kind: 'shell',
    label: 'Lint the sender',
    command: 'npx eslint src/webhooks',
    state: 'ended',
    status: 'completed',
    exitCode: 0,
    startedAt: DEMO_EPOCH - 20 * MINUTE,
    endedAt: DEMO_EPOCH - 19 * MINUTE,
    hasOutput: true,
  },
  {
    id: 'migrate',
    kind: 'shell',
    label: 'Run the retry migration',
    command: 'npm run db:migrate',
    state: 'ended',
    status: 'failed',
    exitCode: 1,
    startedAt: DEMO_EPOCH - 30 * MINUTE,
    endedAt: DEMO_EPOCH - 29 * MINUTE,
    hasOutput: true,
  },
  {
    id: 'release-flow',
    kind: 'workflow',
    label: 'Release checklist',
    state: 'ended',
    status: 'stopped',
    startedAt: DEMO_EPOCH - 40 * MINUTE,
    endedAt: DEMO_EPOCH - 35 * MINUTE,
    hasOutput: false,
  },
  {
    id: 'mcp-index',
    kind: 'mcp',
    label: 'Index the API docs',
    state: 'ended',
    startedAt: DEMO_EPOCH - 50 * MINUTE,
    endedAt: DEMO_EPOCH - 48 * MINUTE,
    hasOutput: false,
  },
]

const RUNNING_ONLY = TASKS.filter((task) => task.state === 'running')
const ENDED_ONLY = TASKS.filter((task) => task.state === 'ended')

/** The store's stop and output state, put back after the story. */
function seedStore(patch: Partial<OrbitalState> = {}): () => () => void {
  return () => {
    const before = useOrbital.getState()
    useOrbital.setState(patch)
    return () => useOrbital.setState(before, true)
  }
}

/** Opens the dropdown as the story mounts. */
const openOnMount: Story['play'] = ({ canvasElement }) => {
  canvasElement.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.click()
}

const meta = {
  title: 'Panels/TaskChip',
  component: TaskChip,
  beforeEach: seedStore(),
  args: { sessionId: BILLING.id, tasks: TASKS, compact: false, waiting: false },
  // The detail header's state row, 450px wide, with room under it for the list.
  render: (args) => (
    <div style={{ width: 450, height: 520 }}>
      <div className="flex items-center gap-2.5">
        <TaskChip {...args} />
      </div>
    </div>
  ),
} satisfies Meta<typeof TaskChip>
export default meta

type Story = StoryObj<typeof meta>

/** Running and ended tasks: `2 running · 3h 4m`. */
export const Running: Story = {}

/** Nothing runs any more: the ended count, and the failed one in its own ink. */
export const Ended: Story = { args: { tasks: ENDED_ONLY } }

/** The narrow column beside the subagent chip: the bare count. */
export const Compact: Story = { args: { compact: true } }

/** The turn is over and the session waits on what it launched: the noun alone. */
export const Waiting: Story = { args: { tasks: RUNNING_ONLY, waiting: true } }

/** The dropdown: running first with a stop on each, then the ended ones, each tone once. */
export const Open: Story = { play: openOnMount }

/** A stop pressed and not yet confirmed by the SDK: its ■ dims and waits. */
export const Stopping: Story = {
  beforeEach: seedStore({ stoppingTasks: { [`${BILLING.id}:dev-server`]: true } }),
  play: openOnMount,
}

/** The dev server's output is open in the side slot: the chip is the active chip and the row is ticked. */
export const OutputOpen: Story = {
  beforeEach: seedStore({
    taskOutput: { sessionId: BILLING.id, taskId: 'dev-server', phase: 'ready', output: EMPTY_OUTPUT, end: 0, pending: [] },
  }),
  play: openOnMount,
}
