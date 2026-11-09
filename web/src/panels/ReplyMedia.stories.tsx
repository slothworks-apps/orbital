import type { Meta, StoryObj } from '@storybook/react-vite'
import mapShot from '../../../site/public/demo-images/map.webp'
import sessionShot from '../../../site/public/demo-images/session.webp'
import { BILLING, DEMO_EPOCH } from '../../../site/demo/fake/fixtures'
import { apiFileImagePath, apiImagePath, configureImages } from '../lib/images'
import type { ChatMessage, MediaItem } from '../lib/types'
import { useMedia } from '../store/media'
import { ReplyMedia, ReplyMediaSession } from './ReplyMedia'

const CWD = BILLING.cwd
const at = new Date(DEMO_EPOCH - 3 * 60_000).toISOString()

const REPLY: ChatMessage = {
  id: 'story-reply',
  role: 'assistant',
  timestamp: at,
  cwd: CWD,
  text: 'The two charts are in `docs/retry-timeline.png` and `out/backoff-chart.png`; the old `docs/old-flow.png` is gone.',
}

/** What the session's list says of each named file: the old one is no longer on disk. */
const ITEMS: MediaItem[] = [
  { id: 'r:0', kind: 'image', source: 'agent', messageId: REPLY.id, ts: at, path: 'docs/retry-timeline.png', cwd: CWD, w: 1440, h: 900, disk: 'present' },
  { id: 'r:1', kind: 'image', source: 'agent', messageId: REPLY.id, ts: at, path: 'out/backoff-chart.png', cwd: CWD, w: 900, h: 1600, disk: 'present' },
  { id: 'r:2', kind: 'image', source: 'agent', messageId: REPLY.id, ts: at, path: 'docs/old-flow.png', cwd: CWD, disk: 'missing' },
]

/** Named files answer with screenshots of Orbital itself, and the list marks the gone one. */
function seed(): () => void {
  configureImages({ resolve: apiImagePath, resolvePath: (_session, path) => (path.endsWith('chart.png') ? sessionShot : mapShot) })
  const before = useMedia.getState()
  useMedia.setState({ lists: { [BILLING.id]: ITEMS } })
  return () => {
    useMedia.setState(before, true)
    configureImages({ resolve: apiImagePath, resolvePath: apiFileImagePath })
  }
}

const meta = {
  title: 'Panels/ReplyMedia',
  component: ReplyMedia,
  beforeEach: seed,
  args: { message: REPLY },
  // Under a reply in the session's own transcript, the content column wide.
  render: (args) => (
    <ReplyMediaSession.Provider value={BILLING.id}>
      <div className="flex flex-col gap-1" style={{ width: 406 }}>
        <p className="fs-13 leading-[1.55] text-ink-100/92">{args.message.text?.replaceAll('`', '')}</p>
        <ReplyMedia {...args} />
      </div>
    </ReplyMediaSession.Provider>
  ),
} satisfies Meta<typeof ReplyMedia>
export default meta

type Story = StoryObj<typeof meta>

/** Two images the reply names, and one gone from disk. */
export const Named: Story = {}

/** One wide image alone. */
export const Single: Story = {
  args: { message: { ...REPLY, text: 'Here is the timeline: `docs/retry-timeline.png`.' } },
}
