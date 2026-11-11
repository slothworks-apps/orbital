import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { DEMO_EPOCH } from '../../../site/demo/fake/fixtures'
import { api, ApiError } from '../lib/api'
import type { DirListing } from '../lib/types'
import { FolderChooser } from './FolderChooser'

const HOME = '/home/demo'
const DAY = 24 * 60 * 60_000

/** One level of the server's folders, per path. */
const TREE: Record<string, DirListing['dirs']> = {
  [HOME]: [
    { name: 'code', hasChildren: true },
    { name: 'deploy', hasChildren: true },
    { name: 'notes', hasChildren: false },
  ],
  [`${HOME}/code`]: [
    { name: 'billing-api', hasChildren: true },
    { name: 'infra', hasChildren: true },
    { name: 'status-page', hasChildren: true },
    { name: 'worker', hasChildren: false },
  ],
  [`${HOME}/code/empty`]: [],
}

const RECENTS = [
  { cwd: `${HOME}/code/infra`, lastAt: DEMO_EPOCH - 9 * 60_000 },
  { cwd: `${HOME}/code/billing-api`, lastAt: DEMO_EPOCH - DAY },
  { cwd: `${HOME}/deploy/staging`, lastAt: DEMO_EPOCH - 6 * DAY },
]

/** `listDirs` answers from `TREE`, or refuses as an offline member does. */
function stubDirs(offline = false): () => () => void {
  return () => {
    const real = api.listDirs
    api.listDirs = (path) =>
      offline
        ? Promise.reject(new ApiError('{"error":"member_offline"}', 409))
        : Promise.resolve({ path: path ?? HOME, dirs: TREE[path ?? HOME] ?? [], truncated: false })
    return () => {
      api.listDirs = real
    }
  }
}

const meta = {
  title: 'Panels/FolderChooser',
  component: FolderChooser,
  beforeEach: stubDirs(),
  args: {
    machine: 'build-box',
    name: 'build-box',
    kind: 'headless',
    start: `${HOME}/code`,
    recents: RECENTS,
    onChoose: fn(),
    onCancel: fn(),
  },
  // New session's field group, which the chooser hangs over (canvas 50g).
  render: (args) => (
    <div style={{ height: 420 }}>
      <div className="relative" style={{ width: 640 }}>
        <div className="flex flex-col gap-2">
          <span className="font-mono fs-9.5 tracking-[0.16em] text-ink-900/55">DIRECTORY</span>
          <div className="rounded-[9px] border border-line/14 bg-space/45 px-3 py-2 font-mono fs-12 text-ink-100">{args.start}</div>
        </div>
        <FolderChooser {...args} />
      </div>
    </div>
  ),
} satisfies Meta<typeof FolderChooser>
export default meta

type Story = StoryObj<typeof meta>

/** Opened on the field's directory: recent projects on the left, its folders on the right. */
export const Browsing: Story = {}

/** The field is empty: the device's home. */
export const AtHome: Story = { args: { start: '' } }

/** A folder with nothing in it. */
export const EmptyFolder: Story = { args: { start: `${HOME}/code/empty` } }

/** The device went offline: one quiet line where the folders go. */
export const Offline: Story = { beforeEach: stubDirs(true) }
