import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import type { FieldSize } from './Input'
import { CustomModelField } from './CustomModelField'

/**
 * Enter or blur checks the id through the server (`api.validateModel`). The
 * catalogue has no server, so a check ends in the field's error line; the
 * stories show the states that need none.
 */
const meta = {
  title: 'UI/CustomModelField',
  component: CustomModelField,
  args: { size: 'lg', onValidated: fn(), onCleared: fn() },
  render: (args) => (
    <div className="w-[360px]">
      <CustomModelField {...args} />
    </div>
  ),
} satisfies Meta<typeof CustomModelField>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

const SIZES: FieldSize[] = ['lg', 'sm', 'md']

export const Sizes: Story = {
  render: (args) => (
    <div className="flex w-[360px] flex-col gap-6">
      {SIZES.map((size) => (
        <div key={size} className="flex flex-col items-start gap-1.5">
          <CustomModelField {...args} size={size} />
          <span className="font-mono fs-10.5 text-ink-900/60">{size}</span>
        </div>
      ))}
    </div>
  ),
}

/** An id that has already run starts valid, with its ✓ line and no check. */
export const Trusted: Story = {
  args: { initial: { id: 'claude-opus-4-6', trusted: true } },
}
