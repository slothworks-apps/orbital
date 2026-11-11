import type { Meta, StoryObj } from '@storybook/react-vite'
import { KindGlyph } from './KindGlyph'

const meta = {
  title: 'UI/KindGlyph',
  component: KindGlyph,
  args: { kind: 'desktop', scale: 3 },
} satisfies Meta<typeof KindGlyph>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {
  render: (args) => (
    <span className="text-ink-100">
      <KindGlyph {...args} />
    </span>
  ),
}

/** `headless` and `phone` are told by name; anything else reads as `desktop`. */
const KINDS = ['desktop', 'headless', 'phone', 'unknown']

export const Kinds: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-6 text-ink-100">
      {KINDS.map((kind) => (
        <div key={kind} className="flex flex-col items-center gap-1.5">
          <KindGlyph {...args} kind={kind} />
          <span className="font-mono fs-10.5 text-ink-900/60">{kind}</span>
        </div>
      ))}
    </div>
  ),
}

const SCALES = [1, 2, 2.6, 3] as const

export const Scales: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-8 text-ink-100">
      {SCALES.map((scale) => (
        <div key={scale} className="flex flex-col items-center gap-1.5">
          <KindGlyph {...args} scale={scale} />
          <span className="font-mono fs-10.5 text-ink-900/60">scale {scale}</span>
        </div>
      ))}
    </div>
  ),
}
