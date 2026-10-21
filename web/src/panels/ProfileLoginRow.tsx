import type { ClaudeDirInfo, LoginKind, ProfileLogin } from '../lib/types'
import {
  cancelLogin,
  profileKey,
  startedHere,
  startLogin,
  submitLoginCode,
  useProfileLogin,
} from '../store/profileLogins'
import { Button } from '../ui/Button'
import { LoginRunning } from './LoginNotice'

/**
 * A profile's logins inside its Settings → Profiles row (spec
 * 2026-10-21-log-in-from-orbital-design § 4; canvas 62c, 62g): ACCOUNT and
 * CLAUDE DESIGN, the actions, and a running login the way the notice draws
 * it. Read when the section opens (`active`), then followed on the topic.
 *
 * `machine` is the Mac the row is on when Settings looks at another one
 * (62g): there the code path is the login, never folded.
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
  const remote = machine !== undefined
  const login = entry.login
  const key = profileKey(dir.id, machine)
  if (!dir.exists) return null

  if (entry.refused) {
    return (
      <div className="pb-3 pl-4 pr-2.5 font-mono text-[10.5px] leading-[1.6] text-[rgba(160,190,225,.6)] [text-wrap:pretty]">
        {entry.refused === 'no_grant'
          ? `${macName} does not let this device log it in. Log in on ${macName}, in Settings → Profiles.`
          : `Log in on ${macName}: its Orbital is too old to log in from here.`}
      </div>
    )
  }

  const account = accountLine(login, dir.account)
  const design = login?.design.read && login.design.available ? (login.design.signedIn ? 'signed in' : 'not signed in') : null
  const loggedIn = login?.account.read ? login.account.loggedIn : Boolean(dir.account)
  const disabled = login !== null && !login.cliAvailable
  const running = (kind: LoginKind) => (login?.runs[kind]?.state === 'running' ? login.runs[kind] : null)
  const failed = (kind: LoginKind) => (login?.runs[kind]?.state === 'failed' ? login.runs[kind]?.message ?? null : null)
  const claudeRun = running('claude')
  const designRun = running('design')

  return (
    <div data-profile-login className="flex flex-col gap-2.5 pb-3 pl-4 pr-2.5">
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 font-mono text-[11px]">
        {account !== null && (
          <>
            <span className="text-[9.5px] tracking-[0.16em] text-[rgba(160,190,225,.55)]">ACCOUNT</span>
            <span className="truncate text-[rgba(200,220,245,.8)]">{account}</span>
          </>
        )}
        {design !== null && (
          <>
            <span className="text-[9.5px] tracking-[0.16em] text-[rgba(160,190,225,.55)]">CLAUDE DESIGN</span>
            <span className="truncate text-[rgba(200,220,245,.8)]">{design}</span>
          </>
        )}
      </div>

      {!claudeRun && !designRun && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="row"
            disabled={disabled || Boolean(entry.busy.claude)}
            onClick={() => void startLogin(dir.id, 'claude', machine)}
          >
            {loggedIn ? 'Switch account' : 'Log in'}
          </Button>
          {login?.design.read && login.design.available && !login.design.signedIn && (
            <Button
              variant="ghost"
              size="row"
              disabled={disabled || Boolean(entry.busy.design)}
              onClick={() => void startLogin(dir.id, 'design', machine)}
            >
              Sign in to Claude Design
            </Button>
          )}
          {disabled && (
            <span className="font-mono text-[10.5px] text-[rgba(160,190,225,.55)]">
              Orbital knows no Claude Code executable on this Mac.
            </span>
          )}
        </div>
      )}

      {[claudeRun, designRun].map((run) => {
        if (!run) return null
        const mine = startedHere(key, run, remote)
        return (
          <LoginRunning
            key={run.kind}
            run={run}
            mine={mine}
            remote={remote}
            phone={false}
            title={
              run.step === 'checking'
                ? 'Checking the code'
                : !mine
                  ? `Logging in from ${run.startedBy.name}`
                  : run.kind === 'design'
                    ? remote
                      ? 'Signing in to Claude Design · open the sign-in page and paste the code'
                      : 'Signing in to Claude Design · finish in the browser'
                    : remote
                      ? 'Logging in · open the sign-in page and paste the code'
                      : 'Logging in · finish in the browser'
            }
            waiting={null}
            busy={Boolean(entry.busy[run.kind])}
            error={entry.error}
            offline={false}
            onSubmit={(code) => void submitLoginCode(dir.id, run.kind, code, machine)}
            onCancel={() => void cancelLogin(dir.id, run.kind, machine)}
          />
        )
      })}

      {!claudeRun && !designRun && (failed('claude') || failed('design') || entry.error) && (
        <span role="status" className="font-mono text-[10.5px] leading-[1.6] text-[rgba(220,235,255,.85)] [text-wrap:pretty]">
          {entry.error ?? failed('claude') ?? failed('design')}
        </span>
      )}
    </div>
  )
}

/**
 * The ACCOUNT line (spec § 4): `auth status` once it has answered —
 * `e-mail · org · plan`, `Not logged in`, or `was <e-mail> · OAuth session
 * expired` for a login `.claude.json` still names; the list's `account`
 * until then; nothing when neither knows.
 */
export function accountLine(login: ProfileLogin | null, listed: string | null): string | null {
  const status = login?.account
  if (!status?.read) return listed
  if (!status.loggedIn) return listed ? `was ${listed} · OAuth session expired` : 'Not logged in'
  const plan = status.plan ? status.plan.charAt(0).toUpperCase() + status.plan.slice(1) : null
  return [status.email ?? listed, status.orgName, plan].filter(Boolean).join(' · ') || null
}
