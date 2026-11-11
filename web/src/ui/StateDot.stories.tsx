import type { Meta, StoryObj } from '@storybook/react-vite'
import { StateDot } from './StateDot'
import { stateColor, stateDot, type StateSurface } from '../lib/stateStyle'
import type { SessionStateKey } from '../lib/types'

const meta = {
  title: 'UI/StateDot',
  component: StateDot,
  args: {
    dot: { shape: 'solid', motion: 'breathe' },
    color: 'var(--state-input)',
    solidPx: 10,
    hollowPx: 14,
  },
} satisfies Meta<typeof StateDot>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** The seven states a session can be in (`sessionStateKey`), most specific first. */
const STATES: SessionStateKey[] = ['needs_input', 'waiting', 'interrupted', 'done', 'working', 'idle', 'ended']

/** Where a state's dot is drawn (`StateSurface`): the map pill in label mode, in dot mode, and the detail chip. */
const SURFACES: StateSurface[] = ['label', 'dot', 'chip']

export const States: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      {SURFACES.map((surface) => (
        <div key={surface}>
          <div className="mb-2 font-mono fs-10.5 tracking-[0.1em] text-ink-900/60">{surface}</div>
          <div className="flex flex-wrap items-center gap-6">
            {STATES.map((state) => (
              <div key={state} className="flex flex-col items-center gap-1.5">
                <span className="flex h-3.5 items-center justify-center">
                  <StateDot
                    dot={stateDot(state, surface)}
                    color={stateColor(state)}
                    solidPx={10}
                    hollowPx={14}
                  />
                </span>
                <span className="font-mono fs-10.5 text-ink-900/60">{state}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  ),
}

export const WithGlow: Story = {
  args: {
    dot: { shape: 'solid', motion: 'pulse' },
    color: 'var(--state-active)',
    glow: true,
  },
}
