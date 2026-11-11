import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ChatMessage } from '../lib/types'
import { HarnessTranscriptRow } from './HarnessTranscriptRow'

const message = (text: string): ChatMessage => ({ id: `harness-${text.length}`, role: 'harness', text })

const meta = {
  title: 'Panels/HarnessTranscriptRow',
  component: HarnessTranscriptRow,
  args: { message: message('step 2 of 4 · Write the migration') },
  render: (args) => (
    <div className="w-[450px]">
      <HarnessTranscriptRow {...args} />
    </div>
  ),
} satisfies Meta<typeof HarnessTranscriptRow>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** A run of harness lines between turns; a long step title ellipsises. */
export const InTheTranscript: Story = {
  render: () => (
    <div className="flex w-[450px] flex-col gap-2">
      <HarnessTranscriptRow message={message('started · Ship the webhook retry')} />
      <HarnessTranscriptRow message={message('step 1 of 4 done · Read the sender and its tests')} />
      <HarnessTranscriptRow
        message={message(
          'step 2 of 4 · Add exponential backoff with jitter to every delivery and cap it at five attempts per endpoint',
        )}
      />
    </div>
  ),
}
