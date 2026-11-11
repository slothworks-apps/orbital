import type { Meta, StoryObj } from '@storybook/react-vite'
import mapShot from '../../../site/public/demo-images/map.webp'
import phoneAnswer from '../../../site/public/demo-images/phone-answer.webp'
import phoneNew from '../../../site/public/demo-images/phone-new.webp'
import sessionShot from '../../../site/public/demo-images/session.webp'
import { BILLING, DEMO_EPOCH } from '../../../site/demo/fake/fixtures'
import { apiFileImagePath, apiImagePath, configureImages } from '../lib/images'
import type { MediaSourceKey } from '../lib/media'
import type { MediaItem } from '../lib/types'
import { useMedia } from '../store/media'
import { MediaGallery } from './MediaGallery'

const CWD = BILLING.cwd
const ts = (minutesAgo: number) => new Date(DEMO_EPOCH - minutesAgo * 60_000).toISOString()

/** The billing session's media, oldest first: pasted, a tool run of three frames, named in a reply, written, a subagent's. */
const ITEMS: MediaItem[] = [
  { id: 'm1:0', kind: 'image', source: 'you', messageId: 'm1', ts: ts(40), ref: 'map', w: 1440, h: 900 },
  { id: 'm2:0', kind: 'image', source: 'tool', messageId: 'm2', ts: ts(30), ref: 'phone-new', w: 780, h: 1744, toolRun: 'run-1', tool: 'browser_take_screenshot' },
  { id: 'm2:1', kind: 'image', source: 'tool', messageId: 'm2', ts: ts(29), ref: 'phone-answer', w: 780, h: 1744, toolRun: 'run-1', tool: 'browser_take_screenshot' },
  { id: 'm2:2', kind: 'image', source: 'tool', messageId: 'm2', ts: ts(28), ref: 'session', w: 900, h: 1600, toolRun: 'run-1', tool: 'browser_take_screenshot' },
  { id: 'm3:0', kind: 'image', source: 'agent', messageId: 'm3', ts: ts(20), path: 'docs/retry-timeline.png', cwd: CWD, w: 1440, h: 900, disk: 'present' },
  { id: 'm3:1', kind: 'image', source: 'agent', messageId: 'm3', ts: ts(20), path: 'docs/old-flow.png', cwd: CWD, disk: 'missing' },
  { id: 'm4:0', kind: 'image', source: 'written', messageId: 'm4', ts: ts(10), path: 'out/backoff-chart.png', cwd: CWD, w: 900, h: 1600, tool: 'Write' },
  {
    id: 'm5:0',
    kind: 'image',
    source: 'tool',
    messageId: 'm5',
    ts: ts(5),
    ref: 'phone-answer',
    w: 780,
    h: 1744,
    toolRun: 'run-2',
    tool: 'browser_take_screenshot',
    subagent: { toolUseId: 'agent-1', name: 'Check the dashboard' },
  },
]

const BY_REF: Record<string, string> = { map: mapShot, 'phone-new': phoneNew, 'phone-answer': phoneAnswer, session: sessionShot }

/** Refs and paths answer with screenshots of Orbital itself; the catalogue has no image store. */
function standInImages(): void {
  configureImages({
    resolve: (ref) => BY_REF[ref] ?? mapShot,
    resolvePath: (_session, path) => (path.endsWith('chart.png') ? sessionShot : mapShot),
  })
}

/** The session's list as the server last answered it, and the Sources filter. */
function seedMedia(hidden: MediaSourceKey[], items: MediaItem[] = ITEMS): () => () => void {
  return () => {
    standInImages()
    const before = useMedia.getState()
    useMedia.setState({ lists: { [BILLING.id]: items }, hidden: { [BILLING.id]: hidden } })
    return () => {
      useMedia.setState(before, true)
      configureImages({ resolve: apiImagePath, resolvePath: apiFileImagePath })
    }
  }
}

const meta = {
  title: 'Panels/MediaGallery',
  component: MediaGallery,
  beforeEach: seedMedia([]),
  args: { sessionId: BILLING.id, columns: 3 },
  parameters: { layout: 'fullscreen' },
  // The detail panel's body, 450px wide; a detached window's is wider and takes five columns.
  render: (args) => (
    <div className="border-r border-line/14 bg-panel/90" style={{ width: args.columns === 5 ? 760 : 450, height: 640 }}>
      <MediaGallery {...args} />
    </div>
  ),
} satisfies Meta<typeof MediaGallery>
export default meta

type Story = StoryObj<typeof meta>

/** Newest first, the tool run stacked, the gone file marked. */
export const Docked: Story = {}

/** A detached window's wider body: five columns. */
export const Detached: Story = { args: { columns: 5 } }

/** Tool frames hidden by Sources: the count says so. */
export const Filtered: Story = { beforeEach: seedMedia(['tool', 'subagent']) }

/** Every source hidden: nothing shown, and the way back. */
export const AllHidden: Story = { beforeEach: seedMedia(['you', 'tool', 'named', 'saved', 'subagent']) }

/** No media at all. */
export const Empty: Story = { beforeEach: seedMedia([], []) }
