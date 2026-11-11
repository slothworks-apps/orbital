import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { Input, TextArea, type FieldSize, type InputProps, type InputSeam, type TextAreaProps } from './Input'

/** A field that holds its own text, so the catalogue's fields can be typed in. */
function LiveInput(props: InputProps) {
  const [value, setValue] = useState(String(props.value ?? ''))
  return <Input {...props} value={value} onChange={(e) => setValue(e.target.value)} />
}

function LiveTextArea(props: TextAreaProps) {
  const [value, setValue] = useState(String(props.value ?? ''))
  return <TextArea {...props} value={value} onChange={(e) => setValue(e.target.value)} />
}

const meta = {
  title: 'UI/Input',
  component: Input,
  args: {
    value: 'Fix relay reconnect',
    placeholder: 'Session name',
    variant: 'field',
    size: 'md',
    font: 'sans',
    invalid: false,
    disabled: false,
  },
  render: (args) => (
    <div className="w-[320px]">
      <LiveInput {...args} />
    </div>
  ),
} satisfies Meta<typeof Input>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

const VARIANTS: NonNullable<InputProps['variant']>[] = ['field', 'inline', 'bare', 'chip', 'combobox']

export const Variants: Story = {
  render: (args) => (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] items-start gap-6">
      {VARIANTS.map((variant) => (
        <div key={variant} className="flex flex-col items-start gap-1.5">
          <LiveInput {...args} variant={variant} value={variant === 'combobox' ? '~/Projects/orbital' : args.value} />
          <span className="font-mono fs-10.5 text-ink-900/60">{variant}</span>
        </div>
      ))}
    </div>
  ),
}

const SIZES: FieldSize[] = ['sm', 'md', 'lg']

export const Sizes: Story = {
  render: (args) => (
    <div className="flex w-[320px] flex-col gap-4">
      {SIZES.map((size) => (
        <div key={size} className="flex flex-col items-start gap-1.5">
          <LiveInput {...args} size={size} />
          <span className="font-mono fs-10.5 text-ink-900/60">{size}</span>
        </div>
      ))}
    </div>
  ),
}

export const Fonts: Story = {
  render: (args) => (
    <div className="flex w-[320px] flex-col gap-4">
      <div className="flex flex-col items-start gap-1.5">
        <LiveInput {...args} font="sans" />
        <span className="font-mono fs-10.5 text-ink-900/60">sans</span>
      </div>
      <div className="flex flex-col items-start gap-1.5">
        <LiveInput {...args} font="mono" value="claude-opus-4-6" />
        <span className="font-mono fs-10.5 text-ink-900/60">mono</span>
      </div>
    </div>
  ),
}

export const States: Story = {
  render: (args) => (
    <div className="flex w-[320px] flex-col gap-4">
      <div className="flex flex-col items-start gap-1.5">
        <LiveInput {...args} value="" />
        <span className="font-mono fs-10.5 text-ink-900/60">empty · placeholder</span>
      </div>
      <div className="flex flex-col items-start gap-1.5">
        <LiveInput {...args} invalid value="relay/" title="A tag name cannot end in a slash" />
        <span className="font-mono fs-10.5 text-ink-900/60">invalid · field</span>
      </div>
      <div className="flex flex-col items-start gap-1.5">
        <LiveInput {...args} variant="inline" invalid value="relay/" />
        <span className="font-mono fs-10.5 text-ink-900/60">invalid · inline</span>
      </div>
      <div className="flex flex-col items-start gap-1.5">
        <LiveInput {...args} disabled />
        <span className="font-mono fs-10.5 text-ink-900/60">disabled</span>
      </div>
    </div>
  ),
}

const SEAMS: (InputSeam | undefined)[] = [undefined, 'top', 'bottom']

/**
 * The combobox's corners on the side an open list hangs from. The seam's
 * hairline is a `focus:` style, so it shows on the focused field only.
 */
export const ComboboxSeams: Story = {
  args: { variant: 'combobox', value: '~/Projects/orbital' },
  render: (args) => (
    <div className="flex w-[320px] flex-col gap-4">
      {SEAMS.map((seam) => (
        <div key={seam ?? 'none'} className="flex flex-col items-start gap-1.5">
          <LiveInput {...args} seam={seam} />
          <span className="font-mono fs-10.5 text-ink-900/60">{seam ?? 'closed'}</span>
        </div>
      ))}
    </div>
  ),
}

/** `TextArea` shares `Input`'s file and its sizes; it has no variants. */
export const TextAreaSizes: Story = {
  render: () => (
    <div className="flex w-[420px] flex-col gap-4">
      {SIZES.map((size) => (
        <div key={size} className="flex flex-col items-start gap-1.5">
          <LiveTextArea
            size={size}
            rows={3}
            placeholder="What should this session do?"
            value="Reconnect the relay socket after the Mac wakes from sleep, and keep the queued frames."
          />
          <span className="font-mono fs-10.5 text-ink-900/60">{size}</span>
        </div>
      ))}
      <div className="flex flex-col items-start gap-1.5">
        <LiveTextArea size="lg" font="mono" rows={3} value={'npm run typecheck -w web\nnpm test -w server'} />
        <span className="font-mono fs-10.5 text-ink-900/60">lg · mono</span>
      </div>
    </div>
  ),
}
