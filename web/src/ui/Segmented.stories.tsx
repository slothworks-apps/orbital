import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { fn } from 'storybook/test'
import { Segmented, type SegmentedOption, type SegmentedProps, type SegmentedSize } from './Segmented'

/** A segmented control that holds its own value, so the segments press. */
function SegmentedDemo({ value: initial, onChange, ...props }: SegmentedProps<string>) {
  const [value, setValue] = useState(initial)
  return (
    <Segmented
      {...props}
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange(next)
      }}
    />
  )
}

const WINDOWS: SegmentedOption<string>[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'all', label: 'all' },
]

const TABS: SegmentedOption<string>[] = [
  { value: 'calls', label: 'calls' },
  { value: 'time', label: 'time' },
  { value: 'errors', label: 'errors' },
]

const DIRS: SegmentedOption<string>[] = [
  { value: '0', label: '~/.claude' },
  { value: '1', label: '~/.claude-work' },
  { value: '2', label: '~/.claude-client', disabled: true, title: 'Not found on disk' },
]

const STEPS: SegmentedOption<string>[] = [
  { value: 'sm', label: 'Small', percent: '90%' },
  { value: 'md', label: 'Default', percent: '100%' },
  { value: 'lg', label: 'Large', percent: '112%' },
  { value: 'xl', label: 'Larger', percent: '125%' },
].map(({ value, label, percent }) => ({
  value,
  label: (
    <>
      <span className="fs-11.5">{label}</span>
      <span className="fs-10 opacity-70">{percent}</span>
    </>
  ),
  ariaLabel: `${label}, ${percent}`,
}))

/** Each size with options shaped like the place it is used. */
const SIZES: Record<SegmentedSize, Pick<SegmentedProps<string>, 'options' | 'value' | 'label' | 'className'>> = {
  tab: { options: TABS, value: 'calls', label: 'Leaderboard' },
  filter: { options: WINDOWS, value: '7d', label: 'Window' },
  row: { options: WINDOWS, value: '24h', label: 'Keep history' },
  field: { options: DIRS, value: '0', label: 'Claude directory', className: 'w-[360px]' },
  steps: { options: STEPS, value: 'md', label: 'Text size', className: 'w-[320px]' },
}

const SIZE_NAMES = Object.keys(SIZES) as SegmentedSize[]

const meta = {
  title: 'UI/Segmented',
  component: SegmentedDemo,
  args: { label: 'Window', options: WINDOWS, value: '7d', size: 'row', onChange: fn() },
  argTypes: { size: { control: 'select', options: SIZE_NAMES } },
} satisfies Meta<typeof SegmentedDemo>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

export const Sizes: Story = {
  render: (args) => (
    <div className="flex flex-col items-start gap-6">
      {SIZE_NAMES.map((size) => (
        <div key={size} className="flex flex-col items-start gap-1.5">
          <SegmentedDemo {...args} {...SIZES[size]} size={size} />
          <span className="font-mono fs-10.5 text-ink-900/60">{size}</span>
        </div>
      ))}
    </div>
  ),
}

/** Single-character labels, held to an even width by `minItemWidth`. */
export const MinItemWidth: Story = {
  render: (args) => (
    <div className="flex flex-col items-start gap-6">
      <div className="flex flex-col items-start gap-1.5">
        <SegmentedDemo
          {...args}
          label="Moons shown"
          options={['1', '2', '3', '4', '∞'].map((value) => ({ value, label: value }))}
          value="3"
        />
        <span className="font-mono fs-10.5 text-ink-900/60">ragged</span>
      </div>
      <div className="flex flex-col items-start gap-1.5">
        <SegmentedDemo
          {...args}
          label="Moons shown"
          options={['1', '2', '3', '4', '∞'].map((value) => ({ value, label: value }))}
          value="3"
          minItemWidth={32}
        />
        <span className="font-mono fs-10.5 text-ink-900/60">minItemWidth 32</span>
      </div>
    </div>
  ),
}

/** A disabled segment is shown at half strength and cannot be pressed. */
export const DisabledSegment: Story = {
  args: { ...SIZES.field, size: 'field' },
}
