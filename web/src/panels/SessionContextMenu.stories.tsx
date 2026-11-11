import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn, screen, userEvent } from 'storybook/test'
import { BILLING, INFRA, QUIET, TAGS } from '../../../site/demo/fake/fixtures'
import type { ApiSession } from '../lib/types'
import { closeSessionMenu, openSessionMenu } from '../store/sessionActions'
import { useOrbital } from '../store/store'
import { SessionMenuHost } from './SessionContextMenu'

const AT = { x: 160, y: 80 }

/** Seeds the session and its tags, and opens the menu at a right-click's point. */
function openFor(session: ApiSession, settings: Record<string, string> = {}): () => () => void {
  return () => {
    const before = useOrbital.getState()
    useOrbital.setState({
      sessions: { [session.id]: session },
      tags: TAGS,
      settings: { ...before.settings, ...settings },
    })
    openSessionMenu(session.id, { ...AT, from: 'map' }, fn())
    return () => {
      closeSessionMenu()
      useOrbital.setState(before, true)
    }
  }
}

/** The host `App` mounts; the menu opens where the right-click was. */
function SessionContextMenuDemo() {
  return (
    <SessionMenuHost>
      <div className="min-h-[520px]" />
    </SessionMenuHost>
  )
}

const meta = {
  title: 'Panels/SessionContextMenu',
  component: SessionContextMenuDemo,
  parameters: { layout: 'fullscreen' },
  beforeEach: openFor(BILLING),
} satisfies Meta<typeof SessionContextMenuDemo>
export default meta

type Story = StoryObj<typeof meta>

/** An Orbital session: open, the labels, then Clear and End. */
export const Orbital: Story = {}

/** Pinned, with "don't ask again" set for Clear: Unpin, and Clear without its ellipsis. */
export const PinnedNoClearDialog: Story = {
  beforeEach: openFor({ ...BILLING, pinnedAt: Date.now() }, { confirm_before_clear: 'false' }),
}

/** In a linked worktree: Remove worktree… listed, disabled until the worktree is known removable. */
export const InWorktree: Story = {
  beforeEach: openFor({ ...BILLING, git: { ref: 'fix/webhook-retry', detached: false, worktree: true, defaultBranch: false } }),
}

/** A terminal session Orbital watches: Take over in the deliberate group. */
export const Terminal: Story = { beforeEach: openFor(INFRA) }

/** An ended session. */
export const Ended: Story = { beforeEach: openFor({ ...QUIET[0], status: 'ended', endedAt: Date.now() }) }

/** Change tag: the tag list in place of the actions, the current one ticked. */
export const ChangeTag: Story = {
  play: async () => {
    await userEvent.click(await screen.findByRole('menuitem', { name: /Change tag/ }))
  },
}
