import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { fn } from 'storybook/test'
import type { WorktreeState } from '@orbital/shared/worktree'
import { BILLING } from '../../../site/demo/fake/fixtures'
import type { ApiSession } from '../lib/types'
import { useOrbital } from '../store/store'
import { Button } from '../ui/Button'
import { RemoveWorktreeDialog, WorktreeCleanupStrip } from './WorktreeCleanup'

/** billing-api ended in a linked worktree, its branch pushed with a PR. */
const SESSION: ApiSession = {
  ...BILLING,
  status: 'ended',
  git: { ref: 'fix/webhook-retry', detached: false, worktree: true, defaultBranch: false },
}

/** C1: nothing would be lost — Remove is the filled one. */
const CLEAN: WorktreeState = {
  path: '/Users/demo/code/billing-api/.claude/worktrees/webhook-retry',
  leaf: 'webhook-retry',
  branch: 'fix/webhook-retry',
  pr: { number: 42, state: 'open' },
  pushed: true,
  uncommittedFiles: 0,
  unpushedCommits: 0,
  sharedWith: [],
  variant: 'c1',
  removable: true,
  endsSession: false,
  dismissed: false,
}

/** The cleanup strip under the detail panel's where row (canvas 63e), in its 450px column. */
function StripDemo({ state }: { state: WorktreeState }) {
  return (
    <div className="w-[450px]">
      <WorktreeCleanupStrip session={SESSION} worktree={{ state, refresh: fn() }} />
    </div>
  )
}

const meta = {
  title: 'Panels/WorktreeCleanup',
  component: StripDemo,
  args: { state: CLEAN },
} satisfies Meta<typeof StripDemo>
export default meta

type Story = StoryObj<typeof meta>

/** C1: the branch stays on GitHub; Remove filled. */
export const Strip: Story = {}

/** C1 with the PR merged. */
export const StripMerged: Story = { args: { state: { ...CLEAN, pr: { number: 42, state: 'merged' } } } }

/** C2a: uncommitted files — Keep filled, Remove names the discard in the soft error ink. */
export const StripUncommitted: Story = { args: { state: { ...CLEAN, variant: 'c2a', uncommittedFiles: 3 } } }

/** C2b: commits not pushed — Keep filled, the branch stays on this Mac. */
export const StripUnpushed: Story = { args: { state: { ...CLEAN, variant: 'c2b', unpushedCommits: 2 } } }

/** The session the dialog is about, in the store. */
function seed(): () => void {
  const before = useOrbital.getState()
  useOrbital.setState({ sessions: { [SESSION.id]: SESSION } })
  return () => useOrbital.setState(before, true)
}

/** ⋯ → Remove worktree, opened the way the panel's menu holds it. */
function RemoveWorktreeDialogDemo() {
  const [open, setOpen] = useState(true)
  return (
    <div className="min-h-screen p-6">
      <Button variant="ghost" onClick={() => setOpen(true)}>
        Remove worktree…
      </Button>
      <RemoveWorktreeDialog open={open} sessionId={SESSION.id} onClose={() => setOpen(false)} />
    </div>
  )
}

/**
 * The dialog with nothing it can offer. Its Keep / Remove form needs the
 * worktree read from the server, which a demo never does
 * (`useSessionWorktree`), so the catalogue shows only this form.
 */
export const RemoveDialogNotOffered: Story = {
  parameters: { layout: 'fullscreen' },
  beforeEach: seed,
  render: () => <RemoveWorktreeDialogDemo />,
}
