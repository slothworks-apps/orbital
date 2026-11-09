import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { Toggle } from '../ui/Checkbox'
import { GhLine } from './GhLine'
import { Row } from './settingsRows'

const meta = {
  title: 'Panels/GhLine',
  component: GhLine,
  args: { status: 'missing', brew: true, onOpenSession: fn() },
  // Under Settings → Appearance's pull-request switch, in its 320px control column.
  render: (args) => (
    <div className="w-[680px]">
      <Row title="Pull request in the header" desc="The branch's pull request beside it, with its state one hover away.">
        <Toggle aria-label="Pull request in the header" checked={false} disabled={args.status !== 'ready'} onChange={() => {}} />
        <GhLine {...args} />
      </Row>
    </div>
  ),
} satisfies Meta<typeof GhLine>
export default meta

type Story = StoryObj<typeof meta>

/** gh is missing and Homebrew is there: the command and Run in Orbital. */
export const NotInstalled: Story = {}

/** gh is installed but not logged in. */
export const LoggedOut: Story = { args: { status: 'logged_out' } }

/** No Homebrew: a link to where gh is installed from. */
export const NoHomebrew: Story = { args: { brew: false } }

/** Run pressed: the session it started, and the way to it. The demo server answers the launch. */
export const Running: Story = {
  play: ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>('button[title^="Starts a new"]')?.click()
  },
}

/** gh is ready: nothing under the switch. */
export const Ready: Story = { args: { status: 'ready' } }
