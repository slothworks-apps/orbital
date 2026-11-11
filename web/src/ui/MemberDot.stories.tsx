import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemberDot, type MemberDotState } from './MemberDot'

const meta = {
  title: 'UI/MemberDot',
  component: MemberDot,
  args: { state: 'online', sizePx: 8 },
} satisfies Meta<typeof MemberDot>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

const STATES: MemberDotState[] = ['online', 'offline', 'linking', 'notLinked', 'update']

export const States: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-6">
      {STATES.map((state) => (
        <div key={state} className="flex flex-col items-center gap-1.5">
          <MemberDot {...args} state={state} />
          <span className="font-mono fs-10.5 text-ink-900/60">{state}</span>
        </div>
      ))}
    </div>
  ),
}
