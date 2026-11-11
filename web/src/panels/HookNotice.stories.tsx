import type { Meta, StoryObj } from '@storybook/react-vite'
import type { LiveHookNotice } from '@orbital/shared/hookNotice'
import { BILLING } from '../../../site/demo/fake/fixtures'
import type { ChatMessage } from '../lib/types'
import { HookNotice, HookWaitCaption } from './HookNotice'

const STOP: LiveHookNotice = {
  event: 'Stop',
  commands: ['npm run lint', 'npm test -- --run'],
  count: 2,
  cancellable: true,
  messagesWaiting: 0,
}

function row(hook: LiveHookNotice | null, text = 'Stop hook running'): ChatMessage {
  return {
    id: `hook-${hook?.event ?? 'old'}`,
    role: 'notice',
    text,
    timestamp: new Date().toISOString(),
    notice: { level: 'info', ...(hook ? { hook } : {}) },
  }
}

interface HookNoticeStoryProps {
  message: ChatMessage
  /** Messages the user sent that wait for the hooks: the caption under them. */
  waiting?: number
}

/** The live row at the foot of the detail panel's transcript. */
function HookNoticeDemo({ message, waiting = 0 }: HookNoticeStoryProps) {
  return (
    <div className="flex w-[450px] flex-col gap-2">
      <HookNotice sessionId={BILLING.id} message={message} />
      {waiting > 0 && message.notice?.hook && <HookWaitCaption hook={message.notice.hook} count={waiting} />}
    </div>
  )
}

const meta = {
  title: 'Panels/HookNotice',
  component: HookNoticeDemo,
  args: { message: row(STOP) },
} satisfies Meta<typeof HookNoticeDemo>
export default meta

type Story = StoryObj<typeof meta>

/** Stop hooks running: their commands, and Cancel. */
export const StopHooks: Story = {}

/** A message waits behind them: the caption under it. */
export const MessageWaiting: Story = {
  args: { message: row({ ...STOP, messagesWaiting: 1 }), waiting: 1 },
}

/** A PreToolUse hook for Bash: no Cancel, since stopping it stops the turn. */
export const PreToolUse: Story = {
  args: {
    message: row({ event: 'PreToolUse', tool: 'Bash', commands: ['./scripts/guard-rm.sh'], count: 1, cancellable: false, messagesWaiting: 0 }),
  },
}

/** A hook whose commands are not surely known: the event and count alone. */
export const UnknownCommands: Story = {
  args: { message: row({ event: 'SessionStart', count: 3, cancellable: false, messagesWaiting: 0 }) },
}

/** From a Mac that predates `notice.hook`: only its text, Cancel kept. */
export const OlderMac: Story = { args: { message: row(null, 'Stop hooks running') } }
