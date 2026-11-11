import type { Meta, StoryObj } from '@storybook/react-vite'
import { Marked } from './Marked'

const meta = {
  title: 'UI/Marked',
  component: Marked,
  args: { text: 'orbital', marks: [[0, 3]], bright: false },
  render: (args) => (
    <span className="font-mono fs-12.5 text-ink-100">
      <Marked {...args} />
    </span>
  ),
} satisfies Meta<typeof Marked>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** A directory suggestion: the name at full ink over the dimmer path, `bright` lifting the path's matches. */
export const SuggestionRow: Story = {
  render: () => (
    <div className="flex w-[360px] flex-col gap-0.5 rounded-[8px] px-3 py-2">
      <span className="fs-13 font-semibold text-ink-100">
        <Marked text="slothworks-infra" marks={[[0, 4], [11, 16]]} />
      </span>
      <span className="font-mono fs-11 text-ink-900/55">
        <Marked text="~/Projects/slothworks/infra" marks={[[11, 15], [22, 27]]} bright />
      </span>
    </div>
  ),
}

/** No marks: the text as it is. */
export const NoMatch: Story = { args: { marks: [] } }
