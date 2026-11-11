import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { BILLING } from '../../../site/demo/fake/fixtures'
import type { FoundFile } from '../lib/findByName'
import type { ApiSession } from '../lib/types'
import { useOrbital } from '../store/store'
import { PathMenu } from './PathMenu'

const CWD = BILLING.cwd

/** The billing session, with WebStorm open on its directory: the menu offers it. */
const SESSION: ApiSession = { ...BILLING, ides: [{ id: 'webstorm', ideName: 'WebStorm', workspaceRoot: CWD }] }

const MATCHES: FoundFile[] = [
  'src/webhooks/sender.ts',
  'src/email/sender.ts',
  'test/webhooks/sender.ts',
  'src/sms/sender.ts',
  'scripts/sender.ts',
  'legacy/v1/sender.ts',
  'legacy/v2/sender.ts',
  'packages/client/src/sender.ts',
  'packages/worker/src/sender.ts',
].map((relative, i) => ({ path: `${CWD}/${relative}`, relative, touched: i === 0 }))

/** The session the menu is about, in the store. */
function seed(): () => void {
  const before = useOrbital.getState()
  useOrbital.setState({ sessions: { [SESSION.id]: SESSION } })
  return () => useOrbital.setState(before, true)
}

const meta = {
  title: 'Panels/PathMenu',
  component: PathMenu,
  beforeEach: seed,
  parameters: { layout: 'fullscreen' },
  args: {
    at: { x: 40, y: 40 },
    sessionId: SESSION.id,
    line: 42,
    picks: 'actions',
    start: { kind: 'file', file: { path: `${CWD}/src/webhooks/sender.ts`, located: true, relative: 'src/webhooks/sender.ts' } },
    onOpen: fn(),
    onRetry: fn(),
    onEditorOpened: fn(),
    onClose: fn(),
  },
  render: (args) => (
    <div style={{ height: 420 }}>
      <PathMenu {...args} />
    </div>
  ),
} satisfies Meta<typeof PathMenu>
export default meta

type Story = StoryObj<typeof meta>

/** A located file: copy, copy relative, the editor, mention in reply. */
export const Actions: Story = {}

/** A path the server could not find: no relative path to copy. */
export const NotLocated: Story = {
  args: { start: { kind: 'file', file: { path: 'src/webhooks/sender.ts', located: false, relative: null } } },
}

/** A bare name with three matches, the touched one marked. */
export const Chooser: Story = {
  args: { picks: 'open', start: { kind: 'choose', choice: { kind: 'matches', name: 'sender.ts', matches: MATCHES.slice(0, 3), more: 0 } } },
}

/** More matches than the chooser lists: the last row counts the rest. */
export const ChooserMore: Story = {
  args: { picks: 'open', start: { kind: 'choose', choice: { kind: 'matches', name: 'sender.ts', matches: MATCHES, more: 4 } } },
}

/** No file by that name. */
export const NoMatch: Story = {
  args: { start: { kind: 'choose', choice: { kind: 'none', name: 'sendr.ts', under: 'billing-api/' } } },
}

/** The device did not answer in time: Try again. */
export const Silent: Story = {
  args: { start: { kind: 'choose', choice: { kind: 'silent', name: 'sender.ts', device: 'build-box' } } },
}
