import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo, useState } from 'react'
import { PdfPageCanvas, PdfPager, usePdfDocument } from './PdfPages'

/**
 * A small PDF built in the page, so the story needs no file: each page a
 * heading bar and lines of different lengths, no fonts (pdf.js would fetch
 * the standard ones). Its own bytes; nothing of the app's chrome.
 */
function demoPdfUrl(pages: number): string {
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages} >>`,
  ]
  for (let p = 0; p < pages; p++) {
    const bars = [`0.15 g 72 ${700 - (p % 3) * 4} ${260 + (p % 4) * 40} 26 re f`]
    for (let line = 0; line < 22; line++) {
      const width = 468 - ((line * 37 + p * 53) % 160)
      bars.push(`0.6 g 72 ${640 - line * 24} ${width} 9 re f`)
    }
    const stream = bars.join('\n')
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + p * 2} 0 R >>`)
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  }
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

/** The maximised view's stage: the rail and the page, ↑ ↓ or the wheel to turn. */
function PagerDemo({ pages, stageHeightPx, maxWidthPx }: { pages: number; stageHeightPx: number; maxWidthPx: number }) {
  const url = useMemo(() => demoPdfUrl(pages), [pages])
  const { doc, aspect, failed } = usePdfDocument(url, `story-${pages}`)
  const [page, setPage] = useState(1)
  if (failed) return <p className="font-mono fs-11 text-ink-900/60">The PDF did not open.</p>
  if (!doc || !aspect) return null
  return (
    <div className="flex items-start justify-center gap-5 bg-space p-6">
      <PdfPager
        doc={doc}
        aspect={aspect}
        page={page}
        onPage={setPage}
        stageHeightPx={stageHeightPx}
        maxWidthPx={maxWidthPx}
      />
    </div>
  )
}

const meta = {
  title: 'Panels/PdfPages',
  component: PagerDemo,
  parameters: { layout: 'fullscreen' },
  args: { pages: 6, stageHeightPx: 620, maxWidthPx: 900 },
} satisfies Meta<typeof PagerDemo>
export default meta

type Story = StoryObj<typeof meta>

export const Pager: Story = {}

/** The third page picked from the rail. */
export const PickedFromTheRail: Story = {
  play: async ({ canvasElement }) => {
    // The document opens asynchronously; wait for the rail before pressing it.
    for (let i = 0; i < 40; i++) {
      const button = canvasElement.querySelector<HTMLButtonElement>('button[aria-label="Page 3"]')
      if (button) {
        button.click()
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  },
}

/** A long document: the rail scrolls, and draws a page only once it is in view. */
export const LongDocument: Story = { args: { pages: 24 } }

function PageDemo() {
  const url = useMemo(() => demoPdfUrl(1), [])
  const { doc } = usePdfDocument(url, 'story-page')
  if (!doc) return null
  return <PdfPageCanvas doc={doc} page={1} heightPx={320} widthPx={247} className="block rounded-[6px] border border-line/16" />
}

/** One page alone, the piece the phone lays out its own way. */
export const OnePage: Story = { render: () => <PageDemo /> }
