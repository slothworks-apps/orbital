import { afterEach, describe, expect, it } from 'vitest'
import {
  clipboardReader,
  loginAccess,
  loginNoticePlaces,
  loginNoticeView,
  loginRestoredLabel,
  loginWaitLabels,
  waitingLine,
  type LoginNoticeInput,
} from '../lib/profileLogin'
import { sessionStateKey, shownStatus, type ApiSession, type ChatMessage, type LoginRun, type ProfileLogin } from '../lib/types'
import { accountRow } from '../panels/ProfileLoginRow'
import {
  loginEventPlan,
  opensInBrowser,
  profileKey,
  startedByThisRequest,
  succeededNow,
  type ProfileLoginEntry,
} from '../store/profileLogins'
import { useMobile } from '../mobile/state'
import { MAC_FEATURES, sessionServes, sessionSupports } from '../mobile/version'

// Log in from Orbital (spec 2026-10-21-log-in-from-orbital-design): which
// state a lost-login notice draws, and the words its session wears.

const NOTICE_AT = '2026-10-21T10:00:00.000Z'

function run(over: Partial<LoginRun> = {}): LoginRun {
  return {
    kind: 'claude',
    claudeDirId: 2,
    state: 'running',
    step: 'browser',
    manualOnly: false,
    url: null,
    manualUrl: 'https://claude.ai/oauth/authorize?x=1',
    manualFirst: false,
    startedBy: { deviceId: null, name: 'Studio' },
    message: null,
    account: null,
    waiting: [],
    startedAt: '2026-10-21T10:05:00.000Z',
    endedAt: null,
    ...over,
  }
}

function profile(over: { loggedIn?: boolean; read?: boolean; email?: string | null; run?: LoginRun | null } = {}): ProfileLogin {
  return {
    claudeDirId: 2,
    name: 'Work',
    account: {
      read: over.read ?? true,
      loggedIn: over.loggedIn ?? false,
      email: over.email ?? null,
      orgName: null,
      plan: null,
    },
    design: { read: true, available: true, signedIn: false },
    runs: { claude: over.run ?? null, design: null },
    cliAvailable: true,
  }
}

function input(over: Partial<LoginNoticeInput> = {}): LoginNoticeInput {
  return {
    notice: { kind: 'claude', claudeDirId: null, email: 'jan@acme.com', neverLoggedIn: false },
    timestamp: NOTICE_AT,
    place: { restoredAfter: false, newerLost: false },
    session: { source: 'web', loginWait: { kind: 'claude', claudeDirId: 2, running: false, startedBy: null } },
    profile: profile(),
    access: 'ok',
    startedHere: () => true,
    ...over,
  }
}

describe('loginNoticeView', () => {
  it('offers Log in while the login is lost', () => {
    expect(loginNoticeView(input())).toMatchObject({ kind: 'lost', access: 'ok', email: 'jan@acme.com' })
  })

  it('draws the running login, and whether this device started it', () => {
    const view = loginNoticeView(input({ profile: profile({ run: run() }), startedHere: () => false }))
    expect(view).toMatchObject({ kind: 'running', mine: false })
  })

  it('says a failure that came after the notice, and not one from before it', () => {
    const failed = run({ state: 'failed', message: 'That code is wrong or has expired.', endedAt: '2026-10-21T10:06:00.000Z' })
    expect(loginNoticeView(input({ profile: profile({ run: failed }) }))).toMatchObject({
      kind: 'failed',
      message: 'That code is wrong or has expired.',
    })
    const before = run({ state: 'failed', startedAt: '2026-10-21T09:00:00.000Z', endedAt: '2026-10-21T09:01:00.000Z' })
    expect(loginNoticeView(input({ profile: profile({ run: before }) })).kind).toBe('lost')
  })

  // Spec § 3: an older notice whose login has been restored since shows the
  // past-tense line, not a button.
  it('folds into the past-tense line once the login is back and nothing waits on it', () => {
    const view = loginNoticeView(
      input({ profile: profile({ loggedIn: true, email: 'jan@acme.com' }), session: { source: 'web', loginWait: null } }),
    )
    expect(view).toEqual({ kind: 'restored', label: 'LOGGED IN AS jan@acme.com' })
  })

  it('keeps Log in while the session still waits, even if a stale status says logged in', () => {
    expect(loginNoticeView(input({ profile: profile({ loggedIn: true }) })).kind).toBe('lost')
  })

  it('draws nothing where a restored divider follows, and the CLI’s line for an older notice still out', () => {
    expect(loginNoticeView(input({ place: { restoredAfter: true, newerLost: false } }))).toEqual({ kind: 'hidden' })
    expect(loginNoticeView(input({ place: { restoredAfter: false, newerLost: true } }))).toEqual({ kind: 'cli', link: false })
  })

  // Terminal sessions are shown, not driven (spec § 3; canvas 62d edge cases).
  it('leaves a terminal session the CLI’s line with the Settings link', () => {
    expect(loginNoticeView(input({ session: { source: 'terminal', loginWait: null } }))).toEqual({ kind: 'cli', link: true })
  })

  it('has no Log in for a Mac that refuses the grant or is too old, and runs there are not drawn', () => {
    expect(loginNoticeView(input({ access: 'no_grant' }))).toMatchObject({ kind: 'lost', access: 'no_grant' })
    expect(loginNoticeView(input({ access: 'older_mac', profile: profile({ run: run() }) }))).toMatchObject({
      kind: 'lost',
      access: 'older_mac',
    })
  })

  it('treats a status not read yet as unknown, not logged out or in', () => {
    const view = loginNoticeView(input({ profile: profile({ read: false, loggedIn: true }), session: { source: 'web', loginWait: null } }))
    expect(view.kind).toBe('lost')
  })
})

