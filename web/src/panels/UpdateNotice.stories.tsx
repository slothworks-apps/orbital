import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import type { UpdateBridge, UpdateState } from '../lib/desktop'
import { useAppUpdate } from '../store/appUpdate'
import { useMapNotices } from '../store/mapNotices'
import { MapNoticeHost } from '../ui/MapNoticeHost'
import { useAppUpdateNotice } from './UpdateNotice'

/** Main's side of the update, standing in for the desktop bridge: the buttons only log. */
const BRIDGE: UpdateBridge = {
  onUpdateState: () => {},
  getUpdateState: () => new Promise(() => {}),
  updateAction: fn(),
  checkForUpdates: () => Promise.resolve({ kind: 'up-to-date' }),
}

/** Main pushing `state` to this window. */
function shown(state: UpdateState): () => () => void {
  return () => {
    useAppUpdate.setState({ source: BRIDGE, state, shown: state })
    return () => {
      useAppUpdate.setState({ source: null, state: null, shown: null })
      useMapNotices.setState({ queue: [] })
    }
  }
}

const AT = { checkedAt: Date.now() }

/** The UPDATE message in the map's notice slot, queued by the hook `App` mounts. */
function UpdateNoticeDemo() {
  useAppUpdateNotice()
  return (
    <div className="relative h-[320px] w-full">
      <MapNoticeHost inWindow />
    </div>
  )
}

const meta = {
  title: 'Panels/UpdateNotice',
  component: UpdateNoticeDemo,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof UpdateNoticeDemo>
export default meta

type Story = StoryObj<typeof meta>

/** Found, not downloaded: Download, and × skips it. */
export const Available: Story = { beforeEach: shown({ ...AT, phase: 'available', version: '0.47.0', totalMB: 142 }) }

/** The download under way, with its progress. */
export const Downloading: Story = {
  beforeEach: shown({ ...AT, phase: 'downloading', version: '0.47.0', percent: 38, totalMB: 142 }),
}

/** Downloaded, nothing working: one Restart. */
export const Ready: Story = {
  beforeEach: shown({ ...AT, phase: 'ready', version: '0.47.0', workingCount: 0, buttons: 'one' }),
}

/** Downloaded while sessions work: Restart now, or when they finish. */
export const ReadyWithSessionsWorking: Story = {
  beforeEach: shown({ ...AT, phase: 'ready', version: '0.47.0', workingCount: 3, buttons: 'two' }),
}

/** × on Ready: it installs on quit, with OK. */
export const InstallsOnQuit: Story = { beforeEach: shown({ ...AT, phase: 'closed', version: '0.47.0' }) }

/** Another member started the update here, to run once the sessions finish. */
export const RemoteWaiting: Story = {
  beforeEach: shown({
    ...AT,
    phase: 'waiting',
    version: '0.47.0',
    workingCount: 2,
    remote: { by: 'Pixel 8', working: 2, wait: true },
  }),
}
