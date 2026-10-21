import { useEffect } from 'react'
import { create } from 'zustand'
import { PROFILE_LOGINS_TOPIC } from '@orbital/shared/profileLogins'
import { api, ApiError, errorSentence, type ProfileLoginRefusal } from '../lib/api'
import { recordError } from '../lib/errors'
import { getSocket } from '../lib/socket'
import type { LoginKind, LoginRun, ProfileLogin } from '../lib/types'
import { useOrbital } from './store'

/**
 * Each profile's logins as this window last heard them (spec
 * 2026-10-21-log-in-from-orbital-design § 2): what the Settings row and
 * every notice of the profile draw from, so a login started in one place is
 * followed in all of them.
 *
 * A profile is keyed by the device it is on and its id there: profile ids
 * are a device's own, and two Macs both have a profile 1. `machine` is
 * undefined for this device's own.
 *
 * Read when a surface that shows it mounts, again on every reconnect, and
 * followed on `PROFILE_LOGINS_TOPIC` in between (`loginEventPlan`). A
 * member's profile is also read again whenever a session waiting on it
 * changes (`useProfileLogin`), which is how its end arrives on a device
 * whose topic does not carry it.
 */

/** The store's key for a profile: its device and its id there. */
export function profileKey(claudeDirId: number, machine?: string | null): string {
  return `${machine ?? ''}#${claudeDirId}`
}

export interface ProfileLoginEntry {
  login: ProfileLogin | null
  /**
   * The Mac refused this device the `manage` grant, or is older than the
   * routes and does not know them (canvas 62e, 62g): the notice and the row
   * say where to log in instead.
   */
  refused: 'no_grant' | 'older_mac' | null
  /** The last action's refusal or failure, said where it was asked; cleared by the next action. */
  error: string | null
  /** An action is on its way, per kind. */
  busy: Partial<Record<LoginKind, boolean>>
}

const EMPTY_ENTRY: ProfileLoginEntry = { login: null, refused: null, error: null, busy: {} }

interface ProfileLoginsState {
  entries: Record<string, ProfileLoginEntry>
  /**
   * Counts the logins seen to succeed. A success changes the account the
   * profile list names (spec § 2: no topic carries the list), so whatever
   * shows it reads it again when this moves.
   */
  succeeded: number
}

export const useProfileLogins = create<ProfileLoginsState>(() => ({ entries: {}, succeeded: 0 }))

function patch(key: string, next: Partial<ProfileLoginEntry>): void {
  const before = useProfileLogins.getState().entries[key]?.login ?? null
  const success = next.login != null && succeededNow(before, next.login)
  useProfileLogins.setState((s) => ({
    entries: { ...s.entries, [key]: { ...(s.entries[key] ?? EMPTY_ENTRY), ...next } },
    succeeded: success ? s.succeeded + 1 : s.succeeded,
  }))
  // The marks and the pickers read the names and accounts from the store.
  if (success) void useOrbital.getState().loadClaudeDirs()
}

function setBusy(key: string, kind: LoginKind, busy: boolean): void {
  const entry = useProfileLogins.getState().entries[key] ?? EMPTY_ENTRY
  patch(key, { busy: { ...entry.busy, [kind]: busy } })
}

/** An answer of any login route, refusal or not, as the entry keeps it. */
function land(key: string, answer: ProfileLogin | { error: ProfileLoginRefusal }): ProfileLogin | null {
  if ('error' in answer) {
    if (answer.error === 'not_granted') patch(key, { refused: 'no_grant' })
    else patch(key, { error: refusalSentence(answer.error) })
    return null
  }
  patch(key, { login: answer, refused: null })
  return answer
}

/**
 * Why another Mac refused a profile route, from the error it threw: this
 * device lacks the `manage` grant (`not_granted`), or the Mac is older than
 * the route — its 404, or its allowlist's `not_allowed` for a route it does
 * not list. Null for any other failure. The login routes and Settings →
 * Profiles' list read a refusal the same way.
 */