describe('loginNoticePlaces', () => {
  const lost = (id: string, kind: 'claude' | 'design' = 'claude'): ChatMessage => ({
    id,
    role: 'notice',
    notice: { level: 'warning', kind: 'login_lost', login: { kind, claudeDirId: null, email: null, neverLoggedIn: false } },
  })
  const restored = (id: string): ChatMessage => ({
    id,
    role: 'notice',
    notice: { level: 'info', kind: 'login_restored', login: { kind: 'claude', email: 'a@b.c', previousEmail: null, continued: true } },
  })

  it('marks the notice a restore answers, and only the newest of a kind as live', () => {
    const places = loginNoticePlaces([lost('a'), restored('r'), lost('b'), lost('c'), lost('d', 'design')])
    expect(places.get('a')).toEqual({ restoredAfter: true, newerLost: true })
    expect(places.get('b')).toEqual({ restoredAfter: false, newerLost: true })
    expect(places.get('c')).toEqual({ restoredAfter: false, newerLost: false })
    expect(places.get('d')).toEqual({ restoredAfter: false, newerLost: false })
  })
})

describe('the words a login wait wears', () => {
  it('names the profile while lost and the device while it runs', () => {
    expect(loginWaitLabels({ kind: 'claude', running: false, startedBy: null }, 'Work')).toMatchObject({
      pill: 'log in · Work profile',
      deskPill: 'NEEDS LOGIN',
      header: 'LOG IN TO WORK PROFILE',
    })
    expect(loginWaitLabels({ kind: 'claude', running: true, startedBy: null }, 'Work').pill).toBe('logging in · browser')
    expect(loginWaitLabels({ kind: 'claude', running: true, startedBy: 'Pixel 8' }, 'Work').pill).toBe('logging in · Pixel 8')
    expect(loginWaitLabels({ kind: 'design', running: false, startedBy: null }, 'Work').deskPill).toBe('NEEDS SIGN-IN')
  })

  it('says when the login came back as another account, and keeps the e-mails as written', () => {
    expect(loginRestoredLabel('claude', 'new@acme.com', 'Old@acme.com', true)).toBe(
      'LOGGED IN AS new@acme.com, NOT Old@acme.com · CONTINUED',
    )
    expect(loginRestoredLabel('claude', 'jan@acme.com', 'JAN@acme.com', true)).toBe('LOGGED IN AS jan@acme.com · CONTINUED')
  })

  it('lists the other sessions on the same login, never this one', () => {
    const waiting = [
      { sessionId: 's1', title: 'billing-fix' },
      { sessionId: 's2', title: 'api-gateway' },
    ]
    expect(waitingLine({ waiting }, 's1', false)).toBe('api-gateway waits on the same login')
    expect(waitingLine({ waiting }, 's1', true)).toBe('continues api-gateway too when it finishes')
    expect(waitingLine({ waiting: waiting.slice(0, 1) }, 's1', false)).toBeNull()
  })
})

