import type { Meta, StoryObj } from '@storybook/react-vite'
import { BILLING } from '../../../site/demo/fake/fixtures'
import type { BranchLines, BranchPr, GitLocation, OtherTree } from '../lib/types'
import { WhereLine } from './WhereLine'

const PATH = '~/code/billing-api'

const MAIN: GitLocation = { ref: 'main', detached: false, worktree: false, defaultBranch: true }
const FEATURE: GitLocation = { ref: 'feat/webhook-retry', detached: false, worktree: false, defaultBranch: false }
const WORKTREE: GitLocation = { ref: 'feat/webhook-retry', detached: false, worktree: true, defaultBranch: false }
const DETACHED: GitLocation = { ref: '3f9c2e1', detached: true, worktree: false, defaultBranch: false }

const PR: BranchPr = {
  number: 172,
  url: 'https://github.com/example/billing-api/pull/172',
  state: 'open',
  review: 'review_required',
  checks: { passed: 9, failed: 0, pending: 2 },
  base: 'main',
}

const LINES: BranchLines = {
  parent: 'main',
  committed: { added: 214, removed: 38 },
  uncommitted: { added: 12, removed: 4 },
}

const TREES: OtherTree[] = [
  { root: '/Users/demo/code/billing-api/.claude/worktrees/retry-tests', git: { ...WORKTREE, ref: 'test/retry' }, agents: ['Write the retry tests'] },
  { root: '/Users/demo/code/billing-api/.claude/worktrees/docs', git: { ...WORKTREE, ref: 'docs/retries' }, agents: ['Document the backoff', 'Update the changelog'] },
  { root: '/Users/demo/code/billing-api/.claude/worktrees/bench', git: { ...WORKTREE, ref: 'perf/bench' }, agents: ['Benchmark the sender'] },
]

const meta = {
  title: 'Panels/WhereLine',
  component: WhereLine,
  args: {
    path: PATH,
    fullPath: BILLING.cwd,
    git: FEATURE,
    sessionId: BILLING.id,
    panelWidthPx: 450,
    linesMode: 'off',
  },
  // The detail header's first line: the 450px panel's row, the icon group's room left at its end.
  render: (args) => (
    <div className="flex h-[220px] w-[450px] items-start">
      <div className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3">
        <WhereLine {...args} />
        <span className="w-[120px] flex-none" />
      </div>
    </div>
  ),
} satisfies Meta<typeof WhereLine>
export default meta

type Story = StoryObj<typeof meta>

/** A feature branch in the main checkout: the fork mark. */
export const FeatureBranch: Story = {}

/** The default branch: the trunk mark. */
export const DefaultBranch: Story = { args: { git: MAIN } }

/** A worktree: the tree mark. */
export const Worktree: Story = { args: { git: WORKTREE, path: '~/code/billing-api/.claude/worktrees/webhook-retry' } }

/** A detached HEAD: the trunk mark and the sha. */
export const Detached: Story = { args: { git: DETACHED } }

/** Not a git directory: the path alone. */
export const NotGit: Story = { args: { git: null, path: '~/Downloads/exports' } }

/** The opt-in suffixes: the #PR (the row's one button) and the line changes, split. */
export const PrAndLines: Story = { args: { pr: PR, lines: LINES, linesMode: 'split' } }

/** The PR's bubble, on focus. */
export const PrBubble: Story = {
  args: { pr: PR, lines: LINES, linesMode: 'branch' },
  play: ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>('button[aria-label]')?.focus()
  },
}

/** Other trees subagents work in, after the suffixes (form A). */
export const OtherTreesOnABranch: Story = { args: { pr: PR, otherTrees: TREES } }

/** On the default branch in the main checkout: the count alone after the path (form B). */
export const OtherTreesFromMain: Story = { args: { git: MAIN, otherTrees: TREES } }

/** A narrow panel: the path and then the branch are cut, the lines move into the branch's bubble. */
export const Narrow: Story = {
  args: {
    git: { ...FEATURE, ref: 'feat/webhook-retry-with-exponential-backoff-and-jitter' },
    path: '~/code/clients/acme/billing-api',
    pr: PR,
    lines: LINES,
    linesMode: 'split',
    panelWidthPx: 340,
    cellWidthPx: 220,
  },
  render: (args) => (
    <div className="flex h-[260px] w-[340px] items-start">
      <div className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3">
        <WhereLine {...args} />
        <span className="w-[80px] flex-none" />
      </div>
    </div>
  ),
}
