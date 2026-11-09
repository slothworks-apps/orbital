import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { Button } from './Button'
import { MapNotice, MapNoticeList, MapNoticeProgress, MapNoticeText } from './MapNotice'

const meta = {
  title: 'UI/MapNotice',
  component: MapNotice,
  args: {
    label: 'NOTIFICATIONS · OFF',
    onClose: fn(),
    actions: (
      <>
        <Button variant="ghost" size="notice">
          Not now
        </Button>
        <Button variant="primary" size="notice">
          Turn on
        </Button>
      </>
    ),
    children: (
      <MapNoticeText>
        Orbital can tell you when a session needs your input. macOS has its notifications turned off.
      </MapNoticeText>
    ),
  },
  render: (args) => (
    <div className="w-[540px]">
      <MapNotice {...args} />
    </div>
  ),
} satisfies Meta<typeof MapNotice>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** A changelog notice: its lines after muted dashes. */
export const List: Story = {
  args: {
    label: "WHAT'S NEW · 0.46.0",
    actions: (
      <Button variant="ghost" size="notice">
        All changes
      </Button>
    ),
    children: (
      <MapNoticeList
        items={[
          'Planets keep their tag colour after a restart.',
          "What's new spans every version you skipped.",
          'The media viewer follows the window’s width.',
        ]}
      />
    ),
  },
}

/** A download in progress: no ×, the line and its read-out. */
export const Progress: Story = {
  args: {
    label: 'UPDATE · 0.46.0',
    onClose: undefined,
    actions: undefined,
    children: (
      <>
        <MapNoticeText>Downloading the update. Orbital keeps running.</MapNoticeText>
        <MapNoticeProgress percent={62} readout="58 / 94 MB" />
      </>
    ),
  },
}

/** No actions, only the message and ×. */
export const TextOnly: Story = {
  args: {
    label: 'RELAY · OFFLINE',
    actions: undefined,
    children: <MapNoticeText>The phone can't reach this Mac until the relay is back.</MapNoticeText>,
  },
}
