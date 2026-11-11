import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { SendFeedback } from './SendFeedback'

const meta = {
  title: 'Panels/SendFeedback',
  component: SendFeedback,
  args: { onPick: fn() },
  // The Settings sidebar foot: the menu opens upward from it.
  render: (args) => (
    <div className="flex h-[300px] w-[220px] flex-col justify-end">
      <SendFeedback {...args} />
    </div>
  ),
} satisfies Meta<typeof SendFeedback>
export default meta

type Story = StoryObj<typeof meta>

export const Closed: Story = {}

/** Opened: the two choices and the promise under them. */
export const Open: Story = {
  play: ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.click()
  },
}
