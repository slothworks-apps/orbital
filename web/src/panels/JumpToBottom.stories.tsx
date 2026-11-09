import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { JumpToBottom, type JumpSurface } from './JumpToBottom'

/** Lines of a transcript behind the control, so the scrim has something to melt. */
const LINES = Array.from({ length: 14 }, (_, i) =>
  i % 3 === 0
    ? 'Added withRetry() around the post in sender.ts and a test for the fifth attempt.'
    : 'Reading src/webhooks/sender.ts to see where deliveries are posted and how failures surface.',
)

/** The surface each transcript is drawn on, at its size. */
const FRAME: Record<JumpSurface, string> = {
  panel: 'h-[300px] w-[450px] bg-panel',
  subagent: 'h-[300px] w-[420px] bg-space',
  phone: 'h-[420px] w-[390px] bg-space',
}

const meta = {
  title: 'Panels/JumpToBottom',
  component: JumpToBottom,
  args: { state: 'above', surface: 'panel', onJump: fn() },
  render: (args) => (
    <div className={`relative overflow-hidden rounded-[10px] border border-line/12 ${FRAME[args.surface]}`}>
      <div className="flex flex-col gap-3 p-4 fs-13 leading-[1.55] text-ink-200/90">
        {LINES.map((line, i) => (
          <p key={i}>{line}</p>
        ))}
      </div>
      <JumpToBottom {...args} />
    </div>
  ),
} satisfies Meta<typeof JumpToBottom>
export default meta

type Story = StoryObj<typeof meta>

/** Scrolled away: the round ↓. */
export const Above: Story = {}

/** Something arrived below: it widens leftward to say so. */
export const NewBelow: Story = { args: { state: 'new' } }

/** At the bottom: nothing shows. */
export const Hidden: Story = { args: { state: 'hidden' } }

/** The subagent panel's transcript. */
export const Subagent: Story = { args: { state: 'new', surface: 'subagent' } }

/** The phone: bigger to the finger than to the eye. */
export const Phone: Story = { args: { state: 'new', surface: 'phone' } }
