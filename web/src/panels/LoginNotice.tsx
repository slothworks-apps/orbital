import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { copyToClipboard } from '../lib/clipboard'
import { claudeDirDisplayPath } from '../lib/claudeDirs'
import {
  clipboardReader,
  loginNoticeView,
  restoredNoticeLabel,
  waitingLine,
  type LoginAccess,
  type LoginNoticePlace,
} from '../lib/profileLogin'
import { openSettingsSection } from '../lib/sessionUrl'
import { stateColor } from '../lib/stateStyle'
import type { ApiSession, ChatMessage, LoginKind, LoginLostNotice, LoginRestoredNotice, LoginRun } from '../lib/types'
import {
  cancelLogin,
  openSignInPage,
  profileKey,
  startedHere,
  startLogin,
  submitLoginCode,
  useProfileLogin,
} from '../store/profileLogins'
import { useOrbital } from '../store/store'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { NoticeRow } from './NoticeRow'

/**
 * Where the lost-login notice is drawn, and what that surface knows that the
 * transcript does not (spec 2026-10-21-log-in-from-orbital-design § 6). The
 * desktop's default: the Mac's own notice, the browser path folded behind
 * its fallback. The phone provides its own (`SessionScreen`): the code flow
 * never folded, its Mac's version gate (`MAC_FEATURES.profileLogin`), and a
 * focused code field that hides the composer.
 */
export interface LoginNoticeSurface {
  phone: boolean
  /** The Mac the session runs on serves the login routes; false, the notice has no Log in (older Mac). */
  serves: (sessionId: string) => boolean
  /** The code field took or lost focus (the phone hides its composer meanwhile). */
  onCodeFocus?: (focused: boolean) => void
}

export const LoginNoticeContext = createContext<LoginNoticeSurface>({ phone: false, serves: () => true })

/**
 * A `login_lost` row of the transcript (canvas `Feature - Log in` 62a, 62b,
 * 62d "TRANSCRIPT NOTICE"): A logged out with Log in, B logging in with the
 * code fallback and Cancel, C the past-tense divider once the login is back,
 * D failed with the CLI's or Orbital's sentence. The state is the profile's
 * (`useProfileLogin`), so every notice of the profile and its Settings row
 * move together; nothing here keeps a state of its own beyond the field.
 *
 * Never amber beyond the NEEDS INPUT dot, never animated, no countdown: a
 * login can wait (`why-orbital`).
 */
