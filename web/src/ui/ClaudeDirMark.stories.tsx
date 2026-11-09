import type { Meta, StoryObj } from '@storybook/react-vite'
import { ClaudeDirChip, ClaudeDirMark, type ClaudeDirMarkSize } from './ClaudeDirMark'

const meta = {
  title: 'UI/ClaudeDirMark',
  component: ClaudeDirMark,
  args: { mono: 'W', title: 'Profile: Work · ~/.claude-work · jan@acme.com', size: 'desktop' },
} satisfies Meta<typeof ClaudeDirMark>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

const SIZES: ClaudeDirMarkSize[] = ['desktop', 'phone', 'sheet']

export const Sizes: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-6">
      {SIZES.map((size) => (
        <div key={size} className="flex flex-col items-center gap-1.5">
          <ClaudeDirMark {...args} size={size} />
          <span className="font-mono fs-10.5 text-ink-900/60">{size}</span>
        </div>
      ))}
    </div>
  ),
}

export const Missing: Story = {
  args: { missing: true },
}

export const Chip: Story = {
  render: () => (
    <ClaudeDirChip mark={{ id: 1, mono: 'W', name: 'Work', title: 'Profile: Work · ~/.claude-work · jan@acme.com' }} />
  ),
}
