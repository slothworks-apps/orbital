import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { fn } from 'storybook/test'
import mapShot from '../../../site/public/demo-images/map.webp'
import phoneShot from '../../../site/public/demo-images/phone-answer.webp'
import sessionShot from '../../../site/public/demo-images/session.webp'
import { BILLING, DEMO_EPOCH } from '../../../site/demo/fake/fixtures'
import { apiFileImagePath, apiImagePath, configureImages } from '../lib/images'
import { mediaTiles, type MediaSourceKey } from '../lib/media'
import type { MediaItem } from '../lib/types'
import {
  GoneMark,
  MediaTileButton,
  NothingShown,
  PdfTag,
  SourcesButton,
  TileCaption,
  type TileVariant,
} from './MediaParts'

/** A one-page PDF built in the page, for the PDF tile's first page: bars, no fonts. */
function demoPdfUrl(): string {
  const stream = ['0.15 g 72 700 300 26 re f', ...Array.from({ length: 20 }, (_, i) => `0.6 g 72 ${640 - i * 26} ${468 - ((i * 41) % 150)} 9 re f`)].join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return URL.createObjectURL(new Blob([out], { type: 'application/pdf' }))
}

const at = (minutesAgo: number) => new Date(DEMO_EPOCH - minutesAgo * 60_000).toISOString()
const CWD = BILLING.cwd

/** A session's media, oldest first, from every source. */
const ITEMS: MediaItem[] = [
  { id: 'm1:0', kind: 'image', source: 'you', messageId: 'm1', ts: at(40), ref: 'you-shot', w: 1440, h: 900 },
  { id: 'm4:0', kind: 'image', source: 'tool', messageId: 'm4', ts: at(31), ref: 'tool-1', toolRun: 'run-1', tool: 'mcp__playwright__browser_take_screenshot' },
  { id: 'm4:1', kind: 'image', source: 'tool', messageId: 'm4', ts: at(30), ref: 'tool-2', toolRun: 'run-1', tool: 'mcp__playwright__browser_take_screenshot' },
  { id: 'm4:2', kind: 'image', source: 'tool', messageId: 'm4', ts: at(29), ref: 'tool-3', toolRun: 'run-1', tool: 'mcp__playwright__browser_take_screenshot' },
  { id: 'm6:0', kind: 'image', source: 'agent', messageId: 'm6', ts: at(22), path: 'docs/screens/retry-dashboard.png', cwd: CWD, disk: 'present' },
  { id: 'm7:0', kind: 'pdf', source: 'agent', messageId: 'm7', ts: at(18), path: 'docs/webhook-retries.pdf', cwd: CWD, disk: 'present' },
  { id: 'm8:0', kind: 'image', source: 'agent', messageId: 'm8', ts: at(12), path: 'tmp/old-chart.png', cwd: CWD, disk: 'missing' },
  { id: 'm9:0', kind: 'image', source: 'written', messageId: 'm9', ts: at(8), path: 'out/latency-p95.png', cwd: CWD, tool: 'Write' },
  {
    id: 'm10:0',
    kind: 'image',
    source: 'tool',
    messageId: 'm10',
    ts: at(4),
    ref: 'moon-shot',
    tool: 'mcp__playwright__browser_take_screenshot',
    subagent: { toolUseId: 'agent-1', name: 'Check the retry dashboard' },
  },
]

const REFS: Record<string, string> = {
  'you-shot': sessionShot,
  'tool-1': mapShot,
  'tool-2': sessionShot,
  'tool-3': phoneShot,
  'moon-shot': phoneShot,
}

/** Bytes for the demo's refs and paths, and the app's own resolvers back afterwards. */
const withDemoImages = () => {
  const pdf = demoPdfUrl()
  configureImages({
    resolve: (ref) => REFS[ref] ?? mapShot,
    resolvePath: (_session, path) => (path.endsWith('.pdf') ? pdf : mapShot),
  })
  return () => {
    configureImages({ resolve: apiImagePath, resolvePath: apiFileImagePath })
    URL.revokeObjectURL(pdf)
  }
}

