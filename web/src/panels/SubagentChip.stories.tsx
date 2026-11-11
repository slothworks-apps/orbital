import type { Meta, StoryObj } from '@storybook/react-vite'
import { DEMO_EPOCH, MOBILE, subagent } from '../../../site/demo/fake/fixtures'
import type { ChatMessage, Subagent } from '../lib/types'
import { useOrbital, type OrbitalState } from '../store/store'
import { SubagentChip } from './SubagentChip'

const MINUTE = 60_000

/** The mobile session's three agents, two of them back, plus one that failed and one never launched from a call. */
const SUBAGENTS: Subagent[] = [
  subagent(MOBILE.id, 1, 'Trace the client token refresh', 'working'),
  subagent(MOBILE.id, 2, 'Check the server registration', 'working'),
  { ...subagent(MOBILE.id, 3, 'Read last week’s push logs', 'ended'), status: 'completed', endedAt: DEMO_EPOCH - 2 * MINUTE },
  { ...subagent(MOBILE.id, 4, 'Reproduce on Android 15', 'ended'), status: 'failed', endedAt: DEMO_EPOCH - MINUTE },
  { ...subagent(MOBILE.id, 5, 'Bisect the SDK upgrade', 'ended'), status: 'stopped', endedAt: DEMO_EPOCH - MINUTE },
  // No launching call: the row is listed, dimmed, and cannot be opened.
  { ...subagent(MOBILE.id, 6, 'Summarise the findings', 'ended'), toolUseId: undefined, status: 'completed' },
]

const RUNNING_ONLY = SUBAGENTS.filter((s) => s.state !== 'ended')
const ENDED_ONLY = SUBAGENTS.filter((s) => s.state === 'ended')

/** The parent's `Agent` calls, which the list reads each row's type from. */
const AGENT_CALLS: ChatMessage[] = SUBAGENTS.filter((s) => s.toolUseId).map((s, i) => ({
  id: `agent-call-${i}`,
  role: 'tool_use',
  toolName: 'Agent',
  toolUseId: s.toolUseId,
  toolInput: { description: s.name, subagent_type: i % 2 === 0 ? 'Explore' : 'general-purpose' },
}))

/** The store's transcript, stop and open-panel state, put back after the story. */
function seedStore(patch: Partial<OrbitalState> = {}): () => () => void {
  return () => {
    const before = useOrbital.getState()
    useOrbital.setState({ transcripts: { [MOBILE.id]: AGENT_CALLS }, ...patch })
    return () => useOrbital.setState(before, true)
  }
}

/** Opens the dropdown as the story mounts. */
const openOnMount: Story['play'] = ({ canvasElement }) => {
  canvasElement.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.click()
}

const meta = {
  title: 'Panels/SubagentChip',
  component: SubagentChip,
  beforeEach: seedStore(),
  args: { sessionId: MOBILE.id, subagents: SUBAGENTS, compact: false, waiting: false },
  // The detail header's state row, 450px wide, with room under it for the list.
  render: (args) => (
    <div style={{ width: 450, height: 520 }}>
      <div className="flex items-center gap-2.5">
        <SubagentChip {...args} />
      </div>
    </div>
  ),
} satisfies Meta<typeof SubagentChip>
export default meta

type Story = StoryObj<typeof meta>

/** Running, done and failed counts: `2 running · 3 done · 1 failed`. */
export const Mixed: Story = {}

/** Every agent back: no moon body on the glyph. */
export const Ended: Story = { args: { subagents: ENDED_ONLY } }

/** The narrow column beside the ▣ chip: bare counts. */
export const Compact: Story = { args: { compact: true } }

/** The session waits on its agents: the noun alone. */
export const Waiting: Story = { args: { subagents: RUNNING_ONLY, waiting: true } }

/** The list: the running agents with a stop each, then the ended ones; the last has no transcript. */
export const Open: Story = { play: openOnMount }

/** A stop pressed on the first agent, waiting for the SDK. */
export const Stopping: Story = {
  beforeEach: seedStore({ stoppingTasks: { [`${MOBILE.id}:${SUBAGENTS[0].id}`]: true } }),
  play: openOnMount,
}

/** The first agent's panel is open in the side slot: its row is ticked. */
export const PanelOpen: Story = {
  beforeEach: seedStore({
    subagentPanel: { sessionId: MOBILE.id, subagent: SUBAGENTS[0], messages: [], droppedCount: 0, found: true },
  }),
  play: openOnMount,
}
