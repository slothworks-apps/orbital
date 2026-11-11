import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { BILLING, DEMO_EPOCH, MOBILE } from '../../../site/demo/fake/fixtures'
import type { ErrorRecord } from '../lib/types'
import { useOrbital } from '../store/store'
import { Button } from '../ui/Button'
import { ErrorLog } from './ErrorLog'

const MINUTE = 60_000

/** One of each kind of row: unseen with detail, a Claude-side failure, an expanded-able crash, a dev record, one already filed. */
const ERRORS: ErrorRecord[] = [
  {
    id: 41,
    at: DEMO_EPOCH - 2 * MINUTE,
    source: 'server',
    kind: 'session_failed',
    sessionId: BILLING.id,
    message: 'The session stopped: the Claude Code process exited with code 1.',
    detail: 'Error: spawn claude ENOENT\n    at ChildProcess._handle.onexit (node:internal/child_process:286:19)',
    context: { cwd: BILLING.cwd, permissionMode: 'acceptEdits', model: 'opus[1m]' },
    seenAt: null,
    issueUrl: null,
  },
  {
    id: 40,
    at: DEMO_EPOCH - 9 * MINUTE,
    source: 'web',
    kind: 'api_request',
    sessionId: null,
    message: 'Failed to switch permission mode',
    detail: null,
    context: { url: `/api/sessions/${MOBILE.id}/permission-mode`, status: 409 },
    seenAt: null,
    issueUrl: null,
  },
  {
    id: 39,
    at: DEMO_EPOCH - 30 * MINUTE,
    source: 'web',
    kind: 'render_crash',
    sessionId: null,
    message: "TypeError: Cannot read properties of undefined (reading 'design')",
    detail: '    at ProfileLoginRow (ProfileLoginRow.tsx:48:31)\n    at ClaudeDirsRows (ClaudeDirsRows.tsx:290:17)',
    context: { dev: true },
    seenAt: null,
    issueUrl: null,
  },
  {
    id: 37,
    at: DEMO_EPOCH - 3 * 60 * MINUTE,
    source: 'server',
    kind: 'thumbnail_failed',
    sessionId: MOBILE.id,
    message: 'Could not draw the first page of docs/push-flow.pdf',
    detail: null,
    context: null,
    seenAt: null,
    issueUrl: 'https://github.com/slothworks-apps/orbital/issues/164',
  },
]

/** The log's rows, put back after the story. */
function seedErrors(errors: ErrorRecord[]): () => () => void {
  return () => {
    const before = useOrbital.getState()
    useOrbital.setState({ errors })
    return () => useOrbital.setState(before, true)
  }
}

/** Opened from the map's ! button, the way the app holds it. */
function ErrorLogDemo() {
  const [open, setOpen] = useState(true)
  return (
    <div className="min-h-screen p-6">
      <Button variant="ghost" onClick={() => setOpen(true)}>
        Errors
      </Button>
      <ErrorLog open={open} onClose={() => setOpen(false)} />
    </div>
  )
}

const meta = {
  title: 'Panels/ErrorLog',
  component: ErrorLogDemo,
  parameters: { layout: 'fullscreen' },
  beforeEach: seedErrors(ERRORS),
} satisfies Meta<typeof ErrorLogDemo>
export default meta

type Story = StoryObj<typeof meta>

/** Unread rows, newest first; the dev record drops to the muted ink. */
export const Unread: Story = {}

/** A row's detail opened. */
export const DetailOpen: Story = {
  play: ({ canvasElement }) => {
    const root = canvasElement.ownerDocument
    root.querySelector<HTMLButtonElement>('button[aria-controls="error-detail-41"]')?.click()
  },
}

/** Nothing unread. */
export const Empty: Story = { beforeEach: seedErrors([]) }
