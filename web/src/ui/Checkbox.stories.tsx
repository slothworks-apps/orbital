import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState, type ComponentProps } from 'react'
import { fn } from 'storybook/test'
import { Checkbox, Toggle } from './Checkbox'

type CheckboxSize = NonNullable<ComponentProps<typeof Checkbox>['size']>
type ToggleVariant = NonNullable<ComponentProps<typeof Toggle>['variant']>

/** A checkbox that holds its own value, so the catalogue's boxes tick. */
function LiveCheckbox(props: ComponentProps<typeof Checkbox>) {
  const [checked, setChecked] = useState(props.checked)
  return (
    <Checkbox
      {...props}
      checked={checked}
      onChange={(next) => {
        setChecked(next)
        props.onChange(next)
      }}
    />
  )
}

/** A switch that holds its own value. */
function LiveToggle(props: ComponentProps<typeof Toggle>) {
  const [checked, setChecked] = useState(props.checked)
  return (
    <Toggle
      {...props}
      checked={checked}
      onChange={(next) => {
        setChecked(next)
        props.onChange(next)
      }}
    />
  )
}

const meta = {
  title: 'UI/Checkbox',
  component: Checkbox,
  args: { checked: true, label: 'Remember last model per project', size: 'default', disabled: false, onChange: fn() },
  render: (args) => <LiveCheckbox {...args} />,
} satisfies Meta<typeof Checkbox>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

const SIZES: CheckboxSize[] = ['default', 'row', 'touch']

const ROW_LABEL = (
  <span className="flex flex-col">
    <span>Also remove worktree</span>
    <span className="fs-11 text-ink-900/60">.claude/worktrees/fix-relay-reconnect</span>
  </span>
)

export const Sizes: Story = {
  render: (args) => (
    <div className="flex flex-col gap-6">
      {SIZES.map((size) => (
        <div key={size} className="flex flex-col items-start gap-1.5">
          <div className="flex gap-6">
            <LiveCheckbox {...args} size={size} checked label={size === 'default' ? args.label : ROW_LABEL} />
            <LiveCheckbox
              {...args}
              size={size}
              checked={false}
              label={size === 'default' ? args.label : ROW_LABEL}
            />
          </div>
          <span className="font-mono fs-10.5 text-ink-900/60">{size} · on, off</span>
        </div>
      ))}
    </div>
  ),
}

export const Disabled: Story = {
  render: (args) => (
    <div className="flex flex-col gap-3">
      {SIZES.map((size) => (
        <div key={size} className="flex flex-col items-start gap-1.5">
          <div className="flex gap-6">
            <Checkbox {...args} size={size} checked disabled label="Also remove worktree" />
            <Checkbox {...args} size={size} checked={false} disabled label="Also remove worktree" />
          </div>
          <span className="font-mono fs-10.5 text-ink-900/60">{size} · disabled</span>
        </div>
      ))}
    </div>
  ),
}

/** No visible label: an icon-only placement names itself through `aria-label`. */
export const Unlabelled: Story = {
  args: { label: undefined, 'aria-label': 'Select session' },
}

const TOGGLE_VARIANTS: ToggleVariant[] = ['default', 'leading']

/** `Toggle` shares `Checkbox`'s file: an on/off switch on the same native input. */
export const ToggleSwitch: Story = {
  render: (args) => (
    <div className="flex flex-col gap-6">
      {TOGGLE_VARIANTS.map((variant) => (
        <div key={variant} className="flex flex-col items-start gap-1.5">
          <div className="flex gap-8">
            <LiveToggle checked variant={variant} label="Work in a worktree" onChange={args.onChange} />
            <LiveToggle checked={false} variant={variant} label="Work in a worktree" onChange={args.onChange} />
          </div>
          <span className="font-mono fs-10.5 text-ink-900/60">{variant} · on, off</span>
        </div>
      ))}
      {TOGGLE_VARIANTS.map((variant) => (
        <div key={`${variant}-disabled`} className="flex flex-col items-start gap-1.5">
          <div className="flex gap-8">
            <Toggle checked disabled variant={variant} label="Open a pull request" onChange={args.onChange} />
            <Toggle checked={false} disabled variant={variant} label="Open a pull request" onChange={args.onChange} />
          </div>
          <span className="font-mono fs-10.5 text-ink-900/60">{variant} · disabled</span>
        </div>
      ))}
    </div>
  ),
}
