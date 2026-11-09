import type { Meta, StoryObj } from '@storybook/react-vite'
import { ModeDot, ModeReadout } from './ModeDot'
import type { PermissionMode } from '../lib/types'

const meta = {
  title: 'UI/ModeDot',
  component: ModeDot,
  args: { mode: 'auto', size: 8 },
} satisfies Meta<typeof ModeDot>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** Ordered by escalating autonomy, as `lib/permissionModes.ts` lists them. */
const MODES: PermissionMode[] = ['plan', 'acceptEdits', 'auto', 'bypassPermissions']

export const Modes: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-6">
      {MODES.map((mode) => (
        <div key={mode} className="flex flex-col items-center gap-1.5">
          <ModeDot {...args} mode={mode} />
          <span className="font-mono fs-10.5 text-ink-900/60">{mode}</span>
        </div>
      ))}
    </div>
  ),
}

export const Readout: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-6">
      {MODES.map((mode) => (
        <div key={mode} className="flex flex-col items-center gap-1.5">
          <ModeReadout mode={mode} />
          <span className="font-mono fs-10.5 text-ink-900/60">{mode}</span>
        </div>
      ))}
    </div>
  ),
}
