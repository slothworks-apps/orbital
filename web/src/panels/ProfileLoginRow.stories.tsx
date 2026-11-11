import type { Meta, StoryObj } from '@storybook/react-vite'
import { DEMO_EPOCH } from '../../../site/demo/fake/fixtures'
import type { LoginRun, ProfileLogin } from '../lib/types'
import { profileKey, useProfileLogins, type ProfileLoginEntry } from '../store/profileLogins'
import { ProfileLoginRow } from './ProfileLoginRow'

const DIR = { id: 1, name: 'Work', account: 'work@example.com', exists: true }

function login(fields: Partial<ProfileLogin> = {}): ProfileLogin {
  return {
    claudeDirId: DIR.id,
    name: DIR.name,
    account: { read: true, loggedIn: true, email: 'work@example.com', orgName: 'Example Co', plan: 'max' },
    design: { read: true, available: true, signedIn: true },
    runs: { claude: null, design: null },
    cliAvailable: true,
    ...fields,
  }
}

function run(fields: Partial<LoginRun> = {}): LoginRun {
  return {
    kind: 'claude',
    claudeDirId: DIR.id,
    state: 'running',
    step: 'browser',
    manualOnly: false,
    url: null,
    manualUrl: 'https://claude.ai/oauth/code?state=demo',
    manualFirst: false,
    startedBy: { deviceId: null, name: 'this Mac' },
    message: null,
    account: null,
    waiting: [],
    startedAt: new Date(DEMO_EPOCH - 30_000).toISOString(),
    endedAt: null,
    ...fields,
  }
}

const LOGGED_OUT = { read: true, loggedIn: false, email: null, orgName: null, plan: null }

/**
 * The profile's login as the store holds it. The row is drawn with `active`
 * off, so it shows what is seeded instead of reading the catalogue's fake
 * server, which has no logins.
 */
function seedLogin(entry: Partial<ProfileLoginEntry>, machine?: string): () => () => void {
  return () => {
    const before = useProfileLogins.getState()
    useProfileLogins.setState({
      entries: { [profileKey(DIR.id, machine)]: { login: null, refused: null, error: null, busy: {}, ...entry } },
    })
    return () => useProfileLogins.setState(before, true)
  }
}

const meta = {
  title: 'Panels/ProfileLoginRow',
  component: ProfileLoginRow,
  beforeEach: seedLogin({ login: login() }),
  args: { dir: DIR, active: false, macName: 'this Mac' },
  // Under a profile's name in Settings → Profiles.
  render: (args) => (
    <div className="rounded-[11px] border border-line/12 bg-space/45" style={{ width: 760 }}>
      <div className="flex flex-col gap-[5px] py-3 pl-4">
        <span className="fs-13.5 font-semibold text-ink-100">{args.dir.name}</span>
        <span className="font-mono fs-11 text-ink-900/70">~/.claude-work</span>
      </div>
      <ProfileLoginRow {...args} />
    </div>
  ),
} satisfies Meta<typeof ProfileLoginRow>
export default meta

type Story = StoryObj<typeof meta>

/** Logged in, Claude Design signed in: the account with its org and plan, Switch account. */
export const LoggedIn: Story = {}

/** The OAuth session expired: Not logged in, the lit Log in; Claude Design not signed in. */
export const LoggedOut: Story = {
  beforeEach: seedLogin({ login: login({ account: LOGGED_OUT, design: { read: true, available: true, signedIn: false } }) }),
}

/** A login running in the browser this Mac opened, with the code path folded under it. */
export const LoggingIn: Story = {
  beforeEach: seedLogin({ login: login({ account: LOGGED_OUT, runs: { claude: run(), design: null } }) }),
}

/** The code path unfolded: Browser didn't open? */
export const CodeUnfolded: Story = {
  beforeEach: seedLogin({ login: login({ account: LOGGED_OUT, runs: { claude: run(), design: null } }) }),
  play: ({ canvasElement }) => canvasElement.querySelector<HTMLButtonElement>('button[aria-expanded]')?.click(),
}

/** A session started the login: no browser opened, the code is the way. */
export const SessionStarted: Story = {
  beforeEach: seedLogin({
    login: login({
      account: LOGGED_OUT,
      runs: { claude: run({ manualOnly: true, startedBy: { deviceId: null, name: 'Add retry to the webhook sender' } }), design: null },
    }),
  }),
}

/** A failed login: its sentence under Not logged in. */
export const Failed: Story = {
  beforeEach: seedLogin({
    login: login({
      account: LOGGED_OUT,
      runs: { claude: run({ state: 'failed', message: 'The sign-in page closed before the login finished.' }), design: null },
    }),
  }),
}

/** Another Mac's profile, being logged into from its own screen. */
export const OnAnotherMac: Story = {
  beforeEach: seedLogin({ login: login({ account: LOGGED_OUT, runs: { claude: run(), design: null } }) }, 'studio'),
  args: { machine: 'studio', macName: 'Mac Studio' },
}

/** Another Mac that grants this device no upkeep: what is known, and where to log in instead. */
export const NoGrant: Story = {
  beforeEach: seedLogin({ login: login(), refused: 'no_grant' }, 'studio'),
  args: { machine: 'studio', macName: 'Mac Studio' },
}

/** No Claude Code executable known: Log in is disabled. */
export const NoCli: Story = {
  beforeEach: seedLogin({ login: login({ account: LOGGED_OUT, cliAvailable: false }) }),
}
