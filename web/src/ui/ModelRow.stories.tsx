import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, useRef, useState } from 'react'
import type { OrbitalModel } from '../lib/types'
import { ModelRow, type ModelRowProps } from './ModelRow'

const row = (value: string, shortVersion: string, contextWindow: number): OrbitalModel => ({
  value,
  resolvedModel: `claude-${value}`,
  family: shortVersion.split(' ')[0],
  version: shortVersion,
  shortVersion,
  variant: null,
  blurb: '',
  contextWindow,
})

/** canvas 72b's catalog, in its own order. */
const MODELS: OrbitalModel[] = [
  row('opus-5-5', 'Opus 5.5', 1_000_000),
  row('opus-5', 'Opus 5', 200_000),
  row('opus-4-8', 'Opus 4.8', 200_000),
  row('fable-5-2', 'Fable 5.2', 1_000_000),
  row('fable-5-1', 'Fable 5.1', 1_000_000),
  row('sonnet-5-5', 'Sonnet 5.5', 1_000_000),
  row('sonnet-5', 'Sonnet 5', 200_000),
  row('sonnet-4-6', 'Sonnet 4.6', 200_000),
  row('haiku-5-5', 'Haiku 5.5', 200_000),
  row('haiku-4-5', 'Haiku 4.5', 200_000),
]
const RECENT = ['opus-5-5', 'sonnet-5-5', 'fable-5-2', 'haiku-5-5', 'opus-4-8']

interface DemoProps extends Omit<ModelRowProps, 'onChange' | 'onCustom'> {
  /** The column's width: it decides how many cards the row holds (72c). */
  width?: number
  /** Opens Other's list on mount, so the catalogue shows it. */
  openOnMount?: boolean
}

/**
 * A row that holds its own selection. The catalogue has no server, so a
 * typed custom ID ends in the field's error line rather than in the card.
 */
function ModelRowDemo({ width = 418, openOnMount = false, value: initial, ...props }: DemoProps) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (openOnMount) ref.current?.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')?.click()
  }, [openOnMount])
  return (
    <div ref={ref} style={{ width }} className={openOnMount ? 'min-h-[460px]' : undefined}>
      <ModelRow {...props} value={value} onChange={setValue} onCustom={setValue} />
    </div>
  )
}

const meta = {
  title: 'UI/ModelRow',
  component: ModelRowDemo,
  args: {
    models: MODELS,
    recent: RECENT,
    preselected: 'sonnet-5-5',
    defaultValue: 'sonnet-5-5',
    value: 'sonnet-5-5',
  },
} satisfies Meta<typeof ModelRowDemo>
export default meta

type Story = StoryObj<typeof meta>

/** 72b RESTING: three recent models, newest first, then Other. */
export const History: Story = {}

/** 72b NEW INSTALL: the default first, then the catalog's order. */
export const NoHistory: Story = { args: { recent: [] } }

/** 72b OTHER · A CATALOG MODEL PICKED: a model with no card shows in Other, selected. */
export const OtherHoldsACatalogModel: Story = { args: { value: 'haiku-4-5' } }

/** 72b OTHER · CUSTOM ID: the id in the Other card, cut with an ellipsis. */
export const OtherHoldsACustomId: Story = { args: { value: 'claude-opus-4-8-20260211' } }

/** 72b OTHER · OPEN: the whole catalog, Custom ID… pinned last. */
export const ListOpen: Story = { args: { openOnMount: true } }

/** 72b LAST MODEL HERE IS OLDER: the preselected model takes the last recent card. */
export const PreselectedIsOlder: Story = { args: { preselected: 'opus-4-8', value: 'opus-4-8' } }

/** 72c: a 300 px column holds two cards, 518 px five. */
export const Widths: Story = {
  render: (args) => (
    <div className="flex flex-col gap-6">
      {[518, 418, 300].map((width) => (
        <div key={width} className="flex flex-col gap-1.5">
          <ModelRowDemo {...args} width={width} />
          <span className="font-mono fs-10.5 text-ink-900/60">{width} px</span>
        </div>
      ))}
    </div>
  ),
}

/** Narrow: one recent model and Other. */
export const Narrow: Story = { args: { width: 300 } }
