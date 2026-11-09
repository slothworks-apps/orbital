import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { BILLING, DEMO_EPOCH, TAGS } from '../../../site/demo/fake/fixtures'
import type { WorktreeChoice, WorktreeProblem } from '../lib/useWorktreeChoice'
import type { FetchState, WorktreeRepo } from '../lib/worktree'
import { WorktreeGroup } from './WorktreeGroup'

const REPO: WorktreeRepo = {
  git: true,
  repoRoot: BILLING.cwd,
  treeRoot: BILLING.cwd,
  defaultBranch: 'main',
  currentBranch: 'main',
  occupants: [],
  branchForm: 'feat/',
  branches: {
    local: ['main', 'feat/webhook-retry', 'fix/invoice-rounding'],
    remote: ['origin/main', 'origin/feat/webhook-retry', 'origin/release/2026-11', 'origin/docs/retries'],
  },
  fetchedAt: DEMO_EPOCH - 2 * 60 * 60_000,
  autoOn: false,
}

/** The checkout is taken: a session works there on its own branch. */
const OCCUPIED: WorktreeRepo = {
  ...REPO,
  currentBranch: 'feat/webhook-retry',
  occupants: [{ sessionId: BILLING.id, title: BILLING.title, tagId: '1', branch: 'feat/webhook-retry' }],
}

interface DemoProps {
  repo: WorktreeRepo
  on?: boolean
  switchedOffByHand?: boolean
  branch?: string
  base?: string
  fetch?: FetchState
  problems?: WorktreeProblem[]
}

/** The group with its choice held here — what `useWorktreeChoice` would hold, without asking a Mac. */
function GroupDemo({ repo, on: initialOn = false, switchedOffByHand = false, branch: b = '', base: ba, fetch = { state: 'fetched', at: DEMO_EPOCH }, problems = [] }: DemoProps) {
  const [on, setOn] = useState(initialOn)
  const [branch, setBranch] = useState(b)
  const [base, setBase] = useState(ba ?? `origin/${repo.defaultBranch}`)
  const choice: WorktreeChoice = {
    repo,
    on,
    setOn,
    switchedOffByHand,
    branch,
    setBranch,
    base,
    setBase,
    fetch,
    problems,
    blocked: problems.length > 0,
    launch: undefined,
    setLaunchError: () => {},
  }
  // Under PROJECT DIRECTORY in the New session dialog's form.
  return (
    <div className="h-[460px] w-[520px]">
      <WorktreeGroup choice={choice} tags={TAGS} />
    </div>
  )
}

const meta = {
  title: 'Panels/WorktreeGroup',
  component: GroupDemo,
  args: { repo: REPO },
} satisfies Meta<typeof GroupDemo>
export default meta

type Story = StoryObj<typeof meta>

/** A1 quiet: the kicker and the switch. */
export const Quiet: Story = {}

/** A2 occupied: who works in the checkout, their tag dot the line's only colour. */
export const Occupied: Story = { args: { repo: OCCUPIED } }

/** Occupied and turned off by hand: the hint adds the consequence. */
export const OccupiedSwitchedOff: Story = { args: { repo: OCCUPIED, switchedOffByHand: true } }

/** A3 on: BRANCH empty (Orbital names it), BASE the default. */
export const On: Story = { args: { on: true } }

/** A3 stacked: a typed branch on another base, and the PR target that follows. */
export const StackedBase: Story = {
  args: { repo: OCCUPIED, on: true, branch: 'feat/retry-dashboard', base: 'feat/webhook-retry' },
}

/** The BASE picker open, with its search. */
export const BasePicker: Story = {
  args: { repo: OCCUPIED, on: true },
  play: async ({ canvasElement }) => {
    // The fold opens first; the picker's trigger is in it.
    await new Promise((resolve) => setTimeout(resolve, 400))
    canvasElement.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')?.click()
  },
}

/** A4: a fetch that failed, and a branch name that is taken — each with its one fix. */
export const Errors: Story = {
  args: {
    on: true,
    branch: 'feat/webhook-retry',
    base: 'main',
    fetch: { state: 'failed', error: 'offline', message: 'Could not resolve host: github.com' },
    problems: [
      { field: 'branch', text: 'A branch called feat/webhook-retry already exists.', action: { label: 'Use feat/webhook-retry-2', run: () => {} } },
      { field: 'base', text: 'Couldn’t fetch origin. You seem to be offline.', action: { label: 'Try again', run: () => {} } },
    ],
  },
}

/** Fetching origin: the base's note says so. */
export const Fetching: Story = { args: { on: true, fetch: { state: 'fetching' } } }
