import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ReactNode } from 'react'
import { fn } from 'storybook/test'
import type { IdeSelection } from '../lib/types'
import { IdeSlot } from './IdeSlot'

const CURSOR: IdeSelection = {
  filePath: '/Users/demo/code/billing-api/src/webhooks/sender.ts',
  lineStart: 42,
  lineCount: 1,
  text: null,
}

const SELECTION: IdeSelection = {
  ...CURSOR,
  lineStart: 38,
  lineCount: 9,
  text: 'async function deliver(endpoint, payload) {\n  await post(endpoint.url, payload)\n}',
}

/** The composer's well in the detail panel: the slot rides on its top edge. */
function Well({ children }: { children: ReactNode }) {
  return (
    <div className="w-[450px] pt-16">
      <div className="relative flex min-h-[76px] flex-col justify-between rounded-[10px] border border-line/18 bg-space/60 px-3 pb-2.5 pt-3">
        {children}
        <span className="fs-13 text-ink-900/50">Reply to Claude…</span>
        <span className="font-mono fs-10 text-ink-900/45">⏎ send · ⇧⏎ new line</span>
      </div>
    </div>
  )
}

const meta = {
  title: 'Panels/IdeSlot',
  component: IdeSlot,
  args: {
    ideName: 'WebStorm',
    readout: { cursor: CURSOR, lip: null },
    standing: false,
    onDismiss: fn(),
  },
  render: (args) => (
    <Well>
      <IdeSlot {...args} />
    </Well>
  ),
} satisfies Meta<typeof IdeSlot>
export default meta

type Story = StoryObj<typeof meta>

/** Cursor only: the file and line, nothing to refuse. */
export const Cursor: Story = {}

/** A selection: the count, the file and the × that drops it. */
export const Selection: Story = {
  args: { readout: { cursor: SELECTION, lip: SELECTION }, standing: true },
}

/** A long file name is elided in the middle; the editor's name is never cut. */
export const LongFileName: Story = {
  args: {
    ideName: 'Visual Studio Code',
    readout: {
      cursor: { ...SELECTION, filePath: '/Users/demo/code/billing-api/src/webhooks/exponentialBackoffRetryScheduler.test.ts' },
      lip: { ...SELECTION, filePath: '/Users/demo/code/billing-api/src/webhooks/exponentialBackoffRetryScheduler.test.ts' },
    },
    standing: true,
  },
}

/** No editor reading yet: nothing at all, the well as it ships. */
export const NoReading: Story = { args: { readout: { cursor: null, lip: null } } }
