import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { api, ApiError } from '../lib/api'
import type { ClaudeDirInfo, ProfileLogin } from '../lib/types'
import { ClaudeDirsRows } from './ClaudeDirsRows'

const DIRS: ClaudeDirInfo[] = [
  { id: 1, name: 'Work', path: '/Users/demo/.claude-work', overriddenByEnv: false, isDefault: true, exists: true, account: 'work@example.com' },
  { id: 2, name: 'Personal', path: '/Users/demo/.claude', overriddenByEnv: false, isDefault: false, exists: true, account: 'me@example.com' },
  { id: 3, name: 'Client', path: '/Users/demo/.claude-client', overriddenByEnv: false, isDefault: false, exists: false, account: null },
]

function loginOf(dir: ClaudeDirInfo): ProfileLogin {
  const loggedIn = dir.id !== 2
  return {
    claudeDirId: dir.id,
    name: dir.name,
    account: loggedIn
      ? { read: true, loggedIn, email: dir.account, orgName: 'Example Co', plan: 'max' }
      : { read: true, loggedIn, email: null, orgName: null, plan: null },
    design: { read: true, available: true, signedIn: dir.id === 1 },
    runs: { claude: null, design: null },
    cliAvailable: true,
  }
}

/**
 * The profile list and each profile's login answered here, the way this Mac
 * (or another one) answers them; the catalogue's fake server has neither.
 * `refused` answers the list as a Mac that refuses this device does.
 */
function stubProfiles(dirs: ClaudeDirInfo[], refused: 403 | 404 | null = null): () => () => void {
  return () => {
    const realList = api.listClaudeDirs
    const realLogin = api.profileLogin
    api.listClaudeDirs = () =>
      refused ? Promise.reject(new ApiError(refused === 403 ? '{"error":"not_granted"}' : 'Not Found', refused)) : Promise.resolve(dirs)
    api.profileLogin = (id) => Promise.resolve(loginOf(dirs.find((d) => d.id === id) ?? dirs[0]))
    return () => {
      api.listClaudeDirs = realList
      api.profileLogin = realLogin
    }
  }
}

const meta = {
  title: 'Panels/ClaudeDirsRows',
  component: ClaudeDirsRows,
  beforeEach: stubProfiles(DIRS),
  args: { active: true, makeDefault: fn(), onSaved: fn(), macName: 'this Mac' },
  // Settings' content column.
  render: (args) => (
    <div style={{ width: 760 }}>
      <ClaudeDirsRows {...args} />
    </div>
  ),
} satisfies Meta<typeof ClaudeDirsRows>
export default meta

type Story = StoryObj<typeof meta>

/** Three profiles: the default, one logged out, one missing on disk. */
export const ThisMac: Story = {}

/** One profile: no monograms, Remove says it is the last one. */
export const OneProfile: Story = { beforeEach: stubProfiles(DIRS.slice(0, 1)) }

/** Adding a profile: the form in place of the button. */
export const Adding: Story = {
  play: async ({ canvasElement }) => {
    const add = await new Promise<HTMLButtonElement>((resolve) => {
      const find = () => {
        const button = [...canvasElement.querySelectorAll('button')].find((b) => b.textContent?.includes('Add profile'))
        if (button) resolve(button)
        else requestAnimationFrame(find)
      }
      find()
    })
    add.click()
  },
}

/** Another Mac's profiles: read-only rows, the logins from here. */
export const AnotherMac: Story = { args: { machine: 'studio', macName: 'Mac Studio' } }

/** Another Mac that grants this device no upkeep. */
export const NoGrant: Story = { beforeEach: stubProfiles(DIRS, 403), args: { machine: 'studio', macName: 'Mac Studio' } }

/** Another Mac too old to show its profiles here. */
export const OlderMac: Story = { beforeEach: stubProfiles(DIRS, 404), args: { machine: 'studio', macName: 'Mac Studio' } }
