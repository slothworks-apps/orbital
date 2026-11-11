import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState, type ComponentProps } from 'react'
import { fn } from 'storybook/test'
import { Switch, SwitchButton, SwitchTrack } from './Switch'

/** A labelled switch that holds its own value, so the catalogue's switches move. */
function LiveSwitch(props: ComponentProps<typeof Switch>) {
  const [on, setOn] = useState(props.on)
  return (
    <Switch
      {...props}
      on={on}
      onChange={(next) => {
        setOn(next)
        props.onChange(next)
      }}
    />
  )
}

const meta = {
  title: 'UI/Switch',
  component: Switch,
  args: { on: true, label: 'Auto-continue', onChange: fn() },
  render: (args) => <LiveSwitch {...args} />,
} satisfies Meta<typeof Switch>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** The track alone, in both sizes: `sm` the harness's (30b), `md` Feeling lucky's (65a). */
export const Tracks: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      {(['sm', 'md'] as const).map((size) => (
        <div key={size} className="flex items-center gap-4">
          <SwitchTrack on size={size} />
          <SwitchTrack on={false} size={size} />
          <span className="font-mono fs-10.5 text-ink-900/60">{size} · on, off</span>
        </div>
      ))}
    </div>
  ),
}

/** The button alone, beside words its row lays out (67f's progress list). */
function ButtonRow({ label }: { label: string }) {
  const [on, setOn] = useState(false)
  return (
    <div className="flex items-start gap-3">
      <SwitchButton on={on} label={label} onChange={setOn} className="mt-0.5" />
      <div className="fs-13 font-semibold text-ink-100">{label}</div>
    </div>
  )
}

export const Button: Story = {
  args: { label: 'The agent keeps a progress list' },
  render: (args) => <ButtonRow label={args.label} />,
}
