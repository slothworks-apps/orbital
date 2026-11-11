import type { Meta, StoryObj } from '@storybook/react-vite'
import { useLayoutEffect, useRef, useState, type ComponentProps } from 'react'
import { Chip } from './Chip'
import { DropBar } from './DropBar'

type Bar = ComponentProps<typeof DropBar>['bar']

/** Chips with the bar in the gap before the second one, measured once laid out. */
function ChipRow({ bar }: { bar: Bar }) {
  const second = useRef<HTMLSpanElement | null>(null)
  const [x, setX] = useState<number | null>(null)
  useLayoutEffect(() => {
    // The gap is `gap-2`; the bar stands in its middle.
    if (second.current) setX(second.current.offsetLeft - 4)
  }, [])
  return (
    <div className="relative flex w-[420px] gap-2">
      <Chip label="orbital" hue={210} />
      <span ref={second} className="flex">
        <Chip label="slothworks-infra" hue={30} />
      </span>
      <Chip label="beam" hue={140} />
      {x !== null && <DropBar bar={{ ...bar, x }} />}
    </div>
  )
}

const meta = {
  title: 'UI/DropBar',
  component: DropBar,
  args: { bar: { x: 0, y: 0, width: 0, height: 26 } },
  render: (args) => <ChipRow bar={args.bar} />,
} satisfies Meta<typeof DropBar>
export default meta

type Story = StoryObj<typeof meta>

/** `bar` is what `dropSlot` measures; here its `x` is measured from the chips and the rest comes from the controls. */
export const Playground: Story = {}

/** Upright between chips: a zero `width`. */
export const Upright: Story = {}

/** Flat between cards: a zero `height`, halfway into the 8px gap under the first card. */
export const Flat: Story = {
  args: { bar: { x: 0, y: 56, width: 320, height: 0 } },
  render: (args) => (
    <div className="relative flex w-[320px] flex-col gap-2">
      {['Fix the relay handshake', 'Changelog for 0.46.0', 'Backup cron on the infra box'].map((name) => (
        <div key={name} className="h-[52px] rounded-[10px] border border-line/14 px-4 py-3 fs-13 text-ink-100">
          {name}
        </div>
      ))}
      <DropBar {...args} />
    </div>
  ),
}
