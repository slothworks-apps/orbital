import type { Meta, StoryObj } from '@storybook/react-vite'
import { GripDots } from './GripDots'

const meta = {
  title: 'UI/GripDots',
  component: GripDots,
} satisfies Meta<typeof GripDots>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {
  render: () => (
    <div className="flex items-center justify-center rounded-[6px] border border-line/16 bg-panel p-3">
      <GripDots />
    </div>
  ),
}
