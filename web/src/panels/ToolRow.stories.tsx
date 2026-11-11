import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import sessionShot from '../../../site/public/demo-images/session.webp'
import { BILLING_DECISION, DEMO_EPOCH, MESSAGES, MOBILE, subagent } from '../../../site/demo/fake/fixtures'
import { BROWSER_SCREENSHOT_TOOL_NAME } from '../lib/browserBridge'
import { apiFileImagePath, apiImagePath, configureImages } from '../lib/images'
import type { BackgroundTask, ChatMessage } from '../lib/types'
import { ToolRow, type ToolRowProps } from './ToolRow'

const HOME = '/Users/demo/code/billing-api'

let seq = 0
/** One call and, unless it still runs, its result `ms` later. */
function call(
  toolName: string,
  toolInput: Record<string, unknown>,
  result: Partial<ChatMessage> | null,
  ms = 1_200,
): Pick<ToolRowProps, 'toolUse' | 'toolResult'> {
  seq += 1
  const toolUseId = `story-call-${seq}`
  const at = DEMO_EPOCH - 60_000
  return {
    toolUse: { id: `${toolUseId}-use`, role: 'tool_use', toolName, toolInput, toolUseId, timestamp: new Date(at).toISOString(), cwd: HOME },
    toolResult: result
      ? { id: `${toolUseId}-result`, role: 'tool_result', toolUseId, timestamp: new Date(at + ms).toISOString(), ...result }
      : undefined,
  }
}

const READ = call('Read', { file_path: `${HOME}/src/webhooks/sender.ts` }, { text: MESSAGES.billing[3]?.text ?? '' }, 300)
const GREP = call('Grep', { pattern: 'withRetry', path: `${HOME}/src` }, { text: 'src/lib/retry.ts' }, 450)
const BASH = call(
  'Bash',
  { command: 'npm test -- src/webhooks', description: 'Run the webhook tests' },
  { text: '\u001b[32m✓\u001b[0m sender retries on 503 (12 ms)\n\u001b[32m✓\u001b[0m sender gives up after 5 attempts (31 ms)\n\u001b[31m✗\u001b[0m sender keeps the idempotency key\n\nTests: \u001b[31m1 failed\u001b[0m, \u001b[32m2 passed\u001b[0m, 3 total' },
  8_400,
)
const EDIT = call(
  'Edit',
  BILLING_DECISION.input,
  { text: `The file ${HOME}/src/webhooks/sender.ts has been updated successfully.` },
)
const FAILED_EDIT = call(
  'Edit',
  { file_path: `${HOME}/src/webhooks/sender.ts`, old_string: 'await post(url, body)', new_string: 'await withRetry(() => post(url, body))' },
  { text: '<tool_use_error>String to replace not found in file.</tool_use_error>', isError: true },
)
const WRITE = call(
  'Write',
  { file_path: `${HOME}/src/lib/backoff.ts`, content: 'export function backoff(attempt: number): number {\n  return Math.min(30_000, 500 * 2 ** attempt)\n}\n' },
  { text: 'File created successfully.' },
)
const RUNNING = call('Bash', { command: 'npm run build' }, null)

/** The mobile session's agent, still running, and a dev server it left in the background. */
const AGENT_SUBAGENT = subagent(MOBILE.id, 1, 'Trace the client token refresh', 'working')
const AGENT = call('Agent', { description: 'Trace the client token refresh', subagent_type: 'Explore' }, null)
AGENT.toolUse.toolUseId = AGENT_SUBAGENT.toolUseId
const DEV_SERVER = call('Bash', { command: 'npm run dev', run_in_background: true }, { text: 'Command running in background with ID: dev-1' }, 200)
const DEV_TASK: BackgroundTask = {
  id: 'dev-1',
  kind: 'shell',
  label: 'npm run dev',
  command: 'npm run dev',
  intent: 'keep',
  state: 'running',
  startedAt: DEMO_EPOCH - 60_000,
  toolUseId: DEV_SERVER.toolUse.toolUseId,
  hasOutput: true,
}

const SCREENSHOT = call(
  'mcp__playwright__browser_take_screenshot',
  {},
  { text: 'Took a screenshot of the current page.', images: [{ ref: 'story-shot', w: 900, h: 1600, bytes: 59_476 }] },
  900,
)
const BROWSER_NONE = call(BROWSER_SCREENSHOT_TOOL_NAME, {}, { text: 'No browser is connected to Orbital. Ask the user to open the extension.' }, 40)

/** Image refs answer with a screenshot of Orbital itself; the catalogue has no image store. */
function standInImages(): () => void {
  configureImages({ resolve: () => sessionShot })
  return () => configureImages({ resolve: apiImagePath, resolvePath: apiFileImagePath })
}

/** Presses the first row, as a reader opens it. */
const expandFirst: Story['play'] = ({ canvasElement }) => {
  canvasElement.querySelector<HTMLButtonElement>('[data-tool-header] > button')?.click()
}

const meta = {
  title: 'Panels/ToolRow',
  component: ToolRow,
  args: { ...READ },
  // The transcript's content column.
  render: (args) => (
    <div style={{ width: 406 }}>
      <ToolRow {...args} />
    </div>
  ),
} satisfies Meta<typeof ToolRow>
export default meta

type Story = StoryObj<typeof meta>

/** A run of collapsed rows as a transcript shows them: path, pattern, command, diff counts, the running dot. */
export const Collapsed: Story = {
  render: () => (
    <div className="flex flex-col gap-1" style={{ width: 406 }}>
      {[READ, GREP, BASH, EDIT, WRITE, FAILED_EDIT, RUNNING].map((row) => (
        <ToolRow key={row.toolUse.id} {...row} />
      ))}
    </div>
  ),
}

/** A Read opened: its input and its result. */
export const Expanded: Story = { play: expandFirst }

/** A Bash call opened: its output through the ANSI colours. */
export const BashOutput: Story = { args: { ...BASH }, play: expandFirst }

/** An edit opened: its diff instead of the input JSON. */
export const EditDiff: Story = { args: { ...EDIT }, play: expandFirst }

/** A new file: every line added. */
export const WriteNewFile: Story = { args: { ...WRITE }, play: expandFirst }

/** An edit that failed: the diff it meant, and the error. */
export const FailedEdit: Story = { args: { ...FAILED_EDIT }, play: expandFirst }

/** Still running: no result, no time, the pulsing dot. */
export const Running: Story = { args: { ...RUNNING } }

/** A tool result that carried an image: the 96px thumb beside its size. */
export const ImageResult: Story = { beforeEach: standInImages, args: { ...SCREENSHOT }, play: expandFirst }

/** An agent call whose agent still runs: OPEN → its transcript. */
export const OpenSubagent: Story = {
  args: { ...AGENT, subagents: [AGENT_SUBAGENT], onOpenSubagent: fn() },
}

/** A background shell with output: OUTPUT → opens it in the side slot. */
export const OpenTaskOutput: Story = {
  args: { ...DEV_SERVER, backgroundTasks: [DEV_TASK], onOpenTaskOutput: fn() },
}

/** The agent's browser screenshot with no browser paired: `no browser`, in the muted ink. */
export const BrowserNoBrowser: Story = { args: { ...BROWSER_NONE }, play: expandFirst }