describe('a session stopped on a lost login', () => {
  const base = { status: 'needs_input', subagents: [], pendingDecision: null } as unknown as ApiSession

  it('is NEEDS INPUT while lost, and rests idle while its login runs', () => {
    const lost = { ...base, loginWait: { kind: 'claude', claudeDirId: 1, running: false, startedBy: null } } as ApiSession
    const running = { ...base, loginWait: { kind: 'claude', claudeDirId: 1, running: true, startedBy: null } } as ApiSession
    expect(sessionStateKey(base)).toBe('done')
    expect(sessionStateKey(lost)).toBe('needs_input')
    expect(sessionStateKey(running)).toBe('idle')
    expect(shownStatus(running)).toBe('idle')
    expect(shownStatus({ ...running, status: 'working' })).toBe('working')
  })
})

describe('the Settings row’s account line', () => {
  it('reads the status once answered, and the list’s e-mail until then', () => {
    const row = (login: ProfileLogin | null, listed: string | null) => {
      const r = accountRow(login, listed, false, 'the Mac', () => true)
      return [r.value, r.sub, r.button]
    }
    expect(row(null, 'jan@acme.com')).toEqual(['jan@acme.com', null, null])
    // `.claude.json` still names the lapsed login; the status knows it is gone (spec § 4).
    expect(row(profile({ loggedIn: false }), 'jan@acme.com')).toEqual(['Not logged in', 'was jan@acme.com · OAuth session expired', 'Log in'])
    expect(row(profile({ loggedIn: false }), null)).toEqual(['Not logged in', null, 'Log in'])
    const ok = profile({ loggedIn: true, email: 'jan@acme.com' })
    ok.account.orgName = 'Acme'
    ok.account.plan = 'max'
    expect(row(ok, null)).toEqual(['jan@acme.com', 'Acme · Max', 'Switch account'])
    expect(row(profile({ loggedIn: false, run: run({ state: 'failed', message: 'That code is wrong or has expired.' }) }), 'jan@acme.com')[1]).toBe(
      'That code is wrong or has expired.',
    )
  })
})

describe('starting a login', () => {
  it('opens a design sign-in’s page here, and nothing for a Claude login or one from afar', () => {
    const design = run({ kind: 'design', url: 'http://localhost:5555/cb', manualUrl: 'https://claude.ai/code' })
    expect(opensInBrowser(design)).toBe('http://localhost:5555/cb')
    expect(opensInBrowser({ ...design, manualFirst: true })).toBe('https://claude.ai/code')
    expect(opensInBrowser({ ...design, manualOnly: true })).toBeNull()
    expect(opensInBrowser(run())).toBeNull()
  })

  it('remembers a run as started here only when this request started it', () => {
    const sentAt = Date.parse('2026-10-21T10:05:00.000Z')
    // Started by the request: begun after it was sent, or a little before on a Mac whose clock runs behind.
    expect(startedByThisRequest(run({ startedAt: '2026-10-21T10:05:01.000Z' }), null, sentAt)).toBe(true)
    expect(startedByThisRequest(run({ startedAt: '2026-10-21T10:04:59.000Z' }), null, sentAt)).toBe(true)
    // Already running when the request went: another device's, which keeps its code field.
    const elsewhere = run({ startedAt: '2026-10-21T10:05:01.000Z', startedBy: { deviceId: 'pixel', name: 'Pixel 8' } })
    expect(startedByThisRequest(elsewhere, elsewhere, sentAt)).toBe(false)
    expect(startedByThisRequest(run({ startedAt: '2026-10-21T09:00:00.000Z' }), null, sentAt)).toBe(false)
    // A run that ended before is no reason to doubt a new one; an answer that is not running starts nothing.
    expect(startedByThisRequest(run({ startedAt: '2026-10-21T10:05:01.000Z' }), run({ state: 'failed' }), sentAt)).toBe(true)
    expect(startedByThisRequest(run({ state: 'succeeded', startedAt: '2026-10-21T10:05:01.000Z' }), null, sentAt)).toBe(false)
  })

  it('sees a success once, on the answer that first carries it', () => {
    const before = profile({ run: run() })
    const after = profile({ run: run({ state: 'succeeded', account: 'jan@acme.com' }) })
    expect(succeededNow(before, after)).toBe(true)
    expect(succeededNow(after, after)).toBe(false)
  })
})

