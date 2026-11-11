import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { screen, userEvent } from 'storybook/test'
import { BILLING, DOCS, MESSAGES } from '../../../site/demo/fake/fixtures'
import { api } from '../lib/api'
import { useOrbital } from '../store/store'
import { Button } from '../ui/Button'
import { StopDialog } from './StopDialog'

/**
 * Seeds the two keys the dialog reads — the session and its transcript —
 * and puts the store back after the story.
 */
function seed(): () => void {
  const before = useOrbital.getState()
  useOrbital.setState({
    sessions: { [BILLING.id]: BILLING, [DOCS.id]: DOCS },
    transcripts: { [BILLING.id]: MESSAGES.billing, [DOCS.id]: MESSAGES.docs },
  })
  return () => useOrbital.setState(before, true)
}

/** An interrupt that never answers: the dialog stays in its in-flight state. */
function interruptHangs(): () => void {
  const real = api.interrupt
  api.interrupt = () => new Promise(() => {})
  return () => {
    api.interrupt = real
  }
}

/** Opened over the detail panel's header, the way the Stop button holds it. */
function StopDialogDemo({ sessionId }: { sessionId: string | null }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="min-h-screen p-6">
      <Button variant="warning" onClick={() => setOpen(true)}>
        Stop…
      </Button>
      <StopDialog open={open} sessionId={sessionId} onClose={() => setOpen(false)} />
    </div>
  )
}

const meta = {
  title: 'Panels/StopDialog',
  component: StopDialogDemo,
  parameters: { layout: 'fullscreen' },
  beforeEach: seed,
  args: { sessionId: BILLING.id },
} satisfies Meta<typeof StopDialogDemo>
export default meta

type Story = StoryObj<typeof meta>

/** A turn mid-edit: the open tool call is named in the sentence and in the running row. */
export const Open: Story = {}

/** Mid-turn with no tool call open: the sentence alone. */
export const NoOpenTool: Story = { args: { sessionId: DOCS.id } }

/** A session the store does not know (yet): the untitled wording. */
export const Untitled: Story = { args: { sessionId: 'unknown' } }

/** Stop turn pressed, the interrupt on its way: both buttons disabled. */
export const Stopping: Story = {
  beforeEach: interruptHangs,
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: /Stop turn/ }))
  },
}
