import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { claudeDirMonograms } from '../lib/claudeDirs'
import type { ClaudeDirName } from '../lib/types'
import { ClaudeDirHeaderControl, ClaudeDirSegments, claudeDirOriginHint, type ClaudeDirOrigin } from './ClaudeDirChoice'

const DIRS: ClaudeDirName[] = [
  { id: 1, name: 'Work', path: '/Users/demo/.claude', account: 'demo@work.example', exists: true },
  { id: 2, name: 'Personal', path: '/Users/demo/.claude-personal', account: 'demo@example.com', exists: true },
  { id: 3, name: 'Client', path: '/Users/demo/.claude-client', account: null, exists: false },
  { id: 4, name: 'Open source', path: '/Users/demo/.claude-oss', account: 'demo@oss.example', exists: true },
  { id: 5, name: 'Writing', path: '/Users/demo/.claude-writing', account: 'demo@example.com', exists: true },
]

/** The label row the segments sit under in the New session form, with its origin hint. */
function SegmentsDemo({ dirs, origin }: { dirs: ClaudeDirName[]; origin: ClaudeDirOrigin }) {
  const [value, setValue] = useState<number | null>(dirs[0].id)
  const changed = { ...origin, changed: origin.changed || value !== dirs[0].id }
  return (
    <div className="flex w-[520px] flex-col gap-2">
      <div className="flex items-baseline gap-2 font-mono fs-10 tracking-[0.16em] text-ink-900/60">
        PROFILE
        <span className="tracking-normal text-ink-900/50">· {claudeDirOriginHint(changed)}</span>
      </div>
      <ClaudeDirSegments dirs={dirs} value={value} onChange={setValue} />
    </div>
  )
}

function HeaderDemo({ origin }: { origin: ClaudeDirOrigin }) {
  const [value, setValue] = useState<number | null>(1)
  return (
    <div className="flex h-[420px] w-[620px] items-start justify-end">
      <ClaudeDirHeaderControl
        dirs={DIRS}
        monograms={claudeDirMonograms(DIRS)}
        value={value}
        defaultId={1}
        origin={{ ...origin, changed: origin.changed || value !== 1 }}
        onChange={setValue}
      />
    </div>
  )
}

const meta = {
  title: 'Panels/ClaudeDirChoice',
  component: SegmentsDemo,
  args: { dirs: DIRS.slice(0, 3), origin: { from: 'planet', planet: 'Add retry to the webhook sender', changed: false } },
} satisfies Meta<typeof SegmentsDemo>
export default meta

type Story = StoryObj<typeof meta>

/** Two or three directories: segments in the form; a directory missing on disk cannot be chosen. */
export const Segments: Story = {}

/** Two directories, prefilled from the last launch. */
export const TwoSegments: Story = { args: { dirs: DIRS.slice(0, 2), origin: { from: 'last', changed: false } } }

/** Four or more: the quiet control in the dialog's header, opened. */
export const HeaderControl: Story = {
  render: (args) => <HeaderDemo origin={args.origin} />,
  play: ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.click()
  },
}

/** The header control at rest. */
export const HeaderControlClosed: Story = {
  args: { origin: { from: 'default', changed: false } },
  render: (args) => <HeaderDemo origin={args.origin} />,
}
