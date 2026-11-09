import type { Meta, StoryObj } from '@storybook/react-vite'
import { FingerprintBoxes } from './FingerprintBoxes'

const meta = {
  title: 'UI/FingerprintBoxes',
  component: FingerprintBoxes,
  args: { value: 'K4PX9W', size: 'md' },
} satisfies Meta<typeof FingerprintBoxes>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

const SIZES = ['md', 'sm'] as const

export const Sizes: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-8">
      {SIZES.map((size) => (
        <div key={size} className="flex flex-col items-center gap-1.5">
          <FingerprintBoxes {...args} size={size} />
          <span className="font-mono fs-10.5 text-ink-900/60">{size}</span>
        </div>
      ))}
    </div>
  ),
}
