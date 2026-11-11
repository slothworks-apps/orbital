import type { Meta, StoryObj } from '@storybook/react-vite'
import { LimitsGlyph } from './LimitsGlyph'

const meta = {
  title: 'UI/LimitsGlyph',
  component: LimitsGlyph,
  args: { size: 'rail' },
} satisfies Meta<typeof LimitsGlyph>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {
  render: (args) => (
    <span className="text-ink-100">
      <LimitsGlyph {...args} />
    </span>
  ),
}

const SIZES = ['footer', 'rail', 'phone'] as const

export const Sizes: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-6 text-ink-100">
      {SIZES.map((size) => (
        <div key={size} className="flex flex-col items-center gap-1.5">
          <LimitsGlyph {...args} size={size} />
          <span className="font-mono fs-10.5 text-ink-900/60">{size}</span>
        </div>
      ))}
    </div>
  ),
}
