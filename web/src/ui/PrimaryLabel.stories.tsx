import type { Meta, StoryObj } from '@storybook/react-vite'
import { PrimaryLabel, QuietLabel } from './PrimaryLabel'

const meta = {
  title: 'UI/PrimaryLabel',
  component: PrimaryLabel,
} satisfies Meta<typeof PrimaryLabel>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** `QuietLabel` is the pill `PrimaryLabel` is drawn in, reused for any word that marks a row without colouring it. */
export const Quiet: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-4">
      <QuietLabel>PRIMARY</QuietLabel>
      <QuietLabel>THIS MAC ONLY</QuietLabel>
    </div>
  ),
}
