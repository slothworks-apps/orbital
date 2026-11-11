import type { Meta, StoryObj } from '@storybook/react-vite'
import { DEMO_EPOCH } from '../../../site/demo/fake/fixtures'
import type { ChatMessage, NoticeLevel } from '../lib/types'
import { Button } from '../ui/Button'
import { NoticeRow } from './NoticeRow'

const notice = (text: string, level: NoticeLevel, command?: string): ChatMessage => ({
  id: `notice-${level}-${command ?? ''}-${text.length}`,
  role: 'notice',
  timestamp: new Date(DEMO_EPOCH - 3 * 60_000).toISOString(),
  text,
  notice: { level, ...(command ? { command } : {}) },
})

const CONTEXT = [
  'Context Usage',
  'claude-opus-5 · 96k/200k tokens (48%)',
  '',
  'System prompt:   3.1k tokens (1.6%)',
  'System tools:   14.2k tokens (7.1%)',
  'MCP tools:       6.8k tokens (3.4%)',
  'Memory files:    1.9k tokens (1.0%)',
  'Messages:       70.0k tokens (35.0%)',
  'Free space:    104.0k tokens (52.0%)',
  '',
  'Memory files · /memory',
  '└ CLAUDE.md: 1.9k tokens',
].join('\n')

/** A framed banner: each row padded to the frame by its visible width, the colour codes aside. */
const boxRow = (text: string, visible: string) => `│ ${text}${' '.repeat(30 - visible.length)}│`
const BOXED = [
  `╭${'─'.repeat(31)}╮`,
  boxRow('\u001b[1mClaude Code\u001b[0m v3.4.0', 'Claude Code v3.4.0'),
  boxRow('cwd: ~/code/billing-api', 'cwd: ~/code/billing-api'),
  boxRow('model: \u001b[36mopus[1m]\u001b[0m', 'model: opus[1m]'),
  `╰${'─'.repeat(31)}╯`,
].join('\n')

const meta = {
  title: 'Panels/NoticeRow',
  component: NoticeRow,
  args: { message: notice('Auto-update installed 3.4.0; it takes effect next session.', 'notice') },
  // Full transcript width in the detail panel.
  render: (args) => (
    <div className="w-[450px] bg-panel p-4">
      <NoticeRow {...args} />
    </div>
  ),
} satisfies Meta<typeof NoticeRow>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** A run message at each level: glyph and ink rise with urgency; warning leaves the dashed rules for a box. */
export const Levels: Story = {
  render: () => (
    <div className="flex w-[450px] flex-col gap-3 bg-panel p-4">
      <NoticeRow message={notice('Hooks loaded from .claude/settings.json.', 'info')} />
      <NoticeRow message={notice('Auto-update installed 3.4.0; it takes effect next session.', 'notice')} />
      <NoticeRow message={notice('Run /compact before the context fills up.', 'suggestion')} />
      <NoticeRow message={notice('The PreToolUse hook exited with code 2.', 'warning')} />
    </div>
  ),
}

/** A locally answered command's output: the CLI chip, verbatim, folded past eight lines. */
export const CommandOutput: Story = { args: { message: notice(CONTEXT, 'notice', '/context') } }

/** The same, unfolded. */
export const CommandOutputOpen: Story = {
  args: { message: notice(CONTEXT, 'notice', '/context') },
  play: ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>('[data-notice] button')?.click()
  },
}

/** Box-drawing and ANSI output is set tight and never reflowed; the header says ANSI. */
export const TerminalArt: Story = { args: { message: notice(BOXED, 'info', '/status') } }

/** A multi-line run message with no command: the level header over a body. */
export const MultiLineNotice: Story = {
  args: {
    message: notice('Stop hook feedback:\n- lint failed in src/webhooks/sender.ts\n- 2 problems (1 error, 1 warning)', 'warning'),
  },
}

/** The live Stop hook notice carries its Cancel at the row's end. */
export const WithAction: Story = {
  args: {
    message: notice('Running Stop hook: npm run lint…', 'notice'),
    action: (
      <Button variant="pill" size="pill">
        Cancel
      </Button>
    ),
  },
}