/** The glance (in the detail panel's popover) or the gallery's grid of tiles. */
function GridDemo({ variant, hidden = [] }: { variant: TileVariant; hidden?: MediaSourceKey[] }) {
  const glance = variant === 'glance'
  return (
    <div className={glance ? 'grid w-[420px] grid-cols-4 gap-2.5' : 'grid w-[760px] grid-cols-6 gap-3'}>
      {mediaTiles(ITEMS, hidden).map((tile) => (
        <MediaTileButton key={tile.key} sessionId={BILLING.id} tile={tile} variant={variant} onOpen={() => {}} />
      ))}
    </div>
  )
}

const meta = {
  title: 'Panels/MediaParts',
  component: GridDemo,
  args: { variant: 'glance' },
  beforeEach: withDemoImages,
} satisfies Meta<typeof GridDemo>
export default meta

type Story = StoryObj<typeof meta>

/**
 * The glance's tiles: yours, a stacked tool run (⚙ ×3), a named file, a PDF,
 * one no longer on disk, one saved by the agent, and a moon's.
 */
export const GlanceTiles: Story = {}

/** The gallery's tiles carry the time top-right. */
export const GalleryTiles: Story = { args: { variant: 'gallery' } }

/** Sources ▾ holding its own filter, over the grid it narrows. */
function SourcesDemo({ initial }: { initial: MediaSourceKey[] }) {
  const [hidden, setHidden] = useState<MediaSourceKey[]>(initial)
  const shown = mediaTiles(ITEMS, hidden)
  return (
    <div className="flex h-[480px] w-[420px] flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="flex-1 font-mono fs-10 tracking-[0.14em] text-ink-900/60">MEDIA</span>
        <SourcesButton items={ITEMS} hidden={hidden} onChange={setHidden} />
      </div>
      {shown.length === 0 ? (
        <NothingShown hidden={ITEMS.length} onShowAll={() => setHidden([])} className="h-40" />
      ) : (
        <div className="grid grid-cols-4 gap-2.5">
          {shown.map((tile) => (
            <MediaTileButton key={tile.key} sessionId={BILLING.id} tile={tile} variant="glance" onOpen={() => {}} />
          ))}
        </div>
      )}
    </div>
  )
}

/** The Sources list, open: every source with its count; the filter is live under it. */
export const Sources: Story = {
  render: () => <SourcesDemo initial={['tool']} />,
  play: ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.click()
  },
}

/** The one real empty state: the filter hides everything. */
export const NothingFromTheseSources: Story = {
  render: () => <SourcesDemo initial={['you', 'tool', 'named', 'saved', 'subagent']} />,
}

/** The parts on their own: the gone footprint at its three sizes, the PDF tag, captions. */
export const Pieces: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <div className="flex items-end gap-4">
        <span className="flex h-[96px] w-[96px] flex-col items-center justify-center gap-[5px] rounded-[6px] border border-line/10 bg-space">
          <GoneMark size="tile" />
        </span>
        <span className="flex h-[120px] w-[200px] flex-col items-center justify-center gap-2 rounded-[8px] border border-line/10 bg-space">
          <GoneMark size="reply" />
        </span>
        <span className="flex h-[200px] w-[320px] flex-col items-center justify-center gap-3 rounded-[10px] border border-line/10 bg-space">
          <GoneMark size="dialog" />
        </span>
      </div>
      <div className="flex gap-4">
        <span className="relative block h-[96px] w-[76px] rounded-[6px] border border-line/14 bg-space">
          <PdfTag pages={null} />
        </span>
        <span className="relative block h-[96px] w-[76px] rounded-[6px] border border-line/14 bg-space">
          <PdfTag pages={12} />
        </span>
      </div>
      <div className="flex w-[110px] flex-col gap-2">
        <TileCaption caption={{ text: 'docs/screens/retry-dashboard-after-the-fix.png', named: true, moon: false }} className="fs-9" />
        <TileCaption caption={{ text: 'Attached by you', named: false, moon: false }} className="fs-9" />
        <TileCaption caption={{ text: 'Check the retry dashboard', named: false, moon: true }} className="fs-9" />
      </div>
      <div className="flex">
        <SourcesButton items={ITEMS} hidden={[]} onChange={fn()} />
      </div>
    </div>
  ),
}
