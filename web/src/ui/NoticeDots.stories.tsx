import type { Meta, StoryObj } from '@storybook/react-vite'
import { NoticeDots } from './NoticeDots'

const meta = {
  title: 'UI/NoticeDots',
  component: NoticeDots,
  args: { count: 3, size: 'map' },
} satisfies Meta<typeof NoticeDots>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** `NOTICE_DOTS_MAX` is 5: a count under it shows one dot per message, at 6 one `+N` starts. */
const COUNTS = [0, 1, 2, 3, 5, 7]

export const Counts: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-6">
      {COUNTS.map((count) => (
        <div key={count} className="flex flex-col items-center gap-1.5">
          <NoticeDots {...args} count={count} />
          <span className="font-mono fs-10.5 text-ink-900/60">{count}</span>
        </div>
      ))}
    </div>
  ),
}

export const Sizes: Story = {
  args: { count: 4 },
  render: (args) => (
    <div className="flex flex-wrap items-center gap-6">
      {(['map', 'touch'] as const).map((size) => (
        <div key={size} className="flex flex-col items-center gap-1.5">
          <NoticeDots {...args} size={size} />
          <span className="font-mono fs-10.5 text-ink-900/60">{size}</span>
        </div>
      ))}
    </div>
  ),
}

export const Covered: Story = {
  args: { count: 4, covered: true },
}
