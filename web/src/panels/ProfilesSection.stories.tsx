import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { api } from '../lib/api'
import type { ClaudeDirInfo, ProfileLogin } from '../lib/types'
import { useOrbital, type OrbitalState } from '../store/store'
import { ProfilesSection } from './ProfilesSection'

const DIRS: ClaudeDirInfo[] = [
  { id: 1, name: 'Work', path: '/Users/demo/.claude-work', overriddenByEnv: false, isDefault: true, exists: true, account: 'work@example.com' },
  { id: 2, name: 'Personal', path: '/Users/demo/.claude', overriddenByEnv: false, isDefault: false, exists: true, account: 'me@example.com' },
]

const LOGIN: ProfileLogin = {
  claudeDirId: 1,
  name: 'Work',
  account: { read: true, loggedIn: true, email: 'work@example.com', orgName: 'Example Co', plan: 'max' },
  design: { read: true, available: true, signedIn: true },
  runs: { claude: null, design: null },
  cliAvailable: true,
}

/**
 * The device group as Settings reads it — only the members' fields the
 * device row reads: this Mac, a server online, a Mac Studio offline.
 */
const GROUP = {
  group: {
    members: [
      { id: 'self', name: 'MacBook Pro', kind: 'desktop', os: 'macOS 27.2', self: true, state: 'self', tooOld: false, seenAt: null },
      { id: 'build-box', name: 'build-box', kind: 'headless', os: 'Ubuntu 24.04', self: false, state: 'online', tooOld: false, seenAt: null },
      { id: 'studio', name: 'Mac Studio', kind: 'desktop', os: 'macOS 27.1', self: false, state: 'offline', tooOld: false, seenAt: Date.now() - 2 * 60 * 60_000 },
    ],
  },
} as unknown as OrbitalState['remote']

/** Every device's profiles answered from `DIRS`; the catalogue's fake server has none. */
function seed(remote: OrbitalState['remote']): () => () => void {
  return () => {
    const before = useOrbital.getState()
    const realList = api.listClaudeDirs
    const realLogin = api.profileLogin
    api.listClaudeDirs = () => Promise.resolve(DIRS)
    api.profileLogin = (id) => {
      const dir = DIRS.find((d) => d.id === id) ?? DIRS[0]
      return Promise.resolve({ ...LOGIN, claudeDirId: id, name: dir.name, account: { ...LOGIN.account, email: dir.account } })
    }
    useOrbital.setState({ remote })
    return () => {
      useOrbital.setState(before, true)
      api.listClaudeDirs = realList
      api.profileLogin = realLogin
    }
  }
}

const meta = {
  title: 'Panels/ProfilesSection',
  component: ProfilesSection,
  beforeEach: seed(null),
  args: { active: true, makeDefault: fn(), onSaved: fn() },
  // Settings' content column.
  render: (args) => (
    <div className="px-8" style={{ width: 824 }}>
      <ProfilesSection {...args} />
    </div>
  ),
} satisfies Meta<typeof ProfilesSection>
export default meta

type Story = StoryObj<typeof meta>

/** This Mac alone: its profiles, no device row. */
export const ThisMacOnly: Story = {}

/** In a device group: a row of devices over the list, the offline Mac inert. */
export const InAGroup: Story = { beforeEach: seed(GROUP) }
