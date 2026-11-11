import type { Meta, StoryObj } from '@storybook/react-vite'
import mapShot from '../../../site/public/demo-images/map.webp'
import phoneAnswer from '../../../site/public/demo-images/phone-answer.webp'
import sessionShot from '../../../site/public/demo-images/session.webp'
import { BILLING, DEMO_EPOCH } from '../../../site/demo/fake/fixtures'
import { api } from '../lib/api'
import { apiFileImagePath, apiImagePath, configureImages } from '../lib/images'
import type { MediaItem } from '../lib/types'
import { useMedia } from '../store/media'
import { MediaReadout } from './MediaReadout'

const ts = (minutesAgo: number) => new Date(DEMO_EPOCH - minutesAgo * 60_000).toISOString()

const ITEMS: MediaItem[] = [
  { id: 'm1:0', kind: 'image', source: 'you', messageId: 'm1', ts: ts(40), ref: 'map', w: 1440, h: 900 },
  { id: 'm2:0', kind: 'image', source: 'tool', messageId: 'm2', ts: ts(30), ref: 'phone', w: 780, h: 1744, toolRun: 'run-1', tool: 'browser_take_screenshot' },
  { id: 'm2:1', kind: 'image', source: 'tool', messageId: 'm2', ts: ts(29), ref: 'session', w: 900, h: 1600, toolRun: 'run-1', tool: 'browser_take_screenshot' },
  { id: 'm3:0', kind: 'image', source: 'agent', messageId: 'm3', ts: ts(20), path: 'docs/retry-timeline.png', cwd: BILLING.cwd, w: 1440, h: 900, disk: 'present' },
  { id: 'm4:0', kind: 'image', source: 'you', messageId: 'm4', ts: ts(10), ref: 'session', w: 900, h: 1600 },
]

/**
 * The session's list, answered by `sessionMedia` as well as held, since the
 * popover reads it again as it opens; refs and paths answer with screenshots
 * of Orbital itself.
 */
function seedMedia(gallery: boolean): () => () => void {
  return () => {
    configureImages({
      resolve: (ref) => (ref === 'session' ? sessionShot : ref === 'phone' ? phoneAnswer : mapShot),
      resolvePath: () => mapShot,
    })
    const realMedia = api.sessionMedia
    api.sessionMedia = () => Promise.resolve(ITEMS)
    const before = useMedia.getState()
    useMedia.setState({ lists: { [BILLING.id]: ITEMS }, hidden: { [BILLING.id]: [] }, gallery: gallery ? BILLING.id : null })
    return () => {
      useMedia.setState(before, true)
      api.sessionMedia = realMedia
      configureImages({ resolve: apiImagePath, resolvePath: apiFileImagePath })
    }
  }
}

const meta = {
  title: 'Panels/MediaReadout',
  component: MediaReadout,
  beforeEach: seedMedia(false),
  args: { sessionId: BILLING.id, onScreen: true },
  // The detail panel's header, 450px wide: the facts line — folder, branch, then ▦ — and the glance spans the panel.
  render: (args) => (
    <div style={{ height: 420 }}>
      <div data-media-bound className="rounded-[14px] border border-line/14 bg-panel/90 px-[22px] py-4" style={{ width: 450 }}>
        <div className="flex items-center font-mono fs-11 text-ink-900/60">
          ~/code/billing-api · main
          <MediaReadout {...args} />
        </div>
      </div>
    </div>
  ),
} satisfies Meta<typeof MediaReadout>
export default meta

type Story = StoryObj<typeof meta>

/** ▦ at rest, once the session has media. */
export const Resting: Story = {}

/** The glance: the latest tiles, Sources, Open gallery. */
export const Glance: Story = {
  play: ({ canvasElement }) => canvasElement.querySelector<HTMLButtonElement>('button[aria-label="Media of this session"]')?.click(),
}

/** The gallery shows in the panel body: ▦ wears the active chip. */
export const GalleryOpen: Story = { beforeEach: seedMedia(true) }
