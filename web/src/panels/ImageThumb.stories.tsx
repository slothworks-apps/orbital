import type { Meta, StoryObj } from '@storybook/react-vite'
import mapShot from '../../../site/public/demo-images/map.webp'
import sessionShot from '../../../site/public/demo-images/session.webp'
import { apiFileImagePath, apiImagePath, configureImages, type ImageResolver } from '../lib/images'
import type { ImageRefEntry } from '../lib/types'
import { ImageThumb, type ThumbVariant } from './ImageThumb'

const MAP: ImageRefEntry = { ref: 'map', w: 1440, h: 900, bytes: 26_166 }
const PANEL: ImageRefEntry = { ref: 'session', w: 900, h: 1600, bytes: 59_476 }
const UNSIZED: ImageRefEntry = { ref: 'map', w: null, h: null, bytes: 26_166 }

/** How the image store answers for the story; the catalogue has none of its own. */
function resolving(resolve: ImageResolver): () => () => void {
  return () => {
    configureImages({ resolve })
    return () => configureImages({ resolve: apiImagePath, resolvePath: apiFileImagePath })
  }
}

/** The web's answer: a URL at once. Here, screenshots of Orbital itself. */
const SCREENSHOTS = resolving((ref) => (ref === 'session' ? sessionShot : mapShot))

const VARIANTS: ThumbVariant[] = ['user-solo', 'user', 'tool', 'waiting']

const meta = {
  title: 'Panels/ImageThumb',
  component: ImageThumb,
  beforeEach: SCREENSHOTS,
  args: { image: MAP, variant: 'user', source: 'pasted image' },
  // The transcript's content column.
  render: (args) => (
    <div style={{ width: 406 }}>
      <ImageThumb {...args} />
    </div>
  ),
} satisfies Meta<typeof ImageThumb>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** Each frame: the solo turn's bubble corners, under a bubble, inside a tool row, inside a waiting box. */
export const Variants: Story = {
  render: (args) => (
    <div className="flex flex-col gap-5" style={{ width: 406 }}>
      {VARIANTS.map((variant) => (
        <div key={variant} className="flex flex-col items-start gap-1.5">
          <ImageThumb {...args} variant={variant} />
          <span className="font-mono fs-10.5 text-ink-900/60">{variant}</span>
        </div>
      ))}
    </div>
  ),
}

/** A tall image: the height cap holds, the width follows. */
export const Tall: Story = { args: { image: PANEL } }

/** Two-up: each held to the narrower cap. */
export const TwoUp: Story = {
  render: (args) => (
    <div className="flex gap-1.5" style={{ width: 406 }}>
      <ImageThumb {...args} image={MAP} widthCapPx={171} />
      <ImageThumb {...args} image={PANEL} widthCapPx={171} />
    </div>
  ),
}

/** No stored size: the height cap, the image finds its width. */
export const Unsized: Story = { args: { image: UNSIZED } }

/** The phone's full-width result under a tool row, with ⤢. */
export const ToolWide: Story = { args: { variant: 'tool-wide', source: 'browser_take_screenshot' } }

/** A ref the image store pruned: NOT IN CACHE at the same footprint. */
export const NotInCache: Story = { beforeEach: resolving(() => 'data:image/png;base64,AAAA') }

/** Bytes still on their way over the tunnel (the phone): the moon under the box. */
export const Loading: Story = { beforeEach: resolving(() => new Promise<string>(() => {})) }

/** Bytes that never arrived: a tap asks again. */
export const Failed: Story = { beforeEach: resolving(() => Promise.reject(new Error('tunnel closed'))) }

/** Clicked: the media viewer opens on it. */
export const Open: Story = {
  parameters: { layout: 'fullscreen' },
  play: ({ canvasElement }) => canvasElement.querySelector<HTMLButtonElement>('button[aria-label="Open image full size"]')?.click(),
}