describe('the code field’s Paste', () => {
  it('is not offered without a clipboard to read, and reads null where the WebView refuses', async () => {
    expect(clipboardReader(undefined)).toBeNull()
    expect(await clipboardReader({ readText: async () => '  abc#def \n' })!()).toBe('abc#def')
    expect(
      await clipboardReader({
        readText: async () => {
          throw new DOMException('denied', 'NotAllowedError')
        },
      })!(),
    ).toBeNull()
  })
})

describe('the phone against an older Mac', () => {
  afterEach(() => useMobile.setState({ devices: [] }))

  it('logs in only where the session’s own Mac serves the routes', () => {
    useMobile.setState({
      devices: [
        { id: 'old', version: '0.38.2' },
        { id: 'new', version: MAC_FEATURES.profileLogin },
      ] as never,
    })
    expect(sessionSupports('profileLogin', 's-old', () => 'old')).toBe(false)
    expect(sessionSupports('profileLogin', 's-new', () => 'new')).toBe(true)
  })
})

describe('an event on the logins topic', () => {
  const entry = (login: ProfileLogin | null): ProfileLoginEntry => ({ login, refused: null, error: null, busy: {} })

  it('lands in the profile of the member that sent it, without reading it again', () => {
    const entries = { [profileKey(2, 'studio')]: entry(profile()) }
    const event = { event: 'login', login: profile({ run: run() }), machine: 'studio' }
    expect(loginEventPlan(entries, event)).toEqual({ patch: { key: 'studio#2', login: event.login }, reread: [] })
  })

  it('lands in this server’s own profile when no member is named', () => {
    const event = { event: 'login', login: profile({ run: run() }) }
    expect(loginEventPlan({}, event).patch?.key).toBe(profileKey(2))
  })

  it('changes nothing when it says what the entry already holds', () => {
    const held = profile({ run: run() })
    const entries = { [profileKey(2, 'studio')]: entry(held), [profileKey(2, 'laptop')]: entry(null) }
    const plan = loginEventPlan(entries, { event: 'login', login: structuredClone(held), machine: 'studio' })
    expect(plan).toEqual({ patch: null, reread: [] })
  })

  it('reads again a same-id profile on a device whose events never arrive here', () => {
    const entries = {
      [profileKey(2, 'studio')]: entry(profile()),
      [profileKey(2, 'laptop')]: entry(profile()),
      [profileKey(3, 'laptop')]: entry(profile()),
    }
    const plan = loginEventPlan(entries, { event: 'login', login: profile({ run: run() }), machine: 'studio' })
    expect(plan.reread).toEqual([{ claudeDirId: 2, machine: 'laptop' }])
  })

  it('ignores a frame that is not a login', () => {
    expect(loginEventPlan({}, { event: 'other', login: profile() })).toEqual({ patch: null, reread: [] })
    expect(loginEventPlan({}, { event: 'login' })).toEqual({ patch: null, reread: [] })
  })
})

describe('a Mac whose version is not known yet', () => {
  it('draws the notice neither as loggable nor as too old', () => {
    expect(loginAccess(null, null)).toBe('unknown')
    expect(loginAccess(true, null)).toBe('ok')
    expect(loginAccess(false, null)).toBe('older_mac')
    // What the Mac itself said outranks a version not known.
    expect(loginAccess(null, 'older_mac')).toBe('older_mac')
    expect(loginAccess(null, 'no_grant')).toBe('no_grant')
    // A login running is not drawn as running until the access is known.
    const view = loginNoticeView(input({ access: 'unknown', profile: profile({ run: run() }) }))
    expect(view).toMatchObject({ kind: 'lost', access: 'unknown' })
  })

  it('is not known before the device that decides has said hello', () => {
    const devices = [{ id: 'old', version: '0.38.2' }, { id: 'quiet', version: null }] as never
    expect(sessionServes('profileLogin', 's', () => 'quiet', devices, MAC_FEATURES.profileLogin)).toBeNull()
    expect(sessionServes('profileLogin', 's', () => 'old', devices, null)).toBe(false)
    expect(sessionServes('profileLogin', 's', () => null, devices, null)).toBeNull()
    expect(sessionServes('profileLogin', null, () => null, devices, MAC_FEATURES.profileLogin)).toBe(true)
  })
})
