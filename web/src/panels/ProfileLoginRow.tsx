import { useState } from 'react'
import type { ClaudeDirInfo, LoginKind, LoginRun, ProfileLogin } from '../lib/types'
import {
  cancelLogin,
  profileKey,
  startedHere,
  startLogin,
  submitLoginCode,
  useProfileLogin,
} from '../store/profileLogins'
import { Button } from '../ui/Button'
import { LoginCodeEntry } from './LoginNotice'

/**
 * A profile's logins inside its Settings → Profiles row (spec
 * 2026-10-21-log-in-from-orbital-design § 4; canvas 62c, 62g): the ACCOUNT
 * and CLAUDE DESIGN lines under the profile's name, each with its one
 * action, and a running login's code path below them. Read when the section
 * opens (`active`), then followed on the topic, so the row and every notice
 * of the profile agree. No state dots: Settings isn't a session (62c).
 *
 * `machine` is the Mac the row is on when Settings looks at another one
 * (62g): there the code path is the login, never folded, and only the device
 * that started a login enters its code.
 */
export function ProfileLoginRow({
  dir,
  machine,
  active,
  macName,
}: {
  dir: Pick<ClaudeDirInfo, 'id' | 'name' | 'account' | 'exists'>
  machine?: string
  active: boolean
  macName: string
}) {
  const entry = useProfileLogin(dir.id, machine, { enabled: active && dir.exists })
  const [unfolded, setUnfolded] = useState(false)
  const remote = machine !== undefined
  const login = entry.login
  const key = profileKey(dir.id, machine)
  if (!dir.exists) return null

  // 62g: without the grant, or against an older Mac, the rows say what they
  // know and offer nothing; the note under them says where it can be done.
  const limited = entry.refused !== null
  const cli = login?.cliAvailable ?? true
  const mineOf = (run: LoginRun) => startedHere(key, run, remote)
  const account = accountRow(login, dir.account, remote, macName, mineOf)
  const design = login?.design.read && login.design.available ? designRow(login, remote, macName, mineOf) : null
  // The run whose code this device enters, if any: on this Mac only behind
  // the fold, on another device the panel itself.
  const codeRun = (['claude', 'design'] as const)
    .map((kind) => login?.runs[kind])
    .find((run): run is LoginRun => Boolean(run && run.state === 'running' && run.step !== 'checking' && mineOf(run) && run.manualUrl))
  const act = (kind: LoginKind, what: RowAction) => () => {
    if (what === 'cancel') void cancelLogin(dir.id, kind, machine)
    else void startLogin(dir.id, kind, machine)
  }

  return (
    <div data-profile-login className="flex flex-col gap-3 pb-4 pl-4 pr-3">
      <div className="ml-7 grid grid-cols-[120px_minmax(0,1fr)_auto] items-center gap-x-3.5 gap-y-2.5 border-t border-[rgba(150,205,255,.07)] pt-3">
        <LoginLine
          label="ACCOUNT"
          line={account}
          disabled={limited || !cli || Boolean(entry.busy.claude)}
          onAct={account.action ? act('claude', account.action) : undefined}
        />
        {design && (
          <LoginLine
            label="CLAUDE DESIGN"
            line={design}
            disabled={limited || !cli || Boolean(entry.busy.design)}
            onAct={design.action ? act('design', design.action) : undefined}
          />
        )}
      </div>

      {codeRun && !remote && (
        // 62c: folded by default, and never unfolding by itself.
        <div className="ml-[162px] flex flex-col gap-[9px]">
          <button
            type="button"
            aria-expanded={unfolded}
            onClick={() => setUnfolded((u) => !u)}
            className="cursor-pointer self-start border-0 bg-transparent p-0 font-mono text-[10.5px] text-[#8fd8ff] hover:text-[#c6ecff]"
          >
            {unfolded ? 'Hide ‹' : 'Browser didn’t open? ›'}
          </button>
          {unfolded && (
            <div className="max-w-[460px]">
              <LoginCodeEntry
                manualUrl={codeRun.manualUrl!}
                phone={false}
                indent={false}
                disabled={Boolean(entry.busy[codeRun.kind])}
                onSubmit={(code) => void submitLoginCode(dir.id, codeRun.kind, code, machine)}
              />
            </div>
          )}
        </div>
      )}
      {codeRun && remote && (
        // 62g: the code flow in place of the browser login, never folded.
        <div className="ml-[162px] flex max-w-[520px] flex-col gap-2.5 rounded-[9px] border border-[rgba(150,205,255,.12)] bg-[rgba(4,8,16,.5)] px-3.5 py-3">
          <span className="font-mono text-[9.5px] tracking-[0.16em] text-[rgba(160,190,225,.55)]">
            {codeRun.kind === 'design'
              ? 'CLAUDE DESIGN SIGN-IN FROM THIS MAC'
              : `LOG IN TO ${(dir.name || 'THE PROFILE').toUpperCase()} FROM THIS MAC`}
          </span>
          <LoginCodeEntry
            manualUrl={codeRun.manualUrl!}
            phone={false}
            disabled={Boolean(entry.busy[codeRun.kind])}
            onSubmit={(code) => void submitLoginCode(dir.id, codeRun.kind, code, machine)}
            onCancel={() => void cancelLogin(dir.id, codeRun.kind, machine)}
          />
        </div>
      )}

      {entry.error && (
        <span role="status" className="ml-[162px] font-mono text-[10.5px] leading-[1.6] text-[rgba(220,235,255,.85)] [text-wrap:pretty]">
          {entry.error}
        </span>
      )}
      {limited && (
        <div className="ml-7 font-mono text-[10.5px] leading-[1.7] text-[rgba(214,230,248,.75)] [text-wrap:pretty]">
          {entry.refused === 'no_grant'
            ? `This Mac has no “Upkeep of this Mac” grant on ${macName} · log in on that Mac to change a login`
            : `${macName} needs an Orbital update before logins can be done from here · until then, log in on that Mac`}
        </div>
      )}
      {!cli && !limited && (
        <div className="ml-7 font-mono text-[10.5px] leading-[1.7] text-[rgba(160,190,225,.6)]">
          Orbital knows no Claude Code executable on this Mac.
        </div>
      )}
    </div>
  )
}

