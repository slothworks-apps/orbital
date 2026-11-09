import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { fn } from 'storybook/test'
import { Chip, type ChipProps } from './Chip'
import { Input } from './Input'
import { KindGlyph } from './KindGlyph'

/** A chip that toggles itself on click, the way the tag filter's chips do. */
function ChipDemo({ active: initial = false, onClick, ...props }: ChipProps) {
  const [active, setActive] = useState(initial)
  return (
    <Chip
      {...props}
      active={active}
      onClick={(e) => {
        setActive((a) => !a)
        onClick?.(e)
      }}
    />
  )
}

const meta = {
  title: 'UI/Chip',
  component: ChipDemo,
  args: { label: 'relay', hue: 205, active: false, size: 'row', activeTint: 'hue', onClick: fn() },
  argTypes: {
    size: { control: 'inline-radio', options: ['row', 'field'] },
    activeTint: { control: 'inline-radio', options: ['hue', 'neutral'] },
  },
} satisfies Meta<typeof ChipDemo>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

const SIZES: NonNullable<ChipProps['size']>[] = ['row', 'field']

export const Sizes: Story = {
  render: (args) => (
    <div className="flex flex-col items-start gap-4">
      {SIZES.map((size) => (
        <div key={size} className="flex flex-col items-start gap-1.5">
          <div className="flex gap-2">
            <ChipDemo {...args} size={size} />
            <ChipDemo {...args} size={size} active />
          </div>
          <span className="font-mono fs-10.5 text-ink-900/60">{size} · resting, active</span>
        </div>
      ))}
    </div>
  ),
}

const noop = () => {}

/** Every look the props allow, each named under it. */
const STATES: { name: string; props: ChipProps }[] = [
  { name: 'tag · resting', props: { label: 'relay', hue: 205 } },
  { name: 'tag · active · hue', props: { label: 'relay', hue: 205, active: true } },
  { name: 'tag · active · neutral', props: { label: 'relay', hue: 205, active: true, activeTint: 'neutral' } },
  { name: 'no hue · resting', props: { label: 'all projects' } },
  { name: 'no hue · active', props: { label: 'all projects', active: true } },
  { name: 'dot', props: { label: 'Explore', dot: true } },
  { name: 'dot · pulse', props: { label: 'Explore · working', dot: true, pulse: true } },
  { name: 'glyph', props: { label: 'MacBook Pro', glyph: <KindGlyph kind="desktop" untitled />, onClick: noop } },
  {
    name: 'glyph · active',
    props: { label: 'build-box', glyph: <KindGlyph kind="headless" untitled />, active: true, onClick: noop },
  },
  {
    name: 'glyph · note',
    props: { label: 'Pixel 9', glyph: <KindGlyph kind="phone" untitled />, note: 'update', onClick: noop },
  },
  {
    name: 'dimmed',
    props: { label: 'Mac Studio', glyph: <KindGlyph kind="desktop" untitled />, dimmed: true, onClick: noop },
  },
  { name: 'muted', props: { label: 'Clear', muted: true, onClick: noop } },
  { name: 'muted · + New tag', props: { label: '+ New tag', muted: true, size: 'field', onClick: noop } },
  { name: 'lifted', props: { label: 'mobile', hue: 150, lifted: true } },
  { name: 'removable', props: { label: 'design', hue: 300, onRemove: noop } },
  {
    name: 'input',
    props: {
      label: 'New tag',
      size: 'field',
      active: true,
      input: <Input variant="chip" placeholder="tag name" defaultValue="perf" className="w-[60px]" />,
    },
  },
]

export const States: Story = {
  render: () => (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] items-start gap-4">
      {STATES.map(({ name, props }) => (
        <div key={name} className="flex flex-col items-start gap-1.5">
          <Chip {...props} />
          <span className="font-mono fs-10.5 text-ink-900/60">{name}</span>
        </div>
      ))}
    </div>
  ),
}

/** Tag hues around the wheel, resting and active. */
export const Hues: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      {[false, true].map((active) => (
        <div key={String(active)} className="flex flex-wrap gap-2">
          {[
            ['relay', 205],
            ['mobile', 150],
            ['release', 60],
            ['bug', 25],
            ['design', 300],
            ['infra', 260],
          ].map(([label, hue]) => (
            <Chip key={label} label={String(label)} hue={Number(hue)} active={active} />
          ))}
        </div>
      ))}
    </div>
  ),
}
