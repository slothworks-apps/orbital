import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { fn } from 'storybook/test'
import { PairingCodeInput, type PairingCodeInputProps } from './PairingCodeInput'

/** The field holds its own code, so typing and pasting fill the boxes. */
function PairingCodeDemo({ value: initial, onChange, ...props }: PairingCodeInputProps) {
  const [value, setValue] = useState(initial)
  return (
    <PairingCodeInput
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
  title: 'UI/PairingCodeInput',
  component: PairingCodeDemo,
  args: { value: 'K7Q', size: 'md', disabled: false, onChange: fn(), onSubmit: fn() },
  argTypes: { size: { control: 'inline-radio', options: ['md', 'sm'] } },
} satisfies Meta<typeof PairingCodeDemo>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

const SIZES: NonNullable<PairingCodeInputProps['size']>[] = ['md', 'sm']

export const Sizes: Story = {
  render: (args) => (
    <div className="flex flex-col items-start gap-6">
      {SIZES.map((size) => (
        <div key={size} className="flex flex-col items-start gap-1.5">
          <PairingCodeDemo {...args} size={size} />
          <span className="font-mono fs-10.5 text-ink-900/60">{size}</span>
        </div>
      ))}
    </div>
  ),
}

/** Each box is filled, next (the accent edge) or empty, by how much has been typed. */
export const Progress: Story = {
  render: (args) => (
    <div className="flex flex-col items-start gap-6">
      {['', 'K7', 'K7Q4', 'K7Q4MX'].map((value) => (
        <div key={value} className="flex flex-col items-start gap-1.5">
          <PairingCodeDemo {...args} value={value} />
          <span className="font-mono fs-10.5 text-ink-900/60">{value.length} of 6</span>
        </div>
      ))}
    </div>
  ),
}

export const Disabled: Story = {
  args: { value: 'K7Q4MX', disabled: true },
}