export function refusalOf(err: unknown): 'no_grant' | 'older_mac' | null {
  if (!(err instanceof ApiError)) return null
  if (err.status === 404) return 'older_mac'
  if (err.status !== 403) return null
  const reason = errorSentence(err, '')
  return reason === 'not_granted' ? 'no_grant' : reason === 'not_allowed' ? 'older_mac' : null
}

/** A refused action, as one plain sentence where it was asked. */
export function refusalSentence(error: ProfileLoginRefusal): string {
  switch (error) {
    case 'no_cli':
      return 'Orbital does not know a Claude Code executable on this Mac.'
    case 'no_login':
      return 'That login has ended. Log in again.'
    case 'bad_code':
      return 'That does not look like a sign-in code.'
    case 'not_found':
      return 'That profile was removed in the meantime.'
    case 'bad_kind':
    case 'not_granted':
      return 'The Mac refused the login.'
  }
}

/** Reads the profile's logins; a failed read keeps what was there. */
export async function readProfileLogin(claudeDirId: number, machine?: string): Promise<void> {
  const key = profileKey(claudeDirId, machine)
  try {
    land(key, await api.profileLogin(claudeDirId, machine))
  } catch (err) {
    const refused = refusalOf(err)
    if (refused) patch(key, { refused })
    else recordError(err, 'Could not read the profile’s login')
  }
}

// ---- Which runs this device started ----------------------------------------

/**
 * Only the device that started a login gets its code field (canvas 62h,
 * *Another device is entering the code*). A run started on the Mac itself
 * says so (`startedBy.deviceId` null); one started from another device names
 * that device by an id this web app does not know for itself, so the runs it
 * started are remembered here, by profile, kind and start, across a reload.
 */
const STARTED_KEY = 'orbital.loginsStartedHere'
const STARTED_KEPT = 20

