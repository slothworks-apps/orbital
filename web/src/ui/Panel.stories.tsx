import type { Meta, StoryObj } from '@storybook/react-vite'
import { Panel, type PanelProps } from './Panel'

const ROWS = [
  { name: 'Fix the relay handshake', project: 'orbital', state: 'working' },
  { name: 'Changelog for 0.46.0', project: 'orbital', state: 'needs input' },
  { name: 'Backup cron on the infra box', project: 'slothworks-infra', state: 'idle' },
  { name: 'Spike: Bun test runner', project: 'orbital', state: 'ended' },
]

/** A header and a few session rows: what a docked panel actually holds. */
function PanelContent() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-line/10 px-5 py-4">
        <span className="font-mono fs-10 tracking-[0.2em] text-ink-900/60">SESSIONS · 4</span>
        <span className="font-mono fs-10.5 text-ink-900/50">Opus</span>
      </div>
      <ul className="flex flex-col gap-0.5 p-2">
        {ROWS.map((row) => (
          <li key={row.name} className="flex flex-col gap-0.5 rounded-[8px] px-3 py-2.5 hover:bg-line/8">
            <span className="fs-13 font-semibold text-ink-100">{row.name}</span>
            <span className="font-mono fs-10.5 text-ink-900/55">
              {row.project} · {row.state}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const meta = {
  title: 'UI/Panel',
  component: Panel,
  args: { side: 'left', collapsed: false, widthTransition: true, fill: false },
  render: (args) => (
    <div className="flex h-[440px]">
      <Panel {...args} className="h-full">
        {args.collapsed ? null : <PanelContent />}
      </Panel>
    </div>
  ),
} satisfies Meta<typeof Panel>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

const SIDES: NonNullable<PanelProps['side']>[] = ['left', 'right', 'subagent', 'float']

export const Sides: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-start gap-6">
      {SIDES.map((side) => (
        <div key={side} className="flex flex-col gap-1.5">
          <div className={side === 'float' ? 'h-[360px] w-[420px]' : 'h-[360px]'}>
            <Panel {...args} side={side} className="h-full">
              <PanelContent />
            </Panel>
          </div>
          <span className="font-mono fs-10.5 text-ink-900/60">{side}</span>
        </div>
      ))}
    </div>
  ),
}

/** The narrow rail of a docked panel; what goes in it is the caller's. */
export const Collapsed: Story = {
  render: (args) => (
    <div className="flex items-start gap-6">
      {(['left', 'right', 'subagent'] as const).map((side) => (
        <div key={side} className="flex flex-col gap-1.5">
          <div className="h-[360px]">
            <Panel {...args} side={side} collapsed className="h-full" />
          </div>
          <span className="font-mono fs-10.5 text-ink-900/60">{side}</span>
        </div>
      ))}
    </div>
  ),
}

/** The tag-hue bloom around the detail panel when a session is open. */
export const GlowHue: Story = {
  args: { side: 'right', glowHue: 210 },
}

/** A width the drag handle drives, in place of the side's fixed width. */
export const LiveWidth: Story = {
  args: { side: 'right', widthPx: 360, widthTransition: false },
}

/** The panel is the window: a detached session, and the subagent panel beside it. */
export const Fill: Story = {
  render: (args) => (
    <div className="flex h-[440px] w-[820px]">
      <div className="flex-1">
        <Panel {...args} side="right" fill className="h-full">
          <PanelContent />
        </Panel>
      </div>
      <div className="w-[340px]">
        <Panel {...args} side="subagent" fill className="h-full">
          <PanelContent />
        </Panel>
      </div>
    </div>
  ),
}
