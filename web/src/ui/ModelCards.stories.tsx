import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { fn } from 'storybook/test'
import type { OrbitalModel } from '../lib/types'
import { ModelCards, type ModelCardsProps } from './ModelCards'

const MODELS: OrbitalModel[] = [
  {
    value: 'opus',
    resolvedModel: 'claude-opus-4-6',
    family: 'Opus',
    version: '4.6',
    shortVersion: 'Opus 4.6',
    variant: null,
    blurb: 'The deepest reasoning, for long and tangled work',
    contextWindow: 1_000_000,
  },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-4-5',
    family: 'Sonnet',
    version: '4.5',
    shortVersion: 'Sonnet 4.5',
    variant: null,
    blurb: 'Balanced speed and depth for everyday coding',
    contextWindow: 200_000,
  },
  {
    value: 'haiku',
    resolvedModel: 'claude-haiku-4-5',
    family: 'Haiku',
    version: '4.5',
    shortVersion: 'Haiku 4.5',
    variant: null,
    blurb: 'The fastest, for quick edits and lookups',
    contextWindow: 200_000,
  },
  {
    value: 'opusplan',
    resolvedModel: 'claude-opus-4-6',
    family: 'Opus',
    version: '4.6',
    shortVersion: 'Opus Plan',
    variant: 'plan',
    blurb: 'Opus while planning, Sonnet while doing',
    contextWindow: null,
  },
]

/** The cards hold their own selection; picking Other makes it the active card. */
function ModelCardsDemo({ value: initial, onChange, other, ...props }: ModelCardsProps) {
  const [value, setValue] = useState(initial)
  const [otherActive, setOtherActive] = useState(other?.active ?? false)
  return (
    <ModelCards
      {...props}
      value={value}
      onChange={(next) => {
        setValue(next)
        setOtherActive(false)
        onChange(next)
      }}
      other={
        other && {
          active: otherActive,
          onSelect: () => {
            setOtherActive(true)
            other.onSelect()
          },
        }
      }
    />
  )
}

const meta = {
  title: 'UI/ModelCards',
  component: ModelCardsDemo,
  args: {
    models: MODELS,
    value: 'opus',
    defaultValue: 'sonnet',
    compact: false,
    dense: false,
    disabled: false,
    onChange: fn(),
  },
  render: (args) => (
    <div className="w-[680px]">
      <ModelCardsDemo {...args} />
    </div>
  ),
} satisfies Meta<typeof ModelCardsDemo>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** New session's full cards, Settings' `compact` ones, and New session's `dense` column — each with the Other card. */
export const Variants: Story = {
  render: (args) => (
    <div className="flex flex-col items-start gap-8">
      <div className="flex w-[680px] flex-col gap-1.5">
        <ModelCardsDemo {...args} other={{ active: false, onSelect: fn() }} />
        <span className="font-mono fs-10.5 text-ink-900/60">default</span>
      </div>
      <div className="flex w-[320px] flex-col gap-1.5">
        <ModelCardsDemo {...args} compact other={{ active: false, onSelect: fn() }} />
        <span className="font-mono fs-10.5 text-ink-900/60">compact</span>
      </div>
      <div className="flex w-[420px] flex-col gap-1.5">
        <ModelCardsDemo {...args} dense other={{ active: false, onSelect: fn() }} />
        <span className="font-mono fs-10.5 text-ink-900/60">dense</span>
      </div>
    </div>
  ),
}

export const States: Story = {
  render: (args) => (
    <div className="flex flex-col items-start gap-8">
      <div className="flex w-[680px] flex-col gap-1.5">
        <ModelCardsDemo {...args} value={null} />
        <span className="font-mono fs-10.5 text-ink-900/60">nothing chosen · default marked</span>
      </div>
      <div className="flex w-[680px] flex-col gap-1.5">
        <ModelCardsDemo {...args} other={{ active: true, onSelect: fn() }} />
        <span className="font-mono fs-10.5 text-ink-900/60">other active</span>
      </div>
      <div className="flex w-[680px] flex-col gap-1.5">
        <ModelCardsDemo {...args} disabled />
        <span className="font-mono fs-10.5 text-ink-900/60">disabled</span>
      </div>
      <div className="flex w-[680px] flex-col gap-1.5">
        <ModelCardsDemo {...args} models={[]} />
        <span className="font-mono fs-10.5 text-ink-900/60">no models from the SDK</span>
      </div>
    </div>
  ),
}
