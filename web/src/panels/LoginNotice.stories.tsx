import type { Meta, StoryObj } from '@storybook/react-vite'
import { screen, userEvent } from 'storybook/test'
import { BILLING, INFRA, QUIET } from '../../../site/demo/fake/fixtures'
import { api } from '../lib/api'
import type { ApiSession, ChatMessage, LoginLostNotice, LoginRun, ProfileLogin } from '../lib/types'
import { useProfileLogins } from '../store/profileLogins'
import { useOrbital } from '../store/store'
import { LoginCardBlock, LoginLostRow, LoginNoticeContext, LoginRestoredRow } from './LoginNotice'

const WORK = 1
const LOST_AT = new Date(Date.now() - 5 * 60_000).toISOString()

/** The session the notice sits in: Orbital's own, on the Work profile, waiting on the login. */
const SESSION: ApiSession = { ...BILLING, claudeDirId: WORK, loginWait: { kind: 'claude', claudeDirId: WORK, running: false, startedBy: null } }

const RUN: LoginRun = {
  kind: 'claude',
  claudeDirId: WORK,
  state: 'running',
  step: 'browser',
  manualOnly: false,
  url: null,
  manualUrl: 'https://claude.ai/oauth/code',
  manualFirst: false,
  startedBy: { deviceId: null, name: 'studio' },
  message: null,
  account: null,
  waiting: [{ sessionId: QUIET[0].id, title: QUIET[0].title ?? '' }],
  startedAt: new Date().toISOString(),
  endedAt: null,
}

/** The Work profile as the Mac answers it: logged out, its last run `run`. */
function profile(run: LoginRun | null): ProfileLogin {
  return {
    claudeDirId: WORK,
    name: 'Work',
    account: { read: true, loggedIn: false, email: null, orgName: null, plan: null },
    design: { read: true, available: true, signedIn: false },
    runs: { claude: run, design: null },
    cliAvailable: true,
  }
}

function lostRow(notice: Partial<LoginLostNotice> = {}): ChatMessage {
  return {
    id: 'login-lost-1',
    role: 'notice',
    text: 'Failed to authenticate: OAuth token has expired · Please run /login',
    timestamp: LOST_AT,
    notice: { level: 'warning', kind: 'login_lost', login: { kind: 'claude', claudeDirId: WORK, email: 'work@example.com', neverLoggedIn: false, ...notice } },
  }
}

const RESTORED: ChatMessage = {
  id: 'login-restored-1',
  role: 'notice',
  timestamp: new Date().toISOString(),
  notice: { level: 'info', kind: 'login_restored', login: { kind: 'claude', email: 'work@example.com', previousEmail: 'work@example.com', continued: true } },
}

/**
 * Seeds the session and answers the profile's login route with `run` — the
 * demo world's server knows no profiles.
 */
function seed(run: LoginRun | null, session: ApiSession = SESSION): () => () => void {
  return () => {
    const before = useOrbital.getState()
    const real = api.profileLogin
    api.profileLogin = () => Promise.resolve(profile(run))
    useOrbital.setState({ sessions: { [session.id]: session, [QUIET[0].id]: QUIET[0] } })
    return () => {
      api.profileLogin = real
      useOrbital.setState(before, true)
      useProfileLogins.setState({ entries: {} })
    }
  }
}

interface LoginNoticeStoryProps {
  /** Which surface draws it: the transcript's row, its restored divider, or the Desk card's block. */
  surface: 'row' | 'restored' | 'card'
  sessionId: string
  message?: ChatMessage
  phone?: boolean
}

/** In the detail panel's column (the Desk card is narrower), as the transcript draws it. */
function LoginNoticeDemo({ surface, sessionId, message = lostRow(), phone = false }: LoginNoticeStoryProps) {
  const session = useOrbital((s) => s.sessions[sessionId])
  return (
    <LoginNoticeContext.Provider value={{ phone, serves: () => true }}>
      <div className={surface === 'card' ? 'w-[280px]' : phone ? 'w-[390px]' : 'w-[450px]'}>
        {surface === 'row' && (
          <LoginLostRow message={message} sessionId={sessionId} place={{ restoredAfter: false, newerLost: false }} />
        )}
        {surface === 'restored' && <LoginRestoredRow message={RESTORED} />}
        {surface === 'card' && session && <LoginCardBlock session={session} offline={false} />}
      </div>
    </LoginNoticeContext.Provider>
  )
}

const meta = {
  title: 'Panels/LoginNotice',
  component: LoginNoticeDemo,
  args: { surface: 'row', sessionId: SESSION.id },
  beforeEach: seed(null),
} satisfies Meta<typeof LoginNoticeDemo>
export default meta

type Story = StoryObj<typeof meta>

/** A: logged out, with the CLI's sentence and Log in. */
export const LoggedOut: Story = {}

/** A profile that never had a login. */
export const NeverLoggedIn: Story = { args: { message: lostRow({ neverLoggedIn: true, email: null }) } }

/** B: the login runs in the browser; the code path folded. */
export const LoggingIn: Story = { beforeEach: seed(RUN) }

/** B · FALLBACK UNFOLDED: the sign-in page and the field for its code. */
export const CodeUnfolded: Story = {
  beforeEach: seed(RUN),
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: /Browser didn’t open/ }))
  },
}

/** Started from another device: its code is entered there. */
export const FromAnotherDevice: Story = {
  beforeEach: seed({ ...RUN, startedBy: { deviceId: 'pixel', name: 'Pixel 8' } }),
}

/** D: the login failed, with its sentence and Log in again. */
export const Failed: Story = {
  beforeEach: seed({ ...RUN, state: 'failed', message: 'The code was not accepted. Try again.', endedAt: new Date().toISOString() }),
}

/** On the phone: the larger box, the dot on the title's first line. */
export const Phone: Story = { args: { phone: true } }

/** C: the past-tense divider once the login is back. */
export const Restored: Story = { args: { surface: 'restored' } }

/** A terminal session's notice: shown, not driven — the way to Settings. */
export const Terminal: Story = {
  args: { sessionId: INFRA.id },
  beforeEach: seed(null, { ...INFRA, claudeDirId: WORK }),
}

/** The Desk card's block (62b): a chip, one sentence, one button. */
export const DeskCard: Story = { args: { surface: 'card' } }

/** The Desk card while the login runs in the browser. */
export const DeskCardRunning: Story = { args: { surface: 'card' }, beforeEach: seed(RUN) }
