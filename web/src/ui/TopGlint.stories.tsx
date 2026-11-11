import type { Meta, StoryObj } from '@storybook/react-vite'
import { GLINT_ACCENT_HUE, TopGlint } from './TopGlint'

const meta = {
  title: 'UI/TopGlint',
  component: TopGlint,
  args: { hue: GLINT_ACCENT_HUE, focused: true },
} satisfies Meta<typeof TopGlint>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {
  render: (args) => (
    <div className="relative h-16 w-64 border border-line/16 bg-panel">
      <TopGlint {...args} />
    </div>
  ),
}

export const Focus: Story = {
  render: (args) => (
    <div className="flex flex-col gap-4">
      <div className="relative h-16 w-64 border border-line/16 bg-panel">
        <TopGlint {...args} focused />
      </div>
      <div className="relative h-16 w-64 border border-line/16 bg-panel">
        <TopGlint {...args} focused={false} />
      </div>
    </div>
  ),
}

export const TagHue: Story = {
  render: (args) => (
    <div className="flex flex-col gap-4">
      {[0, 120, 205, 300].map((hue) => (
        <div key={hue} className="relative h-16 w-64 border border-line/16 bg-panel">
          <TopGlint {...args} hue={hue} />
        </div>
      ))}
    </div>
  ),
}
