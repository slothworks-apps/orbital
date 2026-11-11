import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import sessionShot from '../../../site/public/demo-images/session.webp'
import mapShot from '../../../site/public/demo-images/map.webp'
import { DEMO_EPOCH } from '../../../site/demo/fake/fixtures'
import type { Attachment } from '../lib/attachments'
import { AttachmentChip, FileGlyph } from './AttachmentChip'

const UPLOADED: Attachment = {
  id: 'shot',
  kind: 'image',
  name: 'Screenshot 14.32.png',
  source: 'file',
  size: 412_000,
  previewUrl: sessionShot,
  state: 'uploaded',
  entry: { ref: 'demo-shot', w: 1440, h: 900, bytes: 412_000 },
  progress: null,
  retries: 0,
}

const FILE: Attachment = {
  ...UPLOADED,
  id: 'file',
  kind: 'file',
  name: 'retry-policy.yaml',
  previewUrl: null,
  size: 2_400,
  entry: { kind: 'file', path: '/Users/demo/code/billing-api/retry-policy.yaml', name: 'retry-policy.yaml', bytes: 2_400 },
}

/** A screenshot the browser extension sent: named for the page, the host where the size goes. */
const BROWSER: Attachment = {
  ...UPLOADED,
  id: 'browser',
  name: 'Webhooks — Billing API reference',
  previewUrl: mapShot,
  entry: { ref: 'demo-browser', w: 1280, h: 800, bytes: 0 },
  browser: {
    title: 'Webhooks — Billing API reference',
    url: 'https://docs.example.com/billing/webhooks#retries',
    at: DEMO_EPOCH - 4 * 60_000,
  },
}

const meta = {
  title: 'Panels/AttachmentChip',
  component: AttachmentChip,
  args: { chip: UPLOADED, onRemove: fn(), onRetry: fn() },
  render: (args) => (
    <div className="flex w-[450px] flex-wrap gap-2">
      <AttachmentChip {...args} />
    </div>
  ),
} satisfies Meta<typeof AttachmentChip>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** The well's chips in each state: resting, uploading (with and before its first tick), failed, failed past the retry budget. */
export const States: Story = {
  render: (args) => (
    <div className="flex w-[450px] flex-wrap gap-2">
      <AttachmentChip {...args} chip={UPLOADED} />
      <AttachmentChip {...args} chip={{ ...UPLOADED, id: 'up', state: 'uploading', entry: undefined, progress: 42 }} />
      <AttachmentChip {...args} chip={{ ...UPLOADED, id: 'tick', state: 'uploading', entry: undefined, progress: null }} />
      <AttachmentChip {...args} chip={{ ...UPLOADED, id: 'fail', state: 'failed', entry: undefined }} />
      <AttachmentChip {...args} chip={{ ...UPLOADED, id: 'spent', state: 'failed', entry: undefined, retries: 3 }} />
    </div>
  ),
}

/** A file rides by path: the square names its kind instead of a thumbnail. */
export const Files: Story = {
  render: (args) => (
    <div className="flex w-[450px] flex-wrap gap-2">
      <AttachmentChip {...args} chip={FILE} />
      <AttachmentChip
        {...args}
        chip={{ ...FILE, id: 'md', name: 'notes.md', entry: { kind: 'file', path: '/tmp/notes.md', name: 'notes.md', bytes: 800 } }}
      />
      <AttachmentChip {...args} chip={{ ...FILE, id: 'bin', name: 'Makefile', state: 'uploading', entry: undefined, progress: 70 }} />
    </div>
  ),
}

/** A photo the phone downscaled: the original size and the sent edge. */
export const Downscaled: Story = {
  args: { chip: { ...UPLOADED, entry: { ref: 'demo-photo', w: 2048, h: 1536, bytes: 610_000 }, original: { w: 4032, h: 3024 } } },
}

/** A browser screenshot; resting on it raises the page card after a beat. */
export const FromTheBrowser: Story = {
  args: { chip: BROWSER },
  render: (args) => (
    <div className="flex w-[450px] flex-wrap gap-2 pt-[110px]">
      <AttachmentChip {...args} />
    </div>
  ),
  play: ({ canvasElement }) => {
    canvasElement
      .querySelector('[data-testid="attachment-chip"]')
      ?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  },
}

/** The kind square at both sizes: a four-letter extension widens it instead of spilling. */
export const Glyphs: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <FileGlyph name="a.ts" />
      <FileGlyph name="config.yaml" />
      <FileGlyph name="Makefile" />
      <FileGlyph name="a.ts" small />
      <FileGlyph name="config.yaml" small />
    </div>
  ),
}
