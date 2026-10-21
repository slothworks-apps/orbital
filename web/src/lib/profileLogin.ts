import type { ApiSession, ChatMessage, LoginKind, LoginLostNotice, LoginRestoredNotice, LoginRun, LoginWait, ProfileLogin } from './types'

/**
 * Log in from Orbital on the web side (spec 2026-10-21-log-in-from-orbital-design;
 * canvas `Feature - Log in` 62a–62h): the words a session stopped on a lost
 * login wears on the map, the Desk and the header, and which of its states
 * the transcript notice draws. Pure, so the one decision every surface reads
 * is tested once.
 *
 * Nothing here counts down or blinks: a login can wait all night
 * (`why-orbital`, "Waiting is fine").
 */

/** The profile as its labels name it: `Work profile`, or `profile` while its name is not known here. */
function profilePhrase(name: string | null): string {
  return name ? `${name} profile` : 'profile'
}

/** Who a running login was started by, as the pill says it: the browser on this Mac, or the device's name. */
function startedByWord(startedBy: string | null): string {
  return startedBy ?? 'browser'
}

/**
 * Every word a session on a continuation list wears (spec § 3 "The session
 * on the map"; canvas 62d "ONE STATE IN FOUR PLACES").
 */
export interface LoginWaitLabels {
  /** Map pill under the name: `log in · Work profile`, `logging in · Pixel 8`. */
  pill: string
  /** Desk card's state pill: `NEEDS LOGIN`, `NEEDS SIGN-IN` while lost; `LOGGING IN`, `SIGNING IN` while it runs (62b). */
  deskPill: string
  /**
   * Detail header. Lost: what follows `NEEDS INPUT · ` (`LOG IN TO WORK
   * PROFILE`). Running: the whole quiet line (`LOGGING IN · PIXEL 8`), drawn
   * the way a limit wait's is.
   */
  header: string
  /** Sidebar row's short column while it runs (`LOGGING IN`); null while lost, which reads NEEDS INPUT. */
  short: string | null
}

export function loginWaitLabels(wait: Pick<LoginWait, 'kind' | 'running' | 'startedBy'>, profileName: string | null): LoginWaitLabels {
  const design = wait.kind === 'design'
  if (wait.running) {
    const verb = design ? 'signing in' : 'logging in'
    const by = startedByWord(wait.startedBy)
    // 62d: "LOGGING IN · IN THE BROWSER", or "LOGGING IN · FROM PIXEL 8".
    const where = wait.startedBy ? `from ${wait.startedBy}` : 'in the browser'
    return { pill: `${verb} · ${by}`, deskPill: verb.toUpperCase(), header: `${verb} · ${where}`.toUpperCase(), short: verb.toUpperCase() }
  }
  return design
    ? { pill: 'sign in · Claude Design', deskPill: 'NEEDS SIGN-IN', header: 'SIGN IN TO CLAUDE DESIGN', short: null }
    : {
        pill: `log in · ${profilePhrase(profileName)}`,
        deskPill: 'NEEDS LOGIN',
        header: `LOG IN TO ${profilePhrase(profileName)}`.toUpperCase(),
        short: null,
      }
}

/**
 * The past-tense divider a restored login folds into (canvas 62a, 62d C):
 * `LOGGED IN AS jan@acme.com · CONTINUED`, `LOGGED IN AS new, NOT old ·
 * CONTINUED` for another account than before (62d edge cases), `SIGNED IN
 * TO CLAUDE DESIGN AS …` for a design sign-in.
 */
export function loginRestoredLabel(
  kind: LoginKind,
  email: string | null,
  previousEmail: string | null,
  continued: boolean,
): string {
  // The words are the divider's caps; an e-mail stays as it is written.
  const tail = continued ? ' · CONTINUED' : ''
  if (kind === 'design') return `${email ? `SIGNED IN TO CLAUDE DESIGN AS ${email}` : 'SIGNED IN TO CLAUDE DESIGN'}${tail}`
  const as = email ? `LOGGED IN AS ${email}` : 'LOGGED IN'
  const other = email && previousEmail && previousEmail.toLowerCase() !== email.toLowerCase() ? `, NOT ${previousEmail}` : ''
  return `${as}${other}${tail}`
}

