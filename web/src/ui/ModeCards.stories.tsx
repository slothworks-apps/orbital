import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { fn } from 'storybook/test'
import { ModeCards, type ModeCardsProps } from './ModeCards'

/** The cards hold their own mode, so a click moves the selection. */
function ModeCardsDemo({ value: initial, onChange, ...props }: ModeCardsProps) {
  const [value, setValue] = useState(initial)
  return (
    <ModeCards
      {...props}
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange(next)
      }}
    />
  )
}

const meta = {
  title: 'UI/ModeCards',
  component: ModeCardsDemo,
  args: { value: 'acceptEdits', compact: false, touch: false, disabled: false, onChange: fn() },
  render: (args) => (
    <div className="w-[480px]">
      <ModeCardsDemo {...args} />
    </div>
  ),
} satisfies Meta<typeof ModeCardsDemo>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** New session's full cards, Settings' `compact` ones in a 320px column, and the phone's `touch` ones. */
export const Variants: Story = {
  render: (args) => (
    <div className="flex flex-col items-start gap-8">
      <div className="flex w-[480px] flex-col gap-1.5">
        <ModeCardsDemo {...args} />
        <span className="font-mono fs-10.5 text-ink-900/60">default</span>
      </div>
      <div className="flex w-[320px] flex-col gap-1.5">
        <ModeCardsDemo {...args} compact />
        <span className="font-mono fs-10.5 text-ink-900/60">compact</span>
      </div>
      <div className="flex w-[360px] flex-col gap-1.5">
        <ModeCardsDemo {...args} touch />
        <span className="font-mono fs-10.5 text-ink-900/60">touch</span>
      </div>
    </div>
  ),
}

export const Disabled: Story = {
  args: { disabled: true },
}
