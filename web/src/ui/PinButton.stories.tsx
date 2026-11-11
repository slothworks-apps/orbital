import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { fn } from 'storybook/test'
import { PinButton, PinGlyph, type PinButtonProps, type PinSize } from './PinButton'

/** The pin holds its own state, so a press pins and unpins. */
function PinButtonDemo({ pinned: initial, onToggle, ...props }: PinButtonProps) {
  const [pinned, setPinned] = useState(initial)
  return (
    <PinButton
      {...props}
      pinned={pinned}
      onToggle={() => {
        setPinned((p) => !p)
        onToggle()
      }}
    />
  )
}

const meta = {
  title: 'UI/PinButton',
  component: PinButtonDemo,
  args: { pinned: false, size: 24, onToggle: fn() },
  argTypes: { size: { control: 'inline-radio', options: [24, 18] } },
  // The 18px button shows only while its row is hovered: the row is a `group/row`.
  render: (args) => (
    <div className="group/row inline-flex items-center gap-3 p-2">
      <span className="fs-12.5 text-ink-200/85">Fix relay reconnect</span>
      <PinButtonDemo {...args} />
    </div>
  ),
} satisfies Meta<typeof PinButtonDemo>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

const SIZES: PinSize[] = [24, 18]

/**
 * Both sizes, unpinned and pinned. An unpinned 18px button is invisible until
 * its row is hovered — hover the row to see it.
 */
export const Sizes: Story = {
  render: (args) => (
    <div className="flex flex-col items-start gap-4">
      {SIZES.map((size) =>
        [false, true].map((pinned) => (
          <div key={`${size}-${pinned}`} className="flex flex-col items-start gap-1.5">
            <div className="group/row inline-flex items-center gap-3">
              <span className="fs-12.5 text-ink-200/85">Fix relay reconnect</span>
              <PinButtonDemo {...args} size={size} pinned={pinned} />
            </div>
            <span className="font-mono fs-10.5 text-ink-900/60">
              {size} · {pinned ? 'pinned' : 'unpinned'}
            </span>
          </div>
        )),
      )}
    </div>
  ),
}

/** The bare glyph, at both sizes and in both states. */
export const Glyph: Story = {
  render: () => (
    <div className="flex gap-8 text-ink-400">
      {SIZES.map((size) =>
        [false, true].map((pinned) => (
          <div key={`${size}-${pinned}`} className="flex flex-col items-start gap-1.5">
            <PinGlyph size={size} pinned={pinned} />
            <span className="font-mono fs-10.5 text-ink-900/60">
              {size} · {pinned ? 'pinned' : 'unpinned'}
            </span>
          </div>
        )),
      )}
    </div>
  ),
}
