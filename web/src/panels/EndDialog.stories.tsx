import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { screen, userEvent } from 'storybook/test'
import { BILLING } from '../../../site/demo/fake/fixtures'
import type { EndAnswer } from '../lib/worktree'
import { useOrbital } from '../store/store'
import { Button } from '../ui/Button'
import { EndDialog } from './EndDialog'

/** The one key the dialog reads: the session it ends. */
function seed(): () => void {
  const before = useOrbital.getState()
  useOrbital.setState({ sessions: { [BILLING.id]: BILLING } })
  return () => useOrbital.setState(before, true)
}

/** An End that never answers: the dialog holds its ENDING… state. */
const endHangs = (): Promise<EndAnswer> => new Promise(() => {})

/**
 * Opened from the header's End, the way `DetailPanel` holds it. The
 * worktree row (canvas 63h) is not shown here: the catalogue runs as a
 * demo, and a demo never reads a session's worktree (`useSessionWorktree`).
 */
function EndDialogDemo({ sessionId, hang = false }: { sessionId: string | null; hang?: boolean }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="min-h-screen p-6">
      <Button variant="ghost" onClick={() => setOpen(true)}>
        End session…
      </Button>
      <EndDialog open={open} sessionId={sessionId} onClose={() => setOpen(false)} onEnd={hang ? endHangs : undefined} />
    </div>
  )
}

const meta = {
  title: 'Panels/EndDialog',
  component: EndDialogDemo,
  parameters: { layout: 'fullscreen' },
  beforeEach: seed,
  args: { sessionId: BILLING.id },
} satisfies Meta<typeof EndDialogDemo>
export default meta

type Story = StoryObj<typeof meta>

/** The title on a line of its own, then the sentence. */
export const Open: Story = {}

/** A session the store does not know: the sentence alone. */
export const Untitled: Story = { args: { sessionId: 'unknown' } }

/** End pressed and under way: the buttons and the caption dim, esc does nothing. */
export const Ending: Story = {
  args: { hang: true },
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'End session' }))
  },
}
