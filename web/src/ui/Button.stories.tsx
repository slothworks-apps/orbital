import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button, type ButtonProps } from './Button'

const meta = {
  title: 'UI/Button',
  component: Button,
  args: { children: 'Launch session', variant: 'primary', size: 'md' },
} satisfies Meta<typeof Button>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** Where each variant comes from is in the comment above it in `Button.tsx`. */
const VARIANTS: NonNullable<ButtonProps['variant']>[] = [
  'primary',
  'primary-flat',
  'primary-plain',
  'primary-unready',
  'cta',
  'warning',
  'warning-outline',
  'danger',
  'danger-soft',
  'ghost',
  'accent-outline',
  'hairline',
  'outline',
  'ink',
  'lit',
  'quiet',
  'muted-chip',
  'pill',
  'pill-active',
  'pill-muted',
  'pill-quiet',
  'pill-danger',
  'strip',
  'toggle',
  'toggle-on',
  'choice',
  'choice-on',
  'dashed-link',
]

export const Variants: Story = {
  render: (args) => (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] items-center gap-4">
      {VARIANTS.map((variant) => (
        <div key={variant} className="flex flex-col items-start gap-1.5">
          <Button {...args} variant={variant}>
            {args.children}
          </Button>
          <span className="font-mono fs-10.5 text-ink-900/60">{variant}</span>
        </div>
      ))}
    </div>
  ),
}

const SIZES: NonNullable<ButtonProps['size']>[] = [
  'sm',
  'md',
  'lg',
  'field',
  'row',
  'check',
  'chooser',
  'command',
  'notice',
  'notice-link',
  'notice-dialog',
  'member',
  'member-quiet',
  'member-line',
  'beside-field',
  'over-code',
  'login-row',
  'login-card',
  'labs',
  'labs-row',
  'wide',
  'choice',
  'choice-touch',
  'touch',
  'pill',
  'strip',
  'row-action',
  'link-mono',
  'grant-summary',
  'inline',
]

export const Sizes: Story = {
  args: { variant: 'ghost' },
  render: (args) => (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] items-center gap-4">
      {SIZES.map((size) => (
        <div key={size} className="flex flex-col items-start gap-1.5">
          <Button {...args} size={size}>
            {args.children}
          </Button>
          <span className="font-mono fs-10.5 text-ink-900/60">{size}</span>
        </div>
      ))}
      <div className="flex flex-col items-start gap-1.5">
        <Button {...args} size="icon" aria-label="Rewind">
          ↶
        </Button>
        <span className="font-mono fs-10.5 text-ink-900/60">icon</span>
      </div>
    </div>
  ),
}

export const Disabled: Story = {
  render: (args) => (
    <div className="flex flex-wrap gap-3">
      <Button {...args} disabled />
      <Button {...args} variant="ghost" disabled />
      <Button {...args} variant="muted-chip" disabled>
        Cancel
      </Button>
    </div>
  ),
}
