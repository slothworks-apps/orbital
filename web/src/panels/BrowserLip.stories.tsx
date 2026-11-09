import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ReactNode } from 'react'
import { fn } from 'storybook/test'
import { DEMO_EPOCH } from '../../../site/demo/fake/fixtures'
import type { BrowserSelection } from '../lib/browserBridge'
import type { IdeSelection } from '../lib/types'
import { BrowserLip, lipStack } from './BrowserLip'
import { IDE_SLOT_HEIGHT_PX, IdeSlot } from './IdeSlot'

const SELECTION: BrowserSelection = {
  eventId: 'demo-browser-1',
  text: 'Deliveries are retried up to five times with exponential backoff, starting at 30 seconds.',
  url: 'https://docs.example.com/billing/webhooks#retries',
  title: 'Webhooks — Billing API reference',
  at: DEMO_EPOCH - 60_000,
}

const EDITOR: IdeSelection = {
  filePath: '/Users/demo/code/billing-api/src/webhooks/sender.ts',
  lineStart: 38,
  lineCount: 9,
  text: 'async function deliver(endpoint, payload) {}',
}

const SHOWN = { mounted: true, state: 'entered' } as const

/** The composer's well in the detail panel: the lips ride on its top edge. */
function Well({ children }: { children: ReactNode }) {
  return (
    <div className="w-[450px] pt-[110px]">
      <div className="relative flex min-h-[76px] flex-col justify-between rounded-[10px] border border-line/18 bg-space/60 px-3 pb-2.5 pt-3">
        {children}
        <span className="fs-13 text-ink-900/50">Reply to Claude…</span>
        <span className="font-mono fs-10 text-ink-900/45">⏎ send · ⇧⏎ new line</span>
      </div>
    </div>
  )
}

const meta = {
  title: 'Panels/BrowserLip',
  component: BrowserLip,
  args: {
    selection: SELECTION,
    presence: SHOWN,
    liftPx: 0,
    stackPx: IDE_SLOT_HEIGHT_PX,
    onDismiss: fn(),
  },
  render: (args) => (
    <Well>
      <BrowserLip {...args} />
    </Well>
  ),
} satisfies Meta<typeof BrowserLip>
export default meta

type Story = StoryObj<typeof meta>

/** The browser selection alone on the well's edge. */
export const Alone: Story = {}

/** Resting on the page title raises the whole title, the URL and the length. */
export const Hovered: Story = {
  play: ({ canvasElement }) => {
    canvasElement
      .querySelector('[data-browser-lip-title]')
      ?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  },
}

/** No title: the URL stands in for it. */
export const Untitled: Story = { args: { selection: { ...SELECTION, title: '', text: 'retry' } } }

/** Both lips, the way `lipStack` orders them. */
function StackDemo({ editorSends }: { editorSends: boolean }) {
  const stack = lipStack({ browserUp: true, ideUp: true, ideStanding: editorSends })
  return (
    <Well>
      <IdeSlot
        ideName="WebStorm"
        readout={{ cursor: EDITOR, lip: editorSends ? EDITOR : null }}
        standing={editorSends}
        onDismiss={() => {}}
        liftPx={stack.ideLiftPx}
        under={stack.ideUnder}
        bare={stack.ideBare}
      />
      <BrowserLip
        selection={SELECTION}
        presence={SHOWN}
        liftPx={stack.browserLiftPx}
        stackPx={stack.stackPx}
        onDismiss={() => {}}
      />
    </Well>
  )
}

/** An editor selection too: what will be sent touches the well, browser above editor. */
export const StackedWithEditorSelection: Story = { render: () => <StackDemo editorSends /> }

/** The editor's cursor read-out sends nothing, so it stands bare above the browser row. */
export const StackedWithEditorCursor: Story = { render: () => <StackDemo editorSends={false} /> }
