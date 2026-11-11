import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { screen, userEvent } from 'storybook/test'
import { INFRA } from '../../../site/demo/fake/fixtures'
import { api } from '../lib/api'
import { useOrbital } from '../store/store'
import { Button } from '../ui/Button'
import { TakeOverDialog } from './TakeOverDialog'

/** The one key the dialog reads: the terminal session it takes over. */
function seed(): () => void {
  const before = useOrbital.getState()
  useOrbital.setState({ sessions: { [INFRA.id]: INFRA } })
  return () => useOrbital.setState(before, true)
}

/** A take over that never answers: the dialog stays in flight. */
function takeOverHangs(): () => void {
  const real = api.takeOver
  api.takeOver = () => new Promise(() => {})
  return () => {
    api.takeOver = real
  }
}

/** Opened from the read-only banner's Take over, for a terminal that is busy. */
function TakeOverDialogDemo({ sessionId }: { sessionId: string | null }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="min-h-screen p-6">
      <Button variant="ghost" onClick={() => setOpen(true)}>
        Take over…
      </Button>
      <TakeOverDialog open={open} sessionId={sessionId} onClose={() => setOpen(false)} />
    </div>
  )
}

const meta = {
  title: 'Panels/TakeOverDialog',
  component: TakeOverDialogDemo,
  parameters: { layout: 'fullscreen' },
  beforeEach: seed,
  args: { sessionId: INFRA.id },
} satisfies Meta<typeof TakeOverDialogDemo>
export default meta

type Story = StoryObj<typeof meta>

export const Open: Story = {}

/** A session the store does not know: the untitled wording. */
export const Untitled: Story = { args: { sessionId: 'unknown' } }

/** Take over pressed, the request on its way: both buttons disabled. */
export const TakingOver: Story = {
  beforeEach: takeOverHangs,
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Take over' }))
  },
}
