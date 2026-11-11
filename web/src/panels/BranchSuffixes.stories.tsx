import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ReactNode } from 'react'
import { lineGroups } from '../lib/branchStatus'
import type { BranchLines, BranchPr } from '../lib/types'
import {
  BranchLinesTooltipContent,
  LineGroups,
  LinesTooltipContent,
  PrRows,
  PrTooltipContent,
} from './BranchSuffixes'

const LINES: BranchLines = {
  parent: 'main',
  committed: { added: 214, removed: 38 },
  uncommitted: { added: 12, removed: 4 },
}

const PR: BranchPr = {
  number: 172,
  url: 'https://github.com/example/billing-api/pull/172',
  state: 'open',
  review: 'review_required',
  checks: { passed: 9, failed: 0, pending: 2 },
  base: 'main',
}

/** The bubble the header's tooltips draw these into: the `panel` tooltip's shell. */
function Bubble({ width = 260, children }: { width?: number; children: ReactNode }) {
  return (
    <div
      className="flex flex-col gap-2 rounded-[9px] border border-line/16 bg-panel-solid px-3 py-2.5"
      style={{ width }}
    >
      {children}
    </div>
  )
}

const meta = {
  title: 'Panels/BranchSuffixes',
  component: LineGroups,
  args: { groups: lineGroups(LINES, 'split') },
} satisfies Meta<typeof LineGroups>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** The `+n −n` read-out in both modes, and with nothing uncommitted (no ring). */
export const Groups: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      {(
        [
          ['branch', LINES],
          ['split', LINES],
          ['split', { ...LINES, uncommitted: { added: 0, removed: 0 } }],
          ['split', { parent: null, committed: { added: 0, removed: 0 }, uncommitted: { added: 7, removed: 1 } }],
        ] as const
      ).map(([mode, lines], i) => (
        <div key={i} className="flex items-center gap-3">
          <LineGroups groups={lineGroups(lines, mode)} />
          <span className="font-mono fs-10.5 text-ink-900/60">{mode}</span>
        </div>
      ))}
    </div>
  ),
}

/** The #PR bubble in each state. */
export const PullRequest: Story = {
  render: () => (
    <div className="flex flex-wrap items-start gap-4">
      <Bubble>
        <PrTooltipContent pr={PR} />
      </Bubble>
      <Bubble>
        <PrTooltipContent pr={{ ...PR, state: 'draft', review: null, checks: null }} />
      </Bubble>
      <Bubble>
        <PrTooltipContent pr={{ ...PR, review: 'changes_requested', checks: { passed: 7, failed: 2, pending: 0 } }} />
      </Bubble>
      <Bubble>
        <PrTooltipContent pr={{ ...PR, state: 'merged', review: 'approved', checks: { passed: 11, failed: 0, pending: 0 } }} />
      </Bubble>
      <Bubble>
        <PrRows pr={{ ...PR, state: 'closed' }} />
      </Bubble>
    </div>
  ),
}

/** The line-changes bubble: against a parent, on the default branch, on a detached HEAD, and under a branch name. */
export const LineChanges: Story = {
  render: () => (
    <div className="flex flex-wrap items-start gap-4">
      <Bubble>
        <LinesTooltipContent lines={LINES} branch="feat/webhook-retry" detached={false} />
      </Bubble>
      <Bubble>
        <LinesTooltipContent lines={{ ...LINES, parent: null }} branch="main" detached={false} />
      </Bubble>
      <Bubble>
        <LinesTooltipContent lines={{ ...LINES, parent: null }} branch="3f9c2e1" detached />
      </Bubble>
      <Bubble width={280}>
        <BranchLinesTooltipContent lines={LINES} branch="feat/webhook-retry-with-exponential-backoff" detached={false} />
      </Bubble>
    </div>
  ),
}
