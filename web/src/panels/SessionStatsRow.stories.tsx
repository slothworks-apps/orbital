import type { Meta, StoryObj } from '@storybook/react-vite'
import { BILLING, DEMO_EPOCH, DOCS } from '../../../site/demo/fake/fixtures'
import { api } from '../lib/api'
import type { SessionStatsDetail, StatsTurnSegment } from '../lib/types'
import { SessionStatsRow } from './SessionStatsRow'

const MINUTE = 60_000

function turn(uuid: string, startMin: number, apiMs: number, tools: StatsTurnSegment['tools'] = []): StatsTurnSegment {
  return {
    requestId: `req-${uuid}`,
    uuid,
    startTs: DEMO_EPOCH - startMin * MINUTE,
    apiMs,
    tokens: { input: 12_000, output: 1_800, cacheRead: 160_000, cacheCreation: 4_000 },
    tools,
  }
}

function tool(name: string, kind: StatsTurnSegment['tools'][number]['kind'], ms: number): StatsTurnSegment['tools'][number] {
  return { name, kind, ms, isError: false, resultChars: 2_400, useId: `use-${name}-${ms}` }
}

/** The billing session's stored stats: fourteen minutes of work, most of it the model. */
const STATS: SessionStatsDetail = {
  session: {
    id: BILLING.id,
    title: BILLING.title,
    projectDir: '-Users-demo-code-billing-api',
    model: BILLING.model,
    resolvedModel: BILLING.resolvedModel,
    firstAt: BILLING.firstAt,
    lastAt: BILLING.lastAt,
    turns: 6,
  },
  rollup: {
    apiMs: 6 * MINUTE,
    localToolMs: 2.5 * MINUTE,
    mcpMs: 0.5 * MINUTE,
    subagentMs: 1.5 * MINUTE,
    turns: 6,
    inputTokens: 74_000,
    outputTokens: 11_000,
    cacheReadTokens: 960_000,
    cacheCreationTokens: 24_000,
    cacheCreation5mTokens: 24_000,
    cacheCreation1hTokens: 0,
    thinkingTokens: 3_200,
    subagentTokens: 48_000,
    subagentUsage: {},
    toolCalls: 14,
    toolErrors: 1,
    toolBreakdown: {},
    humanWaitMs: 40_000,
    humanBreakdown: {},
    permissionBreakdown: {},
    permissionTimed: true,
    findings: [],
  },
  cost: {
    uncachedInput: 1.11,
    cacheRead: 1.44,
    cacheWrite: 0.45,
    output: 0.83,
    mainTotal: 3.83,
    subagentTotal: 0.62,
    total: 4.45,
  },
  findings: [],
  turns: [
    turn('t1', 14, 40_000, [tool('Read', 'local', 900), tool('Grep', 'local', 1_400)]),
    turn('t2', 12, 70_000, [tool('Agent', 'subagent', 90_000)]),
    turn('t3', 9, 55_000, [tool('Edit', 'local', 1_100), tool('Bash', 'local', 64_000)]),
    turn('t4', 6, 80_000, [tool('mcp__docs__search', 'mcp', 30_000)]),
    turn('t5', 4, 60_000, [tool('Bash', 'local', 80_000)]),
    turn('t6', 2, 55_000),
  ],
}

/** `sessionStats` answers `detail` for the story; the catalogue's fake server has none. */
function stubStats(detail: SessionStatsDetail | null): () => () => void {
  return () => {
    const real = api.sessionStats
    api.sessionStats = () => (detail ? Promise.resolve(detail) : Promise.reject(new Error('not indexed')))
    return () => {
      api.sessionStats = real
    }
  }
}

const meta = {
  title: 'Panels/SessionStatsRow',
  component: SessionStatsRow,
  beforeEach: stubStats({ ...STATS, session: { ...STATS.session, id: DOCS.id } }),
  // An idle session's numbers: the bar fills the track.
  args: { session: DOCS, variant: 'bar' },
  // The foot of the detail header, 450px wide with its 22px padding.
  render: (args) => (
    <div className="rounded-[14px] border border-line/14 bg-panel/90 px-[22px] pb-4 pt-1" style={{ width: 450 }}>
      <SessionStatsRow {...args} />
    </div>
  ),
} satisfies Meta<typeof SessionStatsRow>
export default meta

type Story = StoryObj<typeof meta>

/** Busy time and cost, and the four-colour split. */
export const Bar: Story = {}

/** A working session: the split is drawn against the wall clock, so it does not fill the track. */
export const Live: Story = { beforeEach: stubStats(STATS), args: { session: BILLING } }

/** Nothing measured yet: `session stats · —` and nothing to open. */
export const NoStats: Story = { beforeEach: stubStats(null) }

/** The header's stats button instead of the bar. */
export const Button: Story = { args: { variant: 'button' } }

/** The button with nothing to open. */
export const ButtonNoStats: Story = { beforeEach: stubStats(null), args: { variant: 'button' } }

/** The quick dialog the row opens. */
export const Dialog: Story = {
  parameters: { layout: 'fullscreen' },
  play: async ({ canvasElement }) => {
    const row = await new Promise<HTMLElement>((resolve) => {
      const find = () => {
        const el = canvasElement.querySelector<HTMLElement>('button[data-session-stats-row]')
        if (el) resolve(el)
        else requestAnimationFrame(find)
      }
      find()
    })
    row.click()
  },
}
