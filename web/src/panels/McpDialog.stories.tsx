import type { Meta, StoryObj } from '@storybook/react-vite'
import { screen, userEvent } from 'storybook/test'
import { BILLING } from '../../../site/demo/fake/fixtures'
import { api, ApiError } from '../lib/api'
import type { ApiSession, McpServerDefinition, McpServerRow } from '../lib/types'
import { useMcpUi } from '../store/mcp'
import { useOrbital } from '../store/store'
import { McpDialog } from './McpDialog'

const SERVERS: McpServerRow[] = [
  { name: 'orbital', status: 'connected', origin: 'orbital', toolCount: 9, toggleable: false, editable: false },
  { name: 'github', status: 'connected', origin: 'user', toolCount: 41, toggleable: true, editable: true },
  { name: 'linear', status: 'needs-auth', origin: 'claudeai', toggleable: true, editable: false },
  { name: 'postgres', status: 'failed', origin: 'local', error: 'spawn psql-mcp ENOENT', toggleable: true, editable: true },
  { name: 'plugin:browser:playwright', plugin: 'browser', status: 'pending', origin: 'plugin', toggleable: true, editable: false },
  { name: 'sentry', status: 'disabled', origin: 'user', toolCount: 12, toggleable: true, editable: true },
]

const GITHUB: McpServerDefinition = {
  name: 'github',
  scope: 'user',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_TOKEN: 'ghp_example_token_value' },
}

type Answer = { servers: McpServerRow[] } | 'hang' | Error

/**
 * Opens the dialog for `session`, answering its server list with `answer` —
 * the demo world's server runs no MCP servers.
 */
function openWith(answer: Answer, session: ApiSession = BILLING): () => () => void {
  return () => {
    const before = useOrbital.getState()
    const realList = api.mcpServers
    const realConfig = api.mcpServerConfig
    api.mcpServers = () =>
      answer === 'hang' ? new Promise(() => {}) : answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
    api.mcpServerConfig = () => Promise.resolve(GITHUB)
    useOrbital.setState({ sessions: { [session.id]: session } })
    useMcpUi.getState().open(session.id)
    return () => {
      useMcpUi.getState().close()
      api.mcpServers = realList
      api.mcpServerConfig = realConfig
      useOrbital.setState(before, true)
    }
  }
}

const meta = {
  title: 'Panels/McpDialog',
  component: McpDialog,
  parameters: { layout: 'fullscreen' },
  beforeEach: openWith({ servers: SERVERS }),
  render: () => (
    <div className="min-h-screen">
      <McpDialog />
    </div>
  ),
} satisfies Meta<typeof McpDialog>
export default meta

type Story = StoryObj<typeof meta>

/** Every status a server can show: connected, needs login, failed, starting, off. */
export const Servers: Story = {}

/** Only Orbital's own server. */
export const OnlyOrbital: Story = { beforeEach: openWith({ servers: SERVERS.slice(0, 1) }) }

/** The list on its way. */
export const Loading: Story = { beforeEach: openWith('hang') }

/** The request failed: what was asked and what came back. */
export const LoadFailed: Story = { beforeEach: openWith(new ApiError('{"message":"The CLI did not answer"}', 500)) }

/** The session's process is not running: `/mcp` does not start one. */
export const Asleep: Story = {
  beforeEach: openWith(new ApiError('{"error":"not_running","message":"The session is not running"}', 409)),
}

/** An ended session. */
export const Ended: Story = { beforeEach: openWith({ servers: [] }, { ...BILLING, status: 'ended' }) }

/** + Add server: the form in the list's place. */
export const AddForm: Story = {
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: /Add server/ }))
  },
}

/** Edit on a server Orbital wrote: its definition read back, the token masked. */
export const EditForm: Story = {
  play: async () => {
    const edits = await screen.findAllByRole('button', { name: 'Edit' })
    await userEvent.click(edits[0])
  },
}
