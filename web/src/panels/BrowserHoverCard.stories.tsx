import type { Meta, StoryObj } from '@storybook/react-vite'
import { BrowserHoverCard } from './BrowserHoverCard'

const meta = {
  title: 'Panels/BrowserHoverCard',
  component: BrowserHoverCard,
  args: {
    title: 'Webhooks — Billing API reference',
    lines: ['https://docs.example.com/billing/webhooks#retries', '412 chars selected'],
    className: 'left-0 top-0 w-[330px]',
  },
  // The card is absolutely placed by its caller; the frame stands in for what it hangs off.
  render: (args) => (
    <div className="relative h-[120px] w-[450px]">
      <BrowserHoverCard {...args} />
    </div>
  ),
} satisfies Meta<typeof BrowserHoverCard>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** A long title and URL wrap anywhere rather than spill. */
export const LongTitle: Story = {
  args: {
    title:
      'Retrying failed webhook deliveries with exponential backoff and jitter — a practical guide for payment providers',
    lines: [
      'https://docs.example.com/billing/guides/webhooks/retries/exponential-backoff-and-jitter?ref=sidebar&lang=en',
      'visible tab · 1280×800 · taken 14:32',
    ],
  },
}
