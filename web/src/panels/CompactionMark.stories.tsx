import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { BILLING, DEMO_EPOCH, TAGS } from '../../../site/demo/fake/fixtures'
import type { ChatMessage, CompactionMark as Mark } from '../lib/types'
import { CompactingBlock, CompactionMark } from './CompactionMark'

const SUCCESS: Mark = {
  outcome: 'success',
  trigger: 'auto',
  preTokens: 186_000,
  postTokens: 22_000,
  durationMs: 41_000,
  summary:
    'The user asked for a retry with backoff in the webhook sender.\n\n- Read src/webhooks/sender.ts and its tests.\n- Added withRetry() with exponential backoff, five attempts.\n- Tests pass; the PR description is still to write.',
}

const FAILED: Mark = {
  outcome: 'failed',
  trigger: 'manual',
  preTokens: 192_000,
  postTokens: null,
  durationMs: 12_000,
  error: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
}

const markMessage = (compaction: Mark): ChatMessage => ({
  id: `compaction-${compaction.outcome}`,
  role: 'compaction',
  timestamp: new Date(DEMO_EPOCH - 6 * 60_000).toISOString(),
  compaction,
})

const meta = {
  title: 'Panels/CompactionMark',
  component: CompactionMark,
  args: {
    message: markMessage(SUCCESS),
    sessionId: BILLING.id,
    terminal: false,
    contextWindow: 200_000,
    hue: TAGS[0].hue,
  },
  // In the transcript column of the detail panel.
  render: (args) => (
    <div className="w-[450px] bg-panel p-4">
      <CompactionMark {...args} />
    </div>
  ),
} satisfies Meta<typeof CompactionMark>
export default meta

type Story = StoryObj<typeof meta>

/** The mark a compaction leaves: before → after, the drop, the bar against the window. */
export const Compacted: Story = {}

/** The second of three, with its summary unfolded. */
export const SummaryOpen: Story = {
  args: { ordinal: { n: 2, of: 3 }, hue: TAGS[1].hue },
  play: ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>('button[aria-expanded]')?.click()
  },
}

/** A terminal session's, with no "after" reported: no bar is drawn. */
export const TerminalWithoutAfter: Story = {
  args: {
    terminal: true,
    contextWindow: null,
    message: markMessage({ ...SUCCESS, trigger: 'manual', postTokens: null, summary: undefined }),
  },
}

/** A failure: the reason quoted exactly, Copy, and /compact again on the newest failure of a live session. */
export const Failed: Story = { args: { message: markMessage(FAILED), onCompactAgain: fn() } }

/** A failure the CLI gave no reason for, on an older one (no /compact again). */
export const FailedNoReason: Story = {
  args: { message: markMessage({ ...FAILED, error: null, durationMs: null, preTokens: null }) },
}

/** The live block while a compaction runs: elapsed time and a sweep, no progress. */
export const Compacting: Story = {
  render: () => (
    <div className="flex w-[450px] flex-col gap-4 bg-panel p-4">
      <CompactingBlock startedAt={Date.now() - 47_000} trigger="auto" preTokens={186_000} contextWindow={200_000} />
      <CompactingBlock startedAt={Date.now() - 8_000} trigger="manual" preTokens={null} contextWindow={null} />
    </div>
  ),
}
