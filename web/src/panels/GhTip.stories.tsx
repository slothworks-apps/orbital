import type { Meta, StoryObj } from '@storybook/react-vite'
import { SETTINGS } from '../../../site/demo/fake/fixtures'
import { api } from '../lib/api'
import { useMapNotices } from '../store/mapNotices'
import { useOrbital } from '../store/store'
import { MapNoticeHost } from '../ui/MapNoticeHost'
import { useGhTip } from './GhTip'

/**
 * What makes the tip due: settings in, and the server saying `gh` is missing
 * with Homebrew there to install it. The demo world's server says `gh` is
 * ready, so the answer is stood in here.
 */
function ghMissing(): () => void {
  const before = useOrbital.getState()
  const real = api.ghStatus
  api.ghStatus = () => Promise.resolve({ status: 'missing', brew: true })
  useOrbital.setState({ settings: SETTINGS, settingsLoaded: true })
  return () => {
    api.ghStatus = real
    useOrbital.setState(before, true)
    useMapNotices.setState({ queue: [] })
  }
}

/** The tip in the map's notice slot, queued by the hook `App` mounts. */
function GhTipDemo() {
  useGhTip()
  return (
    <div className="relative h-[320px] w-full">
      <MapNoticeHost inWindow />
    </div>
  )
}

const meta = {
  title: 'Panels/GhTip',
  component: GhTipDemo,
  parameters: { layout: 'fullscreen' },
  beforeEach: ghMissing,
} satisfies Meta<typeof GhTipDemo>
export default meta

type Story = StoryObj<typeof meta>

/** TIP · GITHUB CLI: what `gh` adds, and Install beside what it runs. */
export const Offer: Story = {}