/** Whether a profile's login of `kind` is in place, as far as a status read has told; null before any read answered. */
export function loggedIn(profile: ProfileLogin | null, kind: LoginKind): boolean | null {
  if (!profile) return null
  if (kind === 'design') return profile.design.read ? profile.design.signedIn : null
  return profile.account.read ? profile.account.loggedIn : null
}

/** The account a profile is logged in to now, for the past-tense line. */
function currentAccount(profile: ProfileLogin | null, kind: LoginKind): string | null {
  if (!profile) return null
  const run = profile.runs[kind]
  if (run?.state === 'succeeded' && run.account) return run.account
  return kind === 'claude' ? profile.account.email : null
}

/** Whether the profile's Mac lets this device log it in: the `manage` grant, and a Mac new enough to serve the routes. */
export type LoginAccess = 'ok' | 'no_grant' | 'older_mac'

/** Where the notice sits in its transcript, as `loginNoticePlaces` reads it. */
export interface LoginNoticePlace {
  /** A `login_restored` of the same kind follows it: the divider says it, the notice draws nothing. */
  restoredAfter: boolean
  /** A newer `login_lost` of the same kind follows it: that one is the live notice. */
  newerLost: boolean
}

/**
 * Which `login_lost` notices are answered, and which is the live one, for
 * every notice row of a transcript, by message id. One pass from the end.
 */
export function loginNoticePlaces(messages: readonly ChatMessage[]): Map<string, LoginNoticePlace> {
  const places = new Map<string, LoginNoticePlace>()
  const restored: Record<LoginKind, boolean> = { claude: false, design: false }
  const lost: Record<LoginKind, boolean> = { claude: false, design: false }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m.role !== 'notice' || !m.notice?.login) continue
    const kind = m.notice.login.kind === 'design' ? 'design' : 'claude'
    if (m.notice.kind === 'login_restored') {
      // A restore answers the lost login just before it, not one after it.
      restored[kind] = true
    } else if (m.notice.kind === 'login_lost') {
      places.set(m.id, { restoredAfter: restored[kind], newerLost: lost[kind] })
      lost[kind] = true
      restored[kind] = false
    }
  }
  return places
}

/**
 * What a `login_lost` notice draws (canvas 62a, 62d "TRANSCRIPT NOTICE"):
 *
 * - `hidden` — a restored divider after it says it already;
 * - `cli` — the CLI's own line as today: a terminal session, shown and not
 *   driven, with the link to Settings → Profiles (62d edge cases); an
 *   answered older notice with the login still out has no link;
 * - `restored` — the quiet past-tense line (62d C), for a notice whose login
 *   is back, live or after a reload;
 * - `lost` — A: Log in, or on another device without the grant or against
 *   an older Mac the line that says where the login can be restored;
 * - `running` — B: the waiting state with the code fallback, Cancel;
 * - `failed` — D: the message and Log in again.
 */
export type LoginNoticeView =
  | { kind: 'hidden' }
  | { kind: 'cli'; link: boolean }
  | { kind: 'restored'; label: string }
  | { kind: 'lost'; access: LoginAccess; neverLoggedIn: boolean; email: string | null; cliAvailable: boolean }
  | { kind: 'running'; run: LoginRun; mine: boolean }
  | { kind: 'failed'; message: string; cliAvailable: boolean }

