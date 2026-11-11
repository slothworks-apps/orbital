import type { Meta, StoryObj } from '@storybook/react-vite'
import { LOADING_SURFACE, MoonLoader } from './MoonLoader'

/** The box each size reserves while its bytes are on their way (10e2), big
 * enough to hold the size's orbit. */
const BOX = { viewer: 90, row: 48, thumb: 40 } as const

const meta = {
  title: 'UI/MoonLoader',
  component: MoonLoader,
  args: { size: 'thumb' },
} satisfies Meta<typeof MoonLoader>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {
  render: (args) => (
    <span className="relative inline-block" style={{ width: BOX[args.size], height: BOX[args.size], background: LOADING_SURFACE }}>
      <MoonLoader {...args} />
    </span>
  ),
}

const SIZES = ['viewer', 'row', 'thumb'] as const

export const Sizes: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-8">
      {SIZES.map((size) => (
        <div key={size} className="flex flex-col items-center gap-1.5">
          <span className="relative inline-block" style={{ width: BOX[size], height: BOX[size], background: LOADING_SURFACE }}>
            <MoonLoader {...args} size={size} />
          </span>
          <span className="font-mono fs-10.5 text-ink-900/60">{size}</span>
        </div>
      ))}
    </div>
  ),
}

export const Progress: Story = {
  args: { size: 'viewer', progress: 0.6 },
  render: (args) => (
    <span className="relative inline-block" style={{ width: BOX[args.size], height: BOX[args.size], background: LOADING_SURFACE }}>
      <MoonLoader {...args} />
    </span>
  ),
}

export const Stalled: Story = {
  args: { size: 'viewer', progress: 0.3, stalled: true },
  render: (args) => (
    <span className="relative inline-block" style={{ width: BOX[args.size], height: BOX[args.size], background: LOADING_SURFACE }}>
      <MoonLoader {...args} />
    </span>
  ),
}
