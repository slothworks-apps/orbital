import type { Meta, StoryObj } from '@storybook/react-vite'
import { StatusDot } from './StatusDot'
import type { SessionStatus } from '../lib/types'

const meta = {
  title: 'UI/StatusDot',
  component: StatusDot,
  args: { status: 'working' },
} satisfies Meta<typeof StatusDot>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

const STATUSES: SessionStatus[] = ['working', 'needs_input', 'idle', 'ended']

export const States: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-6">
      {STATUSES.map((status) => (
        <div key={status} className="flex flex-col items-center gap-1.5">
          <StatusDot {...args} status={status} />
          <span className="font-mono fs-10.5 text-ink-900/60">{status}</span>
        </div>
      ))}
    </div>
  ),
}

export const WithHue: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-6">
      {STATUSES.map((status) => (
        <div key={status} className="flex flex-col items-center gap-1.5">
          <StatusDot {...args} status={status} hue={205} />
          <span className="font-mono fs-10.5 text-ink-900/60">{status} · hue 205</span>
        </div>
      ))}
    </div>
  ),
}
