import type { Meta, StoryObj } from '@storybook/react-vite'
import type { SessionStateKey } from '../lib/types'
import type { SubagentTaskState } from '../lib/subagentPanel'
import { Badge, type BadgeProps } from './Badge'

const meta = {
  title: 'UI/Badge',
  component: Badge,
  args: { variant: 'status', state: 'working' },
} satisfies Meta<typeof Badge>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** One labelled cell per badge. */
function Gallery({ items }: { items: { name: string; props: BadgeProps }[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] items-start gap-4">
      {items.map(({ name, props }) => (
        <div key={name} className="flex flex-col items-start gap-1.5">
          <Badge {...props} />
          <span className="font-mono fs-10.5 text-ink-900/60">{name}</span>
        </div>
      ))}
    </div>
  )
}

const STATES: SessionStateKey[] = ['needs_input', 'waiting', 'interrupted', 'done', 'working', 'idle', 'ended']

/** `variant="status"`: every session state, then the modifiers that change its words or its dot. */
export const Status: Story = {
  render: () => (
    <Gallery
      items={[
        ...STATES.map((state) => ({ name: state, props: { variant: 'status', state } as const })),
        { name: 'waiting · awaiting 3', props: { variant: 'status', state: 'waiting', awaiting: 3 } },
        { name: 'needs_input · gate', props: { variant: 'status', state: 'needs_input', gate: true } },
        {
          name: 'needs_input · waitsFor',
          props: { variant: 'status', state: 'needs_input', waitsFor: 'LOG IN TO WORK PROFILE' },
        },
        { name: 'working · asOf', props: { variant: 'status', state: 'working', asOf: 'AS OF 12 MIN AGO' } },
        { name: 'needs_input · asOf', props: { variant: 'status', state: 'needs_input', asOf: 'AS OF 3 MIN AGO' } },
      ]}
    />
  ),
}

/** The detail header's chips that are not session states. */
export const HeaderStates: Story = {
  render: () => (
    <Gallery
      items={[
        { name: 'compacting', props: { variant: 'compacting', elapsed: '0:14' } },
        { name: 'rewind', props: { variant: 'rewind' } },
        { name: 'limit · waiting', props: { variant: 'limit', label: 'WAITING FOR LIMIT · 15:00' } },
        { name: 'limit · resets', props: { variant: 'limit', label: 'LIMIT · RESETS 15:00' } },
      ]}
    />
  ),
}

export const CountAndModel: Story = {
  render: () => (
    <Gallery
      items={[
        { name: 'count', props: { variant: 'count', value: 4 } },
        { name: 'count · label', props: { variant: 'count', value: 12, label: 'sessions' } },
        { name: 'model', props: { variant: 'model', value: 'Opus 4.6' } },
        { name: 'model · interactive', props: { variant: 'model', value: 'Opus 4.6', interactive: true } },
      ]}
    />
  ),
}

const TASK_STATES: SubagentTaskState[] = ['running', 'completed', 'failed', 'stopped', 'stream_lost']

/** `variant="task"`: a subagent's states; `hue` tints RUNNING only, `truncated` adds a chip to any. */
export const Task: Story = {
  render: () => (
    <Gallery
      items={[
        ...TASK_STATES.map((value) => ({ name: value, props: { variant: 'task', value } as const })),
        { name: 'running · hue 150', props: { variant: 'task', value: 'running', hue: 150 } },
        { name: 'running · hue 300', props: { variant: 'task', value: 'running', hue: 300 } },
        ...TASK_STATES.map((value) => ({
          name: `${value} · truncated`,
          props: { variant: 'task', value, truncated: true } as const,
        })),
      ]}
    />
  ),
}
