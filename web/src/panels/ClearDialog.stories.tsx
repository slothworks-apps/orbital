import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { screen, userEvent } from 'storybook/test'
import { BILLING, TAGS } from '../../../site/demo/fake/fixtures'
import { api } from '../lib/api'
import { DEFAULT_HARNESS_OPTIONS, type SessionHarness } from '../lib/types'
import { useOrbital } from '../store/store'
import { Button } from '../ui/Button'
import { ClearDialog } from './ClearDialog'

/** A harness two steps into four, so Clear offers to carry it on. */
const HARNESS: SessionHarness = {
  sessionId: BILLING.id,
  templateId: 1,
  name: 'Ship a fix',
  steps: [
    { id: 'reproduce', title: 'Reproduce', instructions: '', mode: 'auto', doneWhen: '' },
    { id: 'fix', title: 'Fix', instructions: '', mode: 'auto', doneWhen: '' },
    { id: 'test', title: 'Test', instructions: '', mode: 'gate', doneWhen: '' },
    { id: 'pr', title: 'Open the PR', instructions: '', mode: 'gate', doneWhen: '' },
  ],
  inputs: {},
  state: [{ status: 'done' }, { status: 'done' }, { status: 'active' }, { status: 'pending' }],
  options: DEFAULT_HARNESS_OPTIONS,
  paused: false,
  pauseReason: null,
  pauseKind: null,
  pausedAt: null,
  removedAt: null,
  autoRounds: 0,
  idleNudges: 0,
  createdAt: 0,
  updatedAt: 0,
}

/** What the dialog reads: the session, the tags its summary names, and its harness. */
function seed(harness: SessionHarness | null): () => () => void {
  return () => {
    const before = useOrbital.getState()
    useOrbital.setState({
      sessions: { [BILLING.id]: BILLING },
      tags: TAGS,
      harnesses: { [BILLING.id]: harness },
    })
    return () => useOrbital.setState(before, true)
  }
}

/** A clear that never answers: the dialog stays in flight. */
function clearHangs(): () => void {
  const real = api.clearSession
  api.clearSession = () => new Promise(() => {})
  return () => {
    api.clearSession = real
  }
}

/** Opened from the header's Clear, the way `DetailPanel` holds it. */
function ClearDialogDemo({ sessionId }: { sessionId: string | null }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="min-h-screen p-6">
      <Button variant="ghost" onClick={() => setOpen(true)}>
        Clear…
      </Button>
      <ClearDialog open={open} sessionId={sessionId} onClose={() => setOpen(false)} />
    </div>
  )
}

const meta = {
  title: 'Panels/ClearDialog',
  component: ClearDialogDemo,
  parameters: { layout: 'fullscreen' },
  beforeEach: seed(null),
  args: { sessionId: BILLING.id },
} satisfies Meta<typeof ClearDialogDemo>
export default meta

type Story = StoryObj<typeof meta>

/** The session's mode and tag in the summary, and "Don't ask again". */
export const Open: Story = {}

/** An unfinished harness: the row to continue it in the new session, on by default. */
export const WithHarness: Story = { beforeEach: seed(HARNESS) }

/** A session the store does not know: placeholders in the summary. */
export const Untitled: Story = { args: { sessionId: 'unknown' } }

/** Clear & start new pressed, the request on its way: both buttons disabled. */
export const Clearing: Story = {
  beforeEach: clearHangs,
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: /Clear & start new/ }))
  },
}
