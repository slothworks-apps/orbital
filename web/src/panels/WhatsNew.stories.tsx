import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn, screen, userEvent } from 'storybook/test'
import type { UpdateState } from '../lib/desktop'
import { useAppUpdate } from '../store/appUpdate'
import { useMapNotices } from '../store/mapNotices'
import { MapNoticeHost } from '../ui/MapNoticeHost'
import { showWhatsNewDemo, useWhatsNewNotice } from './WhatsNew'

/** The message as after an update, whatever this browser remembers — the update demo's own way in. */
function afterAnUpdate(): () => void {
  showWhatsNewDemo()
  return () => {
    useAppUpdate.setState({ source: null, state: null, shown: null })
    useMapNotices.setState({ queue: [] })
  }
}

/** After a restart another member made: the receipt heads the message. */
function receipt(): void {
  const state: UpdateState = {
    phase: 'none',
    checkedAt: Date.now(),
    receipt: { by: 'Pixel 8', at: Date.now() - 4 * 60_000, stopped: 2, version: '0.46.0' },
  }
  useAppUpdate.setState({
    state,
    source: {
      onUpdateState: () => {},
      getUpdateState: () => new Promise(() => {}),
      updateAction: fn(),
      checkForUpdates: () => Promise.resolve({ kind: 'up-to-date' }),
    },
  })
}

/** WHAT'S NEW in the map's notice slot, queued by the hook `App` mounts. */
function WhatsNewDemo() {
  useWhatsNewNotice()
  return (
    <div className="relative h-[640px] w-full">
      <MapNoticeHost inWindow />
    </div>
  )
}

const meta = {
  title: 'Panels/WhatsNew',
  component: WhatsNewDemo,
  parameters: { layout: 'fullscreen' },
  beforeEach: afterAnUpdate,
} satisfies Meta<typeof WhatsNewDemo>
export default meta

type Story = StoryObj<typeof meta>

/** 1a: the first lines of this version's changelog, and See all changes. */
export const Toast: Story = {}

/** 50v 04: another member updated this Mac; who and when heads the message. */
export const AfterRemoteUpdate: Story = { beforeEach: receipt }

/** 1b: See all changes — every section, under a dimmed map. */
export const AllChanges: Story = {
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'See all changes' }))
  },
}
