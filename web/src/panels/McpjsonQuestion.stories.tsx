import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { fn } from 'storybook/test'
import type { McpjsonAnswers, McpjsonServer } from '../lib/mcpjson'
import { McpjsonIntro, McpjsonRows } from './McpjsonQuestion'

const SERVERS: McpjsonServer[] = [
  { name: 'github', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], source: 'npm' },
  { name: 'postgres', command: 'docker', args: ['run', '-i', '--rm', 'mcp/postgres', 'postgresql://localhost/billing'], source: 'docker' },
  { name: 'release-notes', command: 'node', args: ['./tools/mcp/release-notes.mjs', '--since', 'last tag'], source: 'file', file: 'tools/mcp/release-notes.mjs' },
  { name: 'linear', command: 'https://mcp.linear.example/sse', args: [], source: 'url' },
  { name: 'fetch', command: 'uvx', args: ['mcp-server-fetch'], source: 'pypi' },
]

/** The question as the New session dialog's body holds it: the intro and the rows, answers kept here. */
function QuestionDemo({
  servers,
  where,
  initial = {},
  onViewFile,
}: {
  servers: McpjsonServer[]
  where?: string
  initial?: McpjsonAnswers
  onViewFile: (server: McpjsonServer & { file: string }) => void
}) {
  const [answers, setAnswers] = useState<McpjsonAnswers>(initial)
  return (
    <div className="flex w-[640px] flex-col gap-2">
      <McpjsonIntro count={servers.length} where={where} />
      <McpjsonRows
        servers={servers}
        answers={answers}
        onAnswer={(name, answer) => setAnswers((a) => ({ ...a, [name]: answer }))}
        onViewFile={onViewFile}
      />
    </div>
  )
}

const meta = {
  title: 'Panels/McpjsonQuestion',
  component: QuestionDemo,
  args: { servers: SERVERS, onViewFile: fn() },
} satisfies Meta<typeof QuestionDemo>
export default meta

type Story = StoryObj<typeof meta>

/** Every source: a package, an image, a file from the project (amber), a URL, a program. Nothing answered yet. */
export const Unanswered: Story = {}

/** Some answered: no default, no hue for yes or no. */
export const PartlyAnswered: Story = { args: { initial: { github: 'allow', postgres: 'deny' } } }

/** One server, launched on another device. */
export const OneOnAnotherDevice: Story = { args: { servers: SERVERS.slice(2, 3), where: 'build-box' } }
