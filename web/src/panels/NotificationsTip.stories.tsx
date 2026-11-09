import type { Meta, StoryObj } from '@storybook/react-vite'
import { screen, userEvent } from 'storybook/test'
import { NOTIFICATIONS_TIP_KEY, NOTIFICATIONS_TIP_PENDING } from '@orbital/shared/notifications'
import { BILLING, SETTINGS } from '../../../site/demo/fake/fixtures'
import { useMapNotices } from '../store/mapNotices'
import { useOrbital } from '../store/store'
import { MapNoticeHost } from '../ui/MapNoticeHost'
import { useNotificationsTip } from './NotificationsTip'

/** What makes the tip due: it has not ended, every notification is off, and a session is on the map. */
function due(): () => void {
  const before = useOrbital.getState()
  useOrbital.setState({
    settings: { ...SETTINGS, [NOTIFICATIONS_TIP_KEY]: NOTIFICATIONS_TIP_PENDING },
    sessions: { [BILLING.id]: BILLING },
  })
  return () => {
    useOrbital.setState(before, true)
    useMapNotices.setState({ queue: [] })
  }
}

/** macOS refusing, through the desktop bridge the tip asks. */
function macOsRefuses(): () => void {
  const w = window as { orbitalDesktop?: unknown }
  const before = w.orbitalDesktop
  w.orbitalDesktop = { requestNotificationPermission: () => Promise.resolve('denied') }
  return () => {
    w.orbitalDesktop = before
  }
}

/** The tip in the map's notice slot, queued by the hook `App` mounts. */
function NotificationsTipDemo() {
  useNotificationsTip()
  return (
    <div className="relative h-[320px] w-full">
      <MapNoticeHost inWindow />
    </div>
  )
}

const meta = {
  title: 'Panels/NotificationsTip',
  component: NotificationsTipDemo,
  parameters: { layout: 'fullscreen' },
  beforeEach: due,
} satisfies Meta<typeof NotificationsTipDemo>
export default meta

type Story = StoryObj<typeof meta>

const turnOn = async () => {
  await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }))
}

/** 1a: the offer, Settings → and Turn on. */
export const Offer: Story = {}

/** 1b: after Turn on, exactly what was switched on. */
export const TurnedOn: Story = { play: turnOn }

/** 1d: macOS said no; nothing was switched on, one way out. */
export const Blocked: Story = { beforeEach: macOsRefuses, play: turnOn }