type RowAction = 'start' | 'cancel'

/** One line of the grid (62c): what it is, its value and quieter sub line, and its action. */
interface Line {
  value: string
  sub: string | null
  /** The value in full ink (logged in, or a login running) or muted (not logged in). */
  bright: boolean
  button: string | null
  action: RowAction | null
  /** The lit chip, for Log in while the profile has no login (62c: "the primary chip is used only for Log in while the directory has no login"). */
  primary: boolean
}

function LoginLine({ label, line, disabled, onAct }: { label: string; line: Line; disabled: boolean; onAct?: () => void }) {
  return (
    <>
      <span className="font-mono text-[9.5px] tracking-[0.16em] text-[rgba(160,190,225,.55)]">{label}</span>
      <div className="flex min-w-0 flex-col gap-[3px]">
        <span className={['truncate font-mono text-[12px]', line.bright ? 'text-text-bright' : 'text-[rgba(160,190,225,.7)]'].join(' ')}>
          {line.value}
        </span>
        {line.sub && (
          <span className="font-mono text-[10.5px] leading-[1.5] text-[rgba(160,190,225,.55)] [text-wrap:pretty]">{line.sub}</span>
        )}
      </div>
      {line.button && onAct ? (
        <Button
          variant={line.primary ? 'lit' : 'ghost'}
          size="login-row"
          className="justify-self-end whitespace-nowrap"
          disabled={disabled}
          onClick={onAct}
        >
          {line.button}
        </Button>
      ) : (
        <span />
      )}
    </>
  )
}

/** A running login as a row line names it (62c on this Mac, 62g from another). */
function runningLine(run: LoginRun, remote: boolean, macName: string, mine: boolean): Line {
  const design = run.kind === 'design'
  const ing = design ? 'Signing in' : 'Logging in'
  const cancel = { button: 'Cancel', action: 'cancel' as const, primary: false, bright: true }
  if (!remote) {
    if (run.startedBy.deviceId !== null && !mine) {
      return { value: `${ing} from ${run.startedBy.name}`, sub: design ? 'the code is entered there' : 'the code is entered there · nothing opens here', ...cancel }
    }
    if (run.step === 'checking') return { value: 'Checking the code', sub: null, ...cancel, button: null, action: null }
    return {
      value: `${ing} — finish in your browser`,
      sub: design ? 'opened the Claude Design sign-in' : 'opened claude.ai',
      ...cancel,
    }
  }
  const none = { button: null, action: null, primary: false, bright: true }
  if (run.startedBy.deviceId === null) return { value: `${ing} on ${macName}`, sub: 'started on that Mac · this updates by itself', ...none }
  if (!mine) return { value: `${ing} from ${run.startedBy.name}`, sub: 'the code is entered there', ...none }
  if (run.step === 'checking') return { value: 'Checking the code', sub: `with ${macName}`, ...none }
  return { value: `${ing} from this Mac`, sub: `paste the code below · nothing opens on ${macName}`, ...cancel }
}

/**
 * The ACCOUNT line (62c, 62g): `auth status` once it has answered — the
 * e-mail with org · plan under it and Switch account; Not logged in with the
 * account `.claude.json` still names and Log in; a failed run's sentence; a
 * running login. The list's `account` until the status has answered.
 */
export function accountRow(
  login: ProfileLogin | null,
  listed: string | null,
  remote: boolean,
  macName: string,
  mineOf: (run: LoginRun) => boolean,
): Line {
  const run = login?.runs.claude
  if (run?.state === 'running') return runningLine(run, remote, macName, mineOf(run))
  const status = login?.account
  if (!status?.read) return { value: listed ?? '', sub: null, bright: true, button: null, action: null, primary: false }
  if (status.loggedIn) {
    const plan = status.plan ? status.plan.charAt(0).toUpperCase() + status.plan.slice(1) : null
    const sub = [status.orgName, plan].filter(Boolean).join(' · ') || null
    return { value: status.email ?? listed ?? '', sub, bright: true, button: 'Switch account', action: 'start', primary: false }
  }
  const sub = run?.state === 'failed' ? run.message : listed ? `was ${listed} · OAuth session expired` : null
  return { value: 'Not logged in', sub, bright: false, button: 'Log in', action: 'start', primary: true }
}

/**
 * The CLAUDE DESIGN line (62c): signed in or not, Sign in to Claude Design,
 * a failed run's sentence, a running sign-in. `design-login` reports no
 * account (spec § What the CLI does), so a signed-in line names none.
 */
function designRow(login: ProfileLogin, remote: boolean, macName: string, mineOf: (run: LoginRun) => boolean): Line {
  const run = login.runs.design
  if (run?.state === 'running') return runningLine(run, remote, macName, mineOf(run))
  if (login.design.signedIn) return { value: 'Signed in', sub: null, bright: true, button: null, action: null, primary: false }
  return {
    value: 'Not signed in',
    sub: run?.state === 'failed' ? run.message : null,
    bright: false,
    button: 'Sign in to Claude Design',
    action: 'start',
    primary: false,
  }
}
