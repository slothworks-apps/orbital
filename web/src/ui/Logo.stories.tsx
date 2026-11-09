import type { Meta, StoryObj } from '@storybook/react-vite'
import { Logo } from './Logo'

const meta = {
  title: 'UI/Logo',
  component: Logo,
  args: { dimmed: false },
} satisfies Meta<typeof Logo>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

export const Focus: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-8">
      <div className="flex flex-col items-center gap-1.5">
        <Logo dimmed={false} />
        <span className="font-mono fs-10.5 text-ink-900/60">focused</span>
      </div>
      <div className="flex flex-col items-center gap-1.5">
        <Logo dimmed />
        <span className="font-mono fs-10.5 text-ink-900/60">dimmed</span>
      </div>
    </div>
  ),
}
