import type { Meta, StoryObj } from '@storybook/react-vite'
import { userEvent } from 'storybook/test'
import { DEMO_EPOCH, INFRA, TAGS } from '../../../site/demo/fake/fixtures'
import type { ApiSession } from '../lib/types'
import { DevicePill } from './DevicePill'

const MINUTE = 60_000

/** The infra session, run on a headless server in the device group. */
const ON_SERVER: ApiSession = {
  ...INFRA,
  machine: { id: 'build-box', name: 'build-box', kind: 'headless', os: 'Ubuntu 24.04', online: true, asOf: null },
}

const OFFLINE: ApiSession = {
  ...ON_SERVER,
  machine: { ...ON_SERVER.machine!, online: false, asOf: DEMO_EPOCH - 12 * MINUTE },
}

const ON_STUDIO: ApiSession = {
  ...INFRA,
  machine: { id: 'studio', name: 'Mac Studio', kind: 'desktop', os: 'macOS 27.2', online: true, asOf: null },
}

/** Hovers the pill: RUNS ON comes up under it. */
const hoverPill: Story['play'] = async ({ canvasElement }) => {
  const pill = canvasElement.querySelector<HTMLElement>('[data-device-pill] > *')
  if (pill) await userEvent.hover(pill)
}

const meta = {
  title: 'Panels/DevicePill',
  component: DevicePill,
  args: { session: ON_SERVER, hue: TAGS[2].hue, placement: 'edge' },
  // The pill rides the docked panel's top edge, in the session's tag hue.
  render: (args) => (
    <div className="pt-6" style={{ height: 240 }}>
      <div className="relative rounded-[14px] border border-line/14 bg-panel/90 px-[22px] pt-5" style={{ width: 450, height: 120 }}>
        {args.placement === 'inline' ? (
          <div className="flex items-center">
            <DevicePill {...args} />
            <span className="font-mono fs-11 text-ink-900/60">{args.session.cwd}</span>
          </div>
        ) : (
          <>
            <DevicePill {...args} />
            <div className="fs-15 font-semibold text-ink-100">{args.session.title}</div>
          </>
        )}
      </div>
    </div>
  ),
} satisfies Meta<typeof DevicePill>
export default meta

type Story = StoryObj<typeof meta>

/** A server online: its name alone. */
export const Online: Story = {}

/** Its RUNS ON card, on hover. */
export const RunsOn: Story = { play: hoverPill }

/** The server went offline: `· offline` on the pill, `seen 12 min ago` on the card. */
export const Offline: Story = { args: { session: OFFLINE }, play: hoverPill }

/** Another Mac, in a detached window's title bar ahead of the path. */
export const Inline: Story = { args: { session: ON_STUDIO, placement: 'inline', hue: TAGS[0].hue } }
