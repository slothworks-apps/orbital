import { useEffect } from 'react'
import { create } from 'zustand'
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
 * Read when a surface that shows it mounts, and then followed on the
 * `claude-dir-logins` topic. The topic is this server's own: an event for
 * one of its profiles lands as it is; an event naming the id of a watched
 * profile on another device — the phone's topic comes from its default
 * member — reads that profile again rather than taking a frame that does
 * not say whose it is. A member's profile is also read again whenever a
 * session waiting on it changes (`useProfileLogin`), which is how its end
 * arrives on a device whose topic does not carry it.
 */

export const LOGINS_TOPIC = 'claude-dir-logins'

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

/** A route the Mac does not have: an older Mac's 404, or its allowlist's `not_allowed` for a route it does not list. */
function olderMac(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false
  if (err.status === 404) return true
  return err.status === 403 && errorSentence(err, '') === 'not_allowed'
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
    if (olderMac(err)) patch(key, { refused: 'older_mac' })
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
    if (olderMac(err)) patch(key, { refused: 'older_mac' })
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
  const login = await act(claudeDirId, kind, machine, () => api.startProfileLogin(claudeDirId, kind, machine), 'Could not start the login')
  const run = login?.runs[kind]
  if (!run || run.state !== 'running') return
  rememberStarted(profileKey(claudeDirId, machine), run)
  const open = opensInBrowser(run)
  if (open) openSignInPage(open)
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

let watchers = 0
let unwatch: (() => void) | null = null

function onLoginEvent(msg: { event?: string; login?: ProfileLogin }): void {
  const login = msg.login
  if (msg.event !== 'login' || !login || typeof login.claudeDirId !== 'number') return
  patch(profileKey(login.claudeDirId), { login, refused: null })
  for (const key of Object.keys(useProfileLogins.getState().entries)) {
    const [machine, id] = key.split('#')
    if (machine && Number(id) === login.claudeDirId) void readProfileLogin(login.claudeDirId, machine)
  }
}

/** A run of either kind went from running to succeeded between two answers. */
export function succeededNow(before: ProfileLogin | null, after: ProfileLogin): boolean {
  return (['claude', 'design'] as const).some(
    (kind) => after.runs[kind]?.state === 'succeeded' && before?.runs[kind]?.state !== 'succeeded',
  )
}

/** Holds the topic while anything shows a profile's login. */
function watchTopic(): () => void {
  watchers += 1
  if (!unwatch) unwatch = getSocket().subscribe(LOGINS_TOPIC, onLoginEvent)
  return () => {
    watchers -= 1
    if (watchers === 0 && unwatch) {
      unwatch()
      unwatch = null
    }
  }
}

/**
 * A profile's logins for a surface that shows them: read on mount and when
 * `rereadKey` changes (a session's `loginWait`, which moves on every start
 * and end of the login it waits on), then followed on the topic. `enabled`
 * false reads nothing — a Mac too old for the routes, a notice that is not
 * the live one.
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
    if (!on) return
    return watchTopic()
  }, [on])
  useEffect(() => {
    if (!on || claudeDirId == null) return
    void readProfileLogin(claudeDirId, machine)
  }, [on, claudeDirId, machine, rereadKey])
  return entry ?? EMPTY_ENTRY
}
