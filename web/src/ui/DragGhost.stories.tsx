import type { Meta, StoryObj } from '@storybook/react-vite'
import { Chip } from './Chip'
import { DragGhost } from './DragGhost'

const meta = {
  title: 'UI/DragGhost',
  component: DragGhost,
  parameters: { layout: 'fullscreen' },
  args: {
    ghost: { x: 80, y: 60, width: 320 },
    fullWidth: false,
    children: <Chip label="orbital" hue={210} lifted />,
  },
  render: (args) => (
    <div className="h-[240px]">
      <DragGhost {...args} />
    </div>
  ),
} satisfies Meta<typeof DragGhost>
export default meta

type Story = StoryObj<typeof meta>

/** A chip lifted under the pointer; it sizes itself. */
export const Playground: Story = {}

/** `fullWidth`: a card takes the dragged item's width. */
export const Card: Story = {
  args: {
    fullWidth: true,
    children: (
      <div className="flex-1 rounded-[10px] border border-line/20 bg-panel px-4 py-3 fs-13 text-ink-100 shadow-[0_18px_50px_color-mix(in_oklab,_var(--color-shadow)_55%,_transparent)]">
        Fix the relay handshake
      </div>
    ),
  },
}