export function LoginLostRow({
  message,
  sessionId,
  place,
  offline = false,
}: {
  message: ChatMessage
  sessionId: string | undefined
  place: LoginNoticePlace
  offline?: boolean
}) {
  const surface = useContext(LoginNoticeContext)
  const notice = message.notice?.login as LoginLostNotice
  const kind: LoginKind = notice.kind === 'design' ? 'design' : 'claude'
  const session = useOrbital((s) => (sessionId ? s.sessions[sessionId] : undefined))
  // The parser does not know the profile (spec § 7): the session's is the one.
  const claudeDirId = notice.claudeDirId ?? session?.claudeDirId ?? null
  const machine = session?.machine?.id
  const remote = surface.phone || machine !== undefined
  const macName = session?.machine?.name ?? 'the Mac'
  const dir = useOrbital((s) => (machine === undefined ? s.claudeDirs.find((d) => d.id === claudeDirId) : undefined))
  const serves = sessionId ? surface.serves(sessionId) : true
  const terminal = session?.source === 'terminal'
  // A notice another row already answers, and a terminal session's, read nothing.
  const reads = serves && !terminal && !place.restoredAfter && claudeDirId !== null
  const wait = session?.loginWait
  const entry = useProfileLogin(claudeDirId, machine, {
    enabled: reads,
    rereadKey: wait ? `${wait.kind}:${wait.running}` : 'none',
  })
  const key = claudeDirId === null ? '' : profileKey(claudeDirId, machine)
  const access: LoginAccess = !serves || entry.refused === 'older_mac' ? 'older_mac' : entry.refused === 'no_grant' ? 'no_grant' : 'ok'
  const view = loginNoticeView({
    notice,
    timestamp: message.timestamp,
    place,
    session,
    profile: entry.login,
    access,
    startedHere: (run) => startedHere(key, run, remote),
  })

  if (view.kind === 'hidden') return null
  if (view.kind === 'cli') {
    return (
      <div data-login-notice="cli" className="flex flex-col gap-1.5">
        <NoticeRow message={message} />
        {/* 62d edge cases: shown, not driven — the profile logs in from Settings. */}
        {view.link && !surface.phone && (
          <button
            type="button"
            onClick={() => openSettingsSection('profiles')}
            className="cursor-pointer self-start border-0 bg-transparent p-0 font-mono text-[10.5px] text-[#8fd8ff] hover:text-[#c6ecff]"
          >
            log in from Settings → Profiles ›
          </button>
        )}
      </div>
    )
  }
  if (view.kind === 'restored') return <LoginDivider label={view.label} />

  const name = dir?.name ?? null
  const profile = name ? `${name} profile` : 'this profile'
  const verb = kind === 'design' ? 'Sign in' : 'Log in'
  const run = entry.login?.runs[kind] ?? null
  const act = (fn: () => Promise<void>) => () => {
    if (!offline && claudeDirId !== null) void fn()
  }
  const start = act(() => startLogin(claudeDirId!, kind, machine))

  if (view.kind === 'running') {
    return (
      <LoginRunning
        run={view.run}
        mine={view.mine}
        remote={remote}
        phone={surface.phone}
        title={runningTitle(view.run, view.mine, remote, profile)}
        waiting={sessionId ? waitingLine(view.run, sessionId, true) : null}
        busy={Boolean(entry.busy[kind])}
        error={entry.error}
        offline={offline}
        onCodeFocus={surface.onCodeFocus}
        onSubmit={(code) => (claudeDirId === null ? undefined : void submitLoginCode(claudeDirId, kind, code, machine))}
        onCancel={act(() => cancelLogin(claudeDirId!, kind, machine))}
      />
    )
  }

  const failed = view.kind === 'failed'
  const title = failed
    ? kind === 'design'
      ? 'Sign-in to Claude Design failed'
      : 'Login failed'
    : kind === 'design'
      ? 'Signed out of Claude Design'
      : view.neverLoggedIn
        ? `${capitalize(profile)} is not logged in`
        : `Logged out of ${profile}`
  const sub = failed
    ? view.message
    : view.kind === 'lost' && view.neverLoggedIn && dir?.path
      ? claudeDirDisplayPath(dir.path)
      : [view.kind === 'lost' && view.email ? `was ${view.email}` : null, message.text].filter(Boolean).join(' · ')
  const note =
    view.kind === 'lost' && view.access === 'no_grant'
      ? `${macName} does not let this device log it in. Log in on ${macName}, in Settings → Profiles.`
      : view.kind === 'lost' && view.access === 'older_mac'
        ? `Log in on ${macName}: its Orbital is too old to log in from here.`
        : !view.cliAvailable
          ? 'Orbital knows no Claude Code executable on this Mac.'
          : wait?.kind === kind
            ? 'continues by itself once you’re logged in'
            : null
  const canStart = (view.kind === 'failed' || view.access === 'ok') && view.cliAvailable
  const others = sessionId ? waitingLine(run, sessionId, false) : null

  return (
    <LoginBlock
      phone={surface.phone}
      tone={failed ? 'quiet' : 'asks'}
      title={title}
      lines={[sub, entry.error, note, others]}
      actions={
        canStart ? (
          <NoticeButton phone={surface.phone} primary disabled={offline || Boolean(entry.busy[kind])} onClick={start}>
            {failed ? `${verb} again` : verb}
          </NoticeButton>
        ) : null
      }
    />
  )
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** B's title (62a, 62d, 62h): where the login is finished, or who is finishing it. */
function runningTitle(run: LoginRun, mine: boolean, remote: boolean, profile: string): string {
  if (run.step === 'checking') return 'Checking the code'
  if (!mine) return `Logging in from ${run.startedBy.name}`
  const what = run.kind === 'design' ? 'Signing in to Claude Design' : `Logging in to ${profile}`
  return remote || run.manualOnly ? `${what} · open the sign-in page and paste the code` : `${what} · finish in the browser`
}

/** A `login_restored` row (live only, like `limit_reset`): the divider the notice folds into (62d C). */
export function LoginRestoredRow({ message }: { message: ChatMessage }) {
  const notice = message.notice?.login as LoginRestoredNotice | undefined
  if (!notice) return null
  return <LoginDivider label={restoredNoticeLabel(notice)} />
}

/** 62d C: the past-tense line, the limit reset's divider (31d AFTER). */
function LoginDivider({ label }: { label: string }) {
  return (
    <div
      data-login-restored
      className="flex items-center gap-2.5 whitespace-nowrap py-3 font-mono text-[9.5px] tracking-[0.14em] text-[rgba(160,190,225,.55)]"
    >
      <span aria-hidden className="h-px flex-1 bg-[rgba(150,205,255,.12)]" />
      <span className="min-w-0 truncate">{label}</span>
      <span aria-hidden className="h-px flex-1 bg-[rgba(150,205,255,.12)]" />
    </div>
  )
}

/**
 * The notice's box, as the limit wait's (31d; phone 10k): a dot, the title,
 * its quiet lines, the actions. `asks` wears NEEDS INPUT's steady solid dot,
 * `rests` the hollow ring of a session that waits on nothing from you,
 * `quiet` a dim one.
 */
function LoginBlock({
  phone,
  tone,
  title,
  lines,
  actions,
  children,
}: {
  phone: boolean
  tone: 'asks' | 'rests' | 'quiet'
  title: string
  lines: Array<string | null | undefined>
  actions: ReactNode
  children?: ReactNode
}) {
  const shown = lines.filter((l): l is string => Boolean(l))
  const dot =
    tone === 'asks' ? (
      <span aria-hidden className="block h-2 w-2 flex-none rounded-full" style={{ background: stateColor('needs_input') }} />
    ) : (
      <span
        aria-hidden
        className={[
          'block h-2 w-2 flex-none rounded-full border-[1.5px] border-solid',
          tone === 'rests' ? 'border-[rgba(214,230,248,.75)]' : 'border-[rgba(160,190,225,.5)]',
        ].join(' ')}
      />
    )
  return (
    <div
      data-login-notice={tone}
      className={
        phone
          ? 'flex flex-col gap-2.5 rounded-[12px] border border-[rgba(150,205,255,.16)] bg-[rgba(8,12,22,.9)] px-3.5 py-3'
          : 'flex flex-col gap-2 rounded-[9px] border border-[rgba(150,205,255,.16)] bg-[rgba(4,8,16,.5)] px-3.5 py-3'
      }
    >
      <div className={phone ? 'flex items-start gap-2.5' : 'flex items-center gap-2.5'}>
        <span className={phone ? 'mt-1.5 flex' : 'flex'}>{dot}</span>
        <span className={['min-w-0 flex-1 font-semibold text-text-bright', phone ? 'text-[14px]' : 'text-[13px]'].join(' ')}>
          {title}
        </span>
        {!phone && actions}
      </div>
      {shown.map((line, i) => (
        <div
          key={i}
          className="pl-[18px] font-mono text-[10.5px] leading-[1.6] text-[rgba(160,190,225,.65)] [overflow-wrap:anywhere] [text-wrap:pretty]"
        >
          {line}
        </div>
      ))}
      {children}
      {phone && actions && <div className="flex items-center justify-end gap-2.5 pl-[18px]">{actions}</div>}
    </div>
  )
}

/** The notice's own buttons: the limit notice's row button on the Mac, a 44px target on the phone. */
function NoticeButton({
  phone,
  primary = false,
  disabled,
  onClick,
  children,
}: {
  phone: boolean
  primary?: boolean
  disabled?: boolean
  onClick?: () => void
  children: ReactNode
}) {
  if (!phone) {
    return (
      <Button variant={primary ? 'lit' : 'ghost'} size="row" disabled={disabled} onClick={onClick}>
        {children}
      </Button>
    )
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        'h-11 min-w-[88px] rounded-[12px] border px-4 text-[13.5px] font-semibold disabled:opacity-40',
        primary
          ? 'border-transparent bg-[oklch(85%_.12_205)] text-[#03111a]'
          : 'border-[rgba(150,205,255,.22)] bg-transparent text-text-bright',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

/**
 * B (62a, 62d; phone 62e, 62h): the login runs. On this Mac the browser
 * path finishes it, and the code path is folded behind "Browser didn't
 * open? ›"; on another device the code is the path, never folded. Only the
 * device that started it gets the field; every other one reads who is
 * finishing it.
 */
export function LoginRunning({
  run,
  mine,
  remote,
  phone,
  title,
  waiting,
  busy,
  error,
  offline,
  onCodeFocus,
  onSubmit,
  onCancel,
}: {
  run: LoginRun
  mine: boolean
  remote: boolean
  phone: boolean
  title: string
  waiting: string | null
  busy: boolean
  error: string | null
  offline: boolean
  onCodeFocus?: (focused: boolean) => void
  onSubmit: (code: string) => void
  onCancel: () => void
}) {
  const checking = run.step === 'checking'
  const manual = remote || run.manualOnly
  const [unfolded, setUnfolded] = useState(false)
  const codeShown = mine && !checking && run.manualUrl !== null && (manual || unfolded)
  return (
    <LoginBlock
      phone={phone}
      tone="rests"
      title={title}
      lines={[error, waiting]}
      actions={
        // The phone's code path carries its own Cancel, beside Submit (62e).
        phone && codeShown ? null : (
          <NoticeButton phone={phone} disabled={offline || busy} onClick={onCancel}>
            Cancel
          </NoticeButton>
        )
      }
    >
      {mine && !checking && !manual && run.manualUrl !== null && !unfolded && (
        <button
          type="button"
          onClick={() => setUnfolded(true)}
          className="cursor-pointer self-start border-0 bg-transparent p-0 pl-[18px] font-mono text-[10.5px] text-[#8fd8ff] hover:text-[#c6ecff]"
        >
          Browser didn’t open? ›
        </button>
      )}
      {codeShown && (
        <LoginCodeEntry
          manualUrl={run.manualUrl!}
          phone={phone}
          disabled={offline || busy}
          onFocusChange={onCodeFocus}
          onSubmit={onSubmit}
          onCancel={phone ? onCancel : undefined}
        />
      )}
    </LoginBlock>
  )
}

/** How long after the code field lets go the phone's composer comes back. */
const COMPOSER_RETURN_MS = 250

/**
 * The code path (62d fallback; 62e, 62h on the phone): the sign-in page,
 * which shows a code, and the field it is pasted into. Submit stays dim
 * until something is in the field. On the phone the field has its own
 * Paste (spec § 6), hidden where the WebView refuses the clipboard, and the
 * notice's Cancel sits beside Submit.
 */
export function LoginCodeEntry({
  manualUrl,
  phone,
  disabled,
  onFocusChange,
  onSubmit,
  onCancel,
}: {
  manualUrl: string
  phone: boolean
  disabled: boolean
  onFocusChange?: (focused: boolean) => void
  onSubmit: (code: string) => void
  /** The phone's Cancel beside Submit; the Mac's sits on the title row. */
  onCancel?: () => void
}) {
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState(false)
  const [pasteRefused, setPasteRefused] = useState(false)
  const read = useMemo(() => (phone ? clipboardReader() : null), [phone])
  const submitRef = useRef<HTMLButtonElement>(null)
  const focused = useRef(false)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ready = code.trim() !== ''

  // With the field focused on the phone, the keyboard takes the bottom of the
  // screen: Submit is kept above it (spec § 6) as the viewport shrinks.
  useEffect(() => {
    if (!phone || typeof window === 'undefined' || !window.visualViewport) return
    const viewport = window.visualViewport
    const keep = () => {
      if (focused.current) submitRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
    }
    viewport.addEventListener('resize', keep)
    return () => viewport.removeEventListener('resize', keep)
  }, [phone])
  useEffect(
    () => () => {
      if (blurTimer.current) clearTimeout(blurTimer.current)
      onFocusChange?.(false)
    },
    [onFocusChange],
  )

  const submit = () => {
    if (!ready || disabled) return
    onSubmit(code.trim())
  }
  const paste = async () => {
    if (!read) return
    const text = await read()
    if (text === null) setPasteRefused(true)
    else if (text) setCode(text)
  }

  const field = (
    <Input
      aria-label="Sign-in code"
      font="mono"
      size={phone ? 'lg' : 'sm'}
      variant={phone ? 'bare' : 'field'}
      autoComplete="one-time-code"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      placeholder="paste the code"
      value={code}
      disabled={disabled}
      onChange={(e) => setCode(e.target.value)}
      onFocus={() => {
        focused.current = true
        if (blurTimer.current) clearTimeout(blurTimer.current)
        onFocusChange?.(true)
      }}
      onBlur={() => {
        focused.current = false
        // The composer comes back a beat after the field lets go: a tap on
        // Submit blurs the field first, and the composer returning at once
        // would move Submit out from under the finger.
        blurTimer.current = setTimeout(() => onFocusChange?.(false), COMPOSER_RETURN_MS)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          submit()
        }
      }}
      className="min-w-0 flex-1"
    />
  )

  if (phone) {
    return (
      <div data-login-code className="flex flex-col gap-2.5 pl-[19px]">
        <button
          type="button"
          onClick={() => openSignInPage(manualUrl)}
          className="flex h-11 items-center justify-center rounded-[12px] border border-[rgba(150,205,255,.22)] bg-transparent px-4 text-[13.5px] font-semibold text-text-bright"
        >
          Open sign-in page ↗
        </button>
        <div className="flex min-h-11 items-center gap-2 rounded-[12px] border border-[rgba(150,205,255,.18)] pl-3 pr-1">
          {field}
          {read && !pasteRefused && (
            <button
              type="button"
              onClick={() => void paste()}
              disabled={disabled}
              className="h-9 flex-none rounded-[9px] border border-[rgba(150,205,255,.2)] bg-transparent px-3 text-[12.5px] font-semibold text-text-bright disabled:opacity-40"
            >
              Paste
            </button>
          )}
        </div>
        <div className="flex items-center justify-end gap-2.5">
          {onCancel && (
            <NoticeButton phone disabled={disabled} onClick={onCancel}>
              Cancel
            </NoticeButton>
          )}
          <button
            ref={submitRef}
            type="button"
            onClick={submit}
            disabled={disabled}
            aria-disabled={!ready || undefined}
            className={[
              'h-11 min-w-[88px] rounded-[12px] px-4 text-[13.5px] font-bold disabled:opacity-40',
              ready
                ? 'bg-[oklch(85%_.12_205)] text-[#03111a]'
                : 'cursor-default border border-[rgba(150,205,255,.14)] bg-transparent text-[rgba(160,190,225,.5)]',
            ].join(' ')}
          >
            Submit code
          </button>
        </div>
      </div>
    )
  }

  return (
    <div data-login-code className="flex flex-col gap-2 pl-[18px]">
      <div className="flex items-center gap-3.5 font-mono text-[10.5px]">
        <button
          type="button"
          onClick={() => openSignInPage(manualUrl)}
          className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[10.5px] text-[#8fd8ff] hover:text-[#c6ecff]"
        >
          Open the sign-in page ↗
        </button>
        <button
          type="button"
          onClick={() => void copyToClipboard(manualUrl).then(setCopied)}
          className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[10.5px] text-[rgba(160,190,225,.7)] hover:text-[#c6ecff]"
        >
          {copied ? 'copied' : 'copy link'}
        </button>
      </div>
      <div className="flex items-center gap-2">
        {field}
        <Button variant={ready ? 'lit' : 'ghost'} size="row" disabled={disabled || !ready} onClick={submit}>
          Submit
        </Button>
      </div>
    </div>
  )
}

/**
 * The Desk card's answer to a lost login (canvas 62b): the card carries the
 * notice the way it carries a question (41b) — what is needed and Log in, or
 * the running login with its Cancel and code path. The same profile state
 * as the transcript's notice, so answering one answers both.
 */
export function LoginCardBlock({ session, offline }: { session: ApiSession; offline: boolean }) {
  const wait = session.loginWait
  const machine = session.machine?.id
  const remote = machine !== undefined
  const entry = useProfileLogin(wait?.claudeDirId, machine, { rereadKey: wait ? `${wait.kind}:${wait.running}` : 'none' })
  const name = useOrbital((s) => (remote || !wait ? null : (s.claudeDirs.find((d) => d.id === wait.claudeDirId)?.name ?? null)))
  if (!wait) return null
  const { kind, claudeDirId } = wait
  const profile = name ? `${name} profile` : 'this profile'
  const run = entry.login?.runs[kind] ?? null
  const key = profileKey(claudeDirId, machine)
  if (run?.state === 'running' && entry.refused === null) {
    const mine = startedHere(key, run, remote)
    return (
      <LoginRunning
        run={run}
        mine={mine}
        remote={remote}
        phone={false}
        title={runningTitle(run, mine, remote, profile)}
        waiting={null}
        busy={Boolean(entry.busy[kind])}
        error={entry.error}
        offline={offline}
        onSubmit={(code) => void submitLoginCode(claudeDirId, kind, code, machine)}
        onCancel={() => void cancelLogin(claudeDirId, kind, machine)}
      />
    )
  }
  const failed = run?.state === 'failed' ? run.message : null
  const refusedLine =
    entry.refused === 'no_grant'
      ? `Log in on ${session.machine?.name ?? 'the Mac'}.`
      : entry.refused === 'older_mac'
        ? `Log in on ${session.machine?.name ?? 'the Mac'}: its Orbital is too old to log in from here.`
        : null
  const canStart = entry.refused === null && (entry.login?.cliAvailable ?? true)
  return (
    <LoginBlock
      phone={false}
      tone="asks"
      title={kind === 'design' ? 'Signed out of Claude Design' : `Logged out of ${profile}`}
      lines={[failed, entry.error, refusedLine]}
      actions={
        canStart ? (
          <NoticeButton
            phone={false}
            primary
            disabled={offline || Boolean(entry.busy[kind])}
            onClick={() => void startLogin(claudeDirId, kind, machine)}
          >
            {kind === 'design' ? 'Sign in' : 'Log in'}
          </NoticeButton>
        ) : null
      }
    />
  )
}