function startedHereList(): string[] {
  try {
    const raw = localStorage.getItem(STARTED_KEY)
    const list: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function rememberStarted(key: string, run: LoginRun): void {
  const mark = `${key}|${run.kind}|${run.startedAt}`
  const list = startedHereList().filter((m) => m !== mark)
  list.push(mark)
  try {
    localStorage.setItem(STARTED_KEY, JSON.stringify(list.slice(-STARTED_KEPT)))
  } catch {
    // Without storage the field shows until a reload, which is all it costs.
  }
}

/** Whether this device started `run` of the profile at `key`. */
export function startedHere(key: string, run: LoginRun, remote: boolean): boolean {
  if (!remote && run.startedBy.deviceId === null) return true
  return startedHereList().includes(`${key}|${run.kind}|${run.startedAt}`)
}

// ---- The three actions -----------------------------------------------------

async function act(
  claudeDirId: number,
  kind: LoginKind,
  machine: string | undefined,
  call: () => Promise<ProfileLogin | { error: ProfileLoginRefusal }>,
  failure: string,
): Promise<ProfileLogin | null> {
  const key = profileKey(claudeDirId, machine)
  if (useProfileLogins.getState().entries[key]?.busy[kind]) return null
  setBusy(key, kind, true)
  patch(key, { error: null })
  try {
    return land(key, await call())
  } catch (err) {
    const refused = refusalOf(err)
    if (refused) patch(key, { refused })
    else {
      recordError(err, failure)
      patch(key, { error: errorSentence(err, failure) })
    }
    return null
  } finally {
    setBusy(key, kind, false)
  }
}

/**
 * Log in (spec § 1): starts the login, or answers the one running. Started
 * here, the CLI opens this Mac's browser for a Claude login itself; a design
 * sign-in hands its URL to the web, which opens it — `url` on this Mac, the
 * code page on another device (`opensInBrowser`).
 */
export async function startLogin(claudeDirId: number, kind: LoginKind, machine?: string): Promise<void> {
  const key = profileKey(claudeDirId, machine)
  const before = useProfileLogins.getState().entries[key]?.login?.runs[kind] ?? null
  const sentAt = Date.now()
  const login = await act(claudeDirId, kind, machine, () => api.startProfileLogin(claudeDirId, kind, machine), 'Could not start the login')
  const run = login?.runs[kind]
  if (!run || !startedByThisRequest(run, before, sentAt)) return
  rememberStarted(key, run)
  const open = opensInBrowser(run)
  if (open) openSignInPage(open)
}

/**
 * How far the Mac's clock may run behind this device's and a run it just
 * started still count as started by the request. Generous: a clock off by
 * more would cost the device that pressed Log in its own code field, while
 * a run started elsewhere just before is almost always in the store already
 * (the topic told it).
 */
const START_SKEW_MS = 60_000

/**
 * Whether the run Log in answered with is the one that request started, not
 * one already running that it only reports (spec § 1): the device that
 * started that one keeps its code field, and nothing opens here. A run this
 * window already knew as running is not new; one that began before the
 * request was sent, give or take `START_SKEW_MS`, is not either.
 */
export function startedByThisRequest(
  run: Pick<LoginRun, 'state' | 'startedAt'>,
  before: Pick<LoginRun, 'state' | 'startedAt'> | null,
  sentAt: number,
): boolean {
  if (run.state !== 'running') return false
  if (before?.state === 'running' && before.startedAt === run.startedAt) return false
  const started = Date.parse(run.startedAt)
  return Number.isFinite(started) && started >= sentAt - START_SKEW_MS
}

/** The page a just-started login opens by itself, or null when the CLI opens it (a Claude login on this Mac) or nothing should. */
export function opensInBrowser(run: Pick<LoginRun, 'kind' | 'manualOnly' | 'url' | 'manualUrl' | 'manualFirst'>): string | null {
  if (run.kind !== 'design' || run.manualOnly) return null
  return (run.manualFirst ? run.manualUrl : run.url) ?? null
}

/** Opens a sign-in page: the desktop app and the phone's shell both hand a new window to the system browser. */
export function openSignInPage(url: string): void {
  window.open(url, '_blank', 'noopener')
}

export async function submitLoginCode(claudeDirId: number, kind: LoginKind, code: string, machine?: string): Promise<void> {
  await act(claudeDirId, kind, machine, () => api.submitProfileLoginCode(claudeDirId, kind, code, machine), 'Could not hand over the code')
}

export async function cancelLogin(claudeDirId: number, kind: LoginKind, machine?: string): Promise<void> {
  await act(claudeDirId, kind, machine, () => api.cancelProfileLogin(claudeDirId, kind, machine), 'Could not cancel the login')
}

// ---- The topic -------------------------------------------------------------

/** A frame on `PROFILE_LOGINS_TOPIC`. `machine` is the member the phone's federation heard it from; the desktop's own server sends none. */
export interface LoginEvent {
  event?: string
  login?: ProfileLogin
  machine?: string
}

/** What one topic event does to the store: the entry it lands in, and the profiles to read again. */
export interface LoginEventPlan {
  patch: { key: string; login: ProfileLogin } | null
  reread: { claudeDirId: number; machine: string }[]
}

const NOTHING: LoginEventPlan = { patch: null, reread: [] }

/**
 * The event is the profile of the device that published it: this server's
 * own on the desktop, and on the phone the member its federation names
 * (`machine`) — so it lands in that profile's entry as it is, never by a
 * read that would ask the Mac to publish it again. An event that says what
 * the entry already holds changes nothing.
 *
 * A watched profile of the same id on another device hears nothing of its
 * own on this topic (the phone follows only its default member; the
 * desktop, only its server): a change here reads those again.
 */
export function loginEventPlan(entries: Readonly<Record<string, ProfileLoginEntry>>, msg: LoginEvent): LoginEventPlan {
  const login = msg.login
  if (msg.event !== 'login' || !login || typeof login.claudeDirId !== 'number') return NOTHING
  const key = profileKey(login.claudeDirId, msg.machine)
  const held = entries[key]?.login
  if (held && JSON.stringify(held) === JSON.stringify(login) && entries[key]?.refused === null) return NOTHING
  const reread: LoginEventPlan['reread'] = []
  for (const other of Object.keys(entries)) {
    if (other === key) continue
    const [machine, id] = other.split('#')
    if (machine && Number(id) === login.claudeDirId) reread.push({ claudeDirId: login.claudeDirId, machine })
  }
  return { patch: { key, login }, reread }
}

function onLoginEvent(msg: LoginEvent): void {
  const plan = loginEventPlan(useProfileLogins.getState().entries, msg)
  if (plan.patch) patch(plan.patch.key, { login: plan.patch.login, refused: null })
  for (const { claudeDirId, machine } of plan.reread) void readProfileLogin(claudeDirId, machine)
}

/** A run of either kind went from running to succeeded between two answers. */
export function succeededNow(before: ProfileLogin | null, after: ProfileLogin): boolean {
  return (['claude', 'design'] as const).some(
    (kind) => after.runs[kind]?.state === 'succeeded' && before?.runs[kind]?.state !== 'succeeded',
  )
}

// ---- Reconnect -------------------------------------------------------------

/** Every profile a surface shows, with how many show it. */
const watched = new Map<string, { claudeDirId: number; machine: string | undefined; count: number }>()
let followingStatus = false

/**
 * A login can end while the socket is down — a drop, the server restarting
 * — and its event is gone with the connection: every watched profile is
 * read again when the socket opens after having been open. Registered once,
 * for the page's lifetime, as `App.tsx` registers its own.
 */
function followReconnects(): void {
  if (followingStatus) return
  followingStatus = true
  let wasOpen = false
  let open = false
  getSocket().onStatusChange((status) => {
    const reopened = status === 'open' && !open && wasOpen
    open = status === 'open'
    if (open) wasOpen = true
    if (reopened) for (const { claudeDirId, machine } of watched.values()) void readProfileLogin(claudeDirId, machine)
  })
}

function watch(claudeDirId: number, machine: string | undefined): () => void {
  const key = profileKey(claudeDirId, machine)
  const held = watched.get(key)
  if (held) held.count += 1
  else watched.set(key, { claudeDirId, machine, count: 1 })
  followReconnects()
  return () => {
    const now = watched.get(key)
    if (!now) return
    now.count -= 1
    if (now.count === 0) watched.delete(key)
  }
}

/**
 * A profile's logins for a surface that shows them: read on mount and when
 * `rereadKey` changes (a session's `loginWait`, which moves on every start
 * and end of the login it waits on), then followed on the topic and read
 * again on a reconnect. `enabled` false reads nothing — a Mac too old for
 * the routes, a notice that is not the live one.
 */
export function useProfileLogin(
  claudeDirId: number | null | undefined,
  machine: string | undefined,
  { enabled = true, rereadKey }: { enabled?: boolean; rereadKey?: string } = {},
): ProfileLoginEntry {
  const key = claudeDirId == null ? null : profileKey(claudeDirId, machine)
  const entry = useProfileLogins((s) => (key ? s.entries[key] : undefined))
  const on = enabled && claudeDirId != null
  useEffect(() => {
    if (!on || claudeDirId == null) return
    // The socket refcounts the topic: the last surface to go unsubscribes it.
    const unsubscribe = getSocket().subscribe(PROFILE_LOGINS_TOPIC, onLoginEvent)
    const unwatch = watch(claudeDirId, machine)
    return () => {
      unwatch()
      unsubscribe()
    }
  }, [on, claudeDirId, machine])
  useEffect(() => {
    if (!on || claudeDirId == null) return
    void readProfileLogin(claudeDirId, machine)
  }, [on, claudeDirId, machine, rereadKey])
  return entry ?? EMPTY_ENTRY
}