export interface LoginNoticeInput {
  notice: LoginLostNotice
  /** The row's own time; a run older than the notice is not its answer. */
  timestamp: string | undefined
  place: LoginNoticePlace
  session: Pick<ApiSession, 'source' | 'loginWait'> | undefined
  /** The session's profile, as last read; null before the first answer. */
  profile: ProfileLogin | null
  access: LoginAccess
  /** This device started the running login (only it gets the code field, 62h). */
  startedHere: (run: LoginRun) => boolean
}

const FAILED_FALLBACK = 'The login did not finish. Try again.'

export function loginNoticeView(input: LoginNoticeInput): LoginNoticeView {
  const { notice, place, session, profile, access } = input
  const kind = notice.kind === 'design' ? 'design' : 'claude'
  if (place.restoredAfter) return { kind: 'hidden' }
  // Shown, not driven (spec § 3): the parser emits the notice for every
  // session, and only a session Orbital started draws it as one.
  if (session?.source === 'terminal') return { kind: 'cli', link: !place.newerLost }
  const restored = (): LoginNoticeView => ({
    kind: 'restored',
    label: loginRestoredLabel(kind, currentAccount(profile, kind), notice.email, false),
  })
  const signedIn = loggedIn(profile, kind)
  if (place.newerLost) return signedIn ? restored() : { kind: 'cli', link: false }

  const run = profile?.runs[kind] ?? null
  if (access === 'ok' && run?.state === 'running') return { kind: 'running', run, mine: input.startedHere(run) }
  const waits = session?.loginWait?.kind === kind
  const after = (iso: string | null) =>
    iso !== null && (input.timestamp === undefined || Date.parse(iso) >= Date.parse(input.timestamp))
  if (access === 'ok' && run?.state === 'failed' && after(run.endedAt ?? run.startedAt) && !signedIn) {
    return { kind: 'failed', message: run.message || FAILED_FALLBACK, cliAvailable: profile?.cliAvailable ?? true }
  }
  // An older notice whose login has been restored since (spec § 3): the
  // past-tense line, not a button. A session still on the list waits on it.
  if (signedIn && !waits) return restored()
  return {
    kind: 'lost',
    access,
    neverLoggedIn: notice.neverLoggedIn,
    email: notice.email,
    cliAvailable: profile?.cliAvailable ?? true,
  }
}

/** A `login_restored` row's divider label. */
export function restoredNoticeLabel(notice: LoginRestoredNotice): string {
  return loginRestoredLabel(notice.kind === 'design' ? 'design' : 'claude', notice.email, notice.previousEmail, notice.continued)
}

/**
 * The line under a notice about the other sessions on the same login (62a):
 * before it runs, `api-gateway waits on the same login`; while it runs,
 * `continues api-gateway too when it finishes`. Null when no other session
 * waits on it.
 */
export function waitingLine(run: Pick<LoginRun, 'waiting'> | null, sessionId: string, running: boolean): string | null {
  const others = (run?.waiting ?? []).filter((w) => w.sessionId !== sessionId).map((w) => w.title || 'Untitled session')
  if (others.length === 0) return null
  const names = others.length <= 2 ? others.join(' and ') : `${others[0]} and ${others.length - 1} more`
  return running
    ? `continues ${names} too when it finishes`
    : `${names} ${others.length === 1 ? 'waits' : 'wait'} on the same login`
}

/**
 * The code field's Paste (spec § 6): `navigator.clipboard.readText()`, which
 * the phone's WebView may refuse — no clipboard plugin, since one would be
 * a store build. Null where the browser has no such call at all, so the
 * button is not drawn; a call that throws makes `paste` resolve to null, and
 * the caller hides the button from then on.
 */
export function clipboardReader(
  clipboard: Pick<Clipboard, 'readText'> | undefined = typeof navigator === 'undefined' ? undefined : navigator.clipboard,
): (() => Promise<string | null>) | null {
  if (!clipboard || typeof clipboard.readText !== 'function') return null
  return async () => {
    try {
      const text = await clipboard.readText()
      return text.trim()
    } catch {
      return null
    }
  }
}
