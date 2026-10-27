import { createContext, useContext, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from 'react'
import { copyToClipboard } from '../lib/clipboard'
import { claudeDirDisplayPath } from '../lib/claudeDirs'
import {
  clipboardReader,
  loginAccess,
  loginNoticeView,
  profilePhrase,
  restoredNoticeLabel,
  waitingLine,
  type LoginNoticePlace,
} from '../lib/profileLogin'
import { openSettingsSection } from '../lib/sessionUrl'
import { stateColor, stateDot } from '../lib/stateStyle'
import type { ApiSession, ChatMessage, LoginLostNotice, LoginRestoredNotice, LoginRun } from '../lib/types'
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
import { StateDot } from '../ui/StateDot'

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
  /**
   * The Mac the session runs on serves the login routes; false, the notice
   * has no Log in (older Mac); null while its version is not known yet, and
   * the notice says neither.
   */
  serves: (sessionId: string) => boolean | null
  /** The code field took or lost focus (the phone hides its composer meanwhile). */
  onCodeFocus?: (focused: boolean) => void
}

export const LoginNoticeContext = createContext<LoginNoticeSurface>({ phone: false, serves: () => true })

/** `The Work profile`, or `The profile` while its name is not known. */
function theProfile(name: string | null): string {
  return name ? `The ${name} profile` : 'The profile'
}

/**
 * The CLI's sentence as the sub line keeps it (62a, 62d A): its own words,
 * without the "Failed to authenticate:" the title already says in plain
 * words, and without a "Please run /login" the notice's own Log in answers.
 */
function cliReason(text: string | undefined): string {
  return (text ?? '')
    .replace(/^\s*Failed to authenticate:\s*/i, '')
    .replace(/\s*·?\s*Please run \/login\.?\s*$/i, '')
    .trim()
}

/** How a notice names the device it is on, for "from this phone" (62e). */
function deviceWord(phone: boolean): string {
  return phone ? 'phone' : 'Mac'
}

/**
 * A `login_lost` row of the transcript (canvas `Feature - Log in` 62a, 62d
 * "TRANSCRIPT NOTICE"; phone 62e, 62h): A logged out with Log in, B logging
 * in, C the past-tense divider once the login is back, D failed with the
 * CLI's or Orbital's sentence. The state is the profile's
 * (`useProfileLogin`), so every notice of the profile and its Settings row
 * move together; nothing here keeps a state of its own beyond the field.
 *
 * The amber dot only while the session needs you, a hollow neutral one while
 * the login runs; never animated, no countdown (`why-orbital`).
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
  const kind = notice.kind
  const session = useOrbital((s) => (sessionId ? s.sessions[sessionId] : undefined))
  // The parser does not know the profile (spec § 7): the session's is the one.
  const claudeDirId = notice.claudeDirId ?? session?.claudeDirId ?? null
  const machine = session?.machine?.id
  const remote = surface.phone || machine !== undefined
  const macName = session?.machine?.name ?? 'the Mac'
  const dir = useOrbital((s) => (machine === undefined ? s.claudeDirs.find((d) => d.id === claudeDirId) : undefined))
  const serves = sessionId ? surface.serves(sessionId) : true
  const terminal = session?.source === 'terminal'
  // A notice another row already answers, a terminal session's, and one on a
  // Mac not known to serve the routes read nothing.
  const reads = serves === true && !terminal && !place.restoredAfter && claudeDirId !== null
  const wait = session?.loginWait
  const entry = useProfileLogin(claudeDirId, machine, {
    enabled: reads,
    rereadKey: wait ? `${wait.kind}:${wait.running}` : 'none',
  })
  const key = claudeDirId === null ? '' : profileKey(claudeDirId, machine)
  const access = loginAccess(serves, entry.refused)
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
    const link = view.link && !surface.phone
    // A design sign-in's line is the DesignSync result's, which its tool row
    // already shows: the notice adds only the way to Settings.
    const text = kind === 'design' ? null : message.text
    if (!text && !link) return null
    return (
      <div data-login-notice="cli" className="flex flex-col gap-1.5">
        {text && <div className="font-mono fs-11 leading-[1.6] text-[rgba(160,190,225,.7)] [text-wrap:pretty]">{text}</div>}
        {/* 62d edge cases: shown, not driven — the profile logs in from Settings. */}
        {link && (
          <button
            type="button"
            onClick={() => openSettingsSection('profiles')}
            className="cursor-pointer self-start border-0 bg-transparent p-0 font-mono fs-10.5 text-[#8fd8ff] hover:text-[#c6ecff]"
          >
            log in from Settings → Profiles ›
          </button>
        )}
      </div>
    )
  }
  if (view.kind === 'restored') return <LoginDivider label={view.label} phone={surface.phone} />

  // Another device knows no names of the Mac's profiles; the Mac says it (§ 7).
  const name = entry.login?.name ?? dir?.name ?? null
  const design = kind === 'design'
  const verb = design ? 'Sign in' : 'Log in'
  const run = entry.login?.runs[kind] ?? null
  const act = (fn: () => Promise<void>) => () => {
    if (!offline && claudeDirId !== null) void fn()
  }
  const start = act(() => startLogin(claudeDirId!, kind, machine))
  const cancel = act(() => cancelLogin(claudeDirId!, kind, machine))
  const settingsLink = !remote && !surface.phone

  if (view.kind === 'running') {
    const copy = runningCopy(view.run, view.mine, remote, surface.phone, name, macName)
    return (
      <LoginRunning
        run={view.run}
        phone={surface.phone}
        copy={copy}
        also={sessionId ? waitingLine(view.run, sessionId, true) : null}
        error={entry.error}
        busy={Boolean(entry.busy[kind])}
        offline={offline}
        settingsLink={settingsLink}
        onCodeFocus={surface.onCodeFocus}
        onSubmit={(code) => (claudeDirId === null ? undefined : void submitLoginCode(claudeDirId, kind, code, machine))}
        onCancel={cancel}
      />
    )
  }

  const failed = view.kind === 'failed'
  const title = failed
    ? design
      ? 'Claude Design is still not signed in'
      : `${theProfile(name)} is still logged out`
    : design
      ? 'Claude Design isn’t signed in'
      : view.neverLoggedIn
        ? `${theProfile(name)} has never been logged in`
        : `${theProfile(name)} lost its login`
  const lost = view.kind === 'lost' ? view : null
  const reason = design
    ? 'DesignSync has no design credential'
    : [lost?.email, cliReason(message.text)].filter(Boolean).join(' · ')
  let sub: string
  let note: string | null = null
  if (failed) sub = view.message
  else if (lost?.access === 'no_grant') {
    // 62e/62h VARIANT · NO UPKEEP GRANT: no Log in, the Mac named.
    sub = `on ${macName} · ${verb.toLowerCase()} on that Mac to restore it`
    note = `this ${deviceWord(surface.phone)} has no “Upkeep of this Mac” grant`
  } else if (lost?.access === 'older_mac') {
    // 62h VARIANT · MAC NEEDS AN UPDATE: says what would make it possible.
    sub = `on ${macName} · that Mac needs an Orbital update before it can ${verb.toLowerCase()} from here`
    note = `or ${verb.toLowerCase()} on that Mac directly`
  } else if (remote) {
    // So does a Mac whose version is not known yet (`unknown`): the plain
    // reason, neither Log in nor "needs an update" until its hello says which.
    sub = `on ${macName} · ${reason}`
  } else if (lost?.neverLoggedIn && dir?.path) sub = claudeDirDisplayPath(dir.path)
  else sub = design ? `${profilePhrase(name)} · ${reason} (run /design-login)` : reason
  const cliAvailable = view.cliAvailable
  if (!cliAvailable) note = 'Orbital knows no Claude Code executable on this Mac.'
  const canStart = (failed || lost?.access === 'ok') && cliAvailable

  return (
    <LoginBlock
      phone={surface.phone}
      dot="needs"
      title={title}
      sub={sub}
      note={note}
      also={sessionId ? waitingLine(run, sessionId, false) : null}
      error={entry.error}
      settingsLink={settingsLink}
      action={
        canStart ? (
          <Button
            variant="lit"
            size={surface.phone ? 'touch' : 'login-row'}
            disabled={offline || Boolean(entry.busy[kind])}
            onClick={start}
          >
            {verb}
          </Button>
        ) : null
      }
    />
  )
}

/** What B says, and what it offers (62a, 62d B; 62e, 62h on another device). */
interface RunningCopy {
  title: string
  sub: string
  /** Cancel on the title row. */
  cancel: boolean
  /**
   * The code path: folded behind "Browser didn't open? ›" on this Mac, or
   * `unfolded` there when no browser opened at all (Cancel stays on the title
   * row); the path itself, with its own Cancel, elsewhere.
   */
  code: 'folded' | 'unfolded' | 'open' | null
}

function runningCopy(run: LoginRun, mine: boolean, remote: boolean, phone: boolean, name: string | null, macName: string): RunningCopy {
  const design = run.kind === 'design'
  const ing = design ? 'Signing in' : 'Logging in'
  if (!remote) {
    if (run.step === 'checking') return { title: 'Checking the code', sub: 'this updates by itself', cancel: false, code: null }
    // A login another device started: its code is entered there (62e "On the
    // Mac's own transcript the notice reads Logging in from Pixel 8 with Cancel").
    if (!mine) return { title: `${ing} from ${run.startedBy.name}`, sub: 'the code is entered there · nothing opens on this Mac', cancel: true, code: null }
    // Started by a session through Orbital's control tools: the CLI opened no
    // browser, so the code is the way, shown rather than folded.
    if (run.manualOnly) {
      return {
        title: design
          ? 'Sign in to Claude Design — open the sign-in page and paste the code'
          : `Log in to the ${profilePhrase(name)} — open the sign-in page and paste the code`,
        sub: `${run.startedBy.name} started the login · no browser opened`,
        cancel: true,
        code: run.manualUrl !== null ? 'unfolded' : null,
      }
    }
    return {
      title: design ? 'Finish signing in in your browser' : 'Finish logging in in your browser',
      sub: design
        ? `opened the Claude Design sign-in for the ${profilePhrase(name)} · this updates by itself`
        : `opened claude.ai for the ${profilePhrase(name)} · this updates by itself`,
      cancel: true,
      code: run.manualUrl !== null ? 'folded' : null,
    }
  }
  // On another device (62h): only the device that started it enters the code.
  if (run.startedBy.deviceId === null) {
    return { title: `${ing} on ${macName}`, sub: 'started on that Mac · this updates by itself', cancel: false, code: null }
  }
  if (!mine) return { title: `${ing} from ${run.startedBy.name}`, sub: 'the code is entered there · this updates by itself', cancel: false, code: null }
  if (run.step === 'checking') return { title: 'Checking the code', sub: `with ${macName} · nothing to do here`, cancel: false, code: null }
  return {
    title: design
      ? `Sign in to Claude Design from this ${deviceWord(phone)}`
      : `Log in to the ${profilePhrase(name)} from this ${deviceWord(phone)}`,
    sub: `${macName} started the login · nothing opens there`,
    cancel: false,
    code: run.manualUrl !== null ? 'open' : null,
  }
}

/** A `login_restored` row (live only, like `limit_reset`): the divider the notice folds into (62d C). */
export function LoginRestoredRow({ message }: { message: ChatMessage }) {
  const surface = useContext(LoginNoticeContext)
  const notice = message.notice?.login as LoginRestoredNotice | undefined
  if (!notice) return null
  return <LoginDivider label={restoredNoticeLabel(notice)} phone={surface.phone} />
}

/** 62a, 62d C: the past-tense line a restored login folds into. */
function LoginDivider({ label, phone }: { label: string; phone: boolean }) {
  return (
    <div
      data-login-restored
      className={[
        'flex items-center gap-2.5 font-mono fs-9.5 tracking-[0.12em] text-[rgba(160,190,225,.6)]',
        phone ? 'py-1' : 'py-0.5',
      ].join(' ')}
    >
      <span aria-hidden className="h-px flex-1 bg-[rgba(150,205,255,.12)]" />
      <span className="text-center [text-wrap:pretty]">{label}</span>
      <span aria-hidden className="h-px flex-1 bg-[rgba(150,205,255,.12)]" />
    </div>
  )
}

/** 62a, 62e: the notice's dot, and the hollow ring's ink while the login runs. */
const NOTICE_DOT_PX = 8
const REST_INK = 'rgba(214,230,248,.8)'
const REST_DOT = { shape: 'hollow', motion: 'steady' } as const

/**
 * The notice's box (62a on the Mac, 62e on the phone): the dot, the title,
 * the sub line with the CLI's sentence, a quieter note, the "waits on the
 * same login" line, and "profile settings ›" on the Mac. `needs` is the
 * amber of a session that needs you; `rests` the hollow neutral ring of one
 * waiting on the browser.
 */
function LoginBlock({
  phone,
  dot,
  title,
  sub,
  note = null,
  also = null,
  error = null,
  settingsLink,
  action,
  children,
}: {
  phone: boolean
  dot: 'needs' | 'rests'
  title: string
  sub: string
  note?: string | null
  also?: string | null
  error?: string | null
  settingsLink: boolean
  action: ReactNode
  children?: ReactNode
}) {
  // NEEDS INPUT's solid dot held steady, as a gate's is: a login can wait all night.
  const stateMark = (
    <StateDot
      dot={dot === 'needs' ? stateDot('needs_input', 'label', true) : REST_DOT}
      color={dot === 'needs' ? stateColor('needs_input') : REST_INK}
      solidPx={NOTICE_DOT_PX}
      hollowPx={NOTICE_DOT_PX}
    />
  )
  // On the phone the dot sits on the title's first line, not the row's middle (62e).
  const mark = phone ? <span className="mt-[7px] flex flex-none">{stateMark}</span> : stateMark
  if (phone) {
    return (
      <div
        data-login-notice={dot}
        className="flex flex-col gap-2.5 rounded-[12px] border border-[rgba(150,205,255,.16)] bg-[rgba(4,8,16,.5)] px-4 py-3.5"
      >
        <div className="flex items-start gap-2.5">
          {mark}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="fs-15 font-semibold leading-[1.35] text-text-bright [text-wrap:pretty]">{title}</span>
            <span className="font-mono fs-11.5 leading-[1.6] text-[rgba(160,190,225,.7)] [overflow-wrap:anywhere] [text-wrap:pretty]">
              {sub}
            </span>
            {note && (
              <span className="font-mono fs-11.5 leading-[1.6] text-[rgba(160,190,225,.5)] [text-wrap:pretty]">{note}</span>
            )}
            {also && <span className="font-mono fs-11.5 leading-[1.6] text-[rgba(160,190,225,.5)]">{also}</span>}
            {error && <span className="font-mono fs-11.5 leading-[1.6] text-[rgba(220,235,255,.85)]">{error}</span>}
          </div>
        </div>
        {action && <div className="flex pl-[18px]">{action}</div>}
        {children}
      </div>
    )
  }
  return (
    <div
      data-login-notice={dot}
      className="flex flex-col gap-2 rounded-[9px] border border-[rgba(150,205,255,.16)] bg-[rgba(4,8,16,.5)] px-3.5 py-3"
    >
      <div className="flex items-center gap-2.5">
        {mark}
        <span className="min-w-0 flex-1 fs-13 font-semibold text-text-bright">{title}</span>
        {action}
      </div>
      <div className="pl-[18px] font-mono fs-10.5 leading-[1.6] text-[rgba(160,190,225,.65)] [overflow-wrap:anywhere] [text-wrap:pretty]">
        {sub}
      </div>
      {note && <div className="pl-[18px] font-mono fs-10.5 leading-[1.6] text-[rgba(160,190,225,.5)] [text-wrap:pretty]">{note}</div>}
      {also && <div className="pl-[18px] font-mono fs-10.5 text-[rgba(160,190,225,.5)]">{also}</div>}
      {error && <div className="pl-[18px] font-mono fs-10.5 leading-[1.6] text-[rgba(220,235,255,.85)]">{error}</div>}
      {children}
      {settingsLink && (
        <div className="flex gap-3.5 pl-[18px] font-mono fs-10.5">
          <button
            type="button"
            onClick={() => openSettingsSection('profiles')}
            className="cursor-pointer border-0 bg-transparent p-0 font-mono fs-10.5 text-[#8fd8ff] hover:text-[#c6ecff]"
          >
            profile settings ›
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * B (62a, 62d; 62e, 62h on another device): the login runs. On this Mac
 * the browser path finishes it and the code path is folded behind "Browser
 * didn't open? ›", never unfolding by itself; on another device the code is
 * the path, never folded, and only the device that started it gets the
 * field.
 */
export function LoginRunning({
  run,
  phone,
  copy,
  also,
  error,
  busy,
  offline,
  settingsLink,
  onCodeFocus,
  onSubmit,
  onCancel,
}: {
  run: LoginRun
  phone: boolean
  copy: RunningCopy
  also: string | null
  error: string | null
  busy: boolean
  offline: boolean
  settingsLink: boolean
  onCodeFocus?: (focused: boolean) => void
  onSubmit: (code: string) => void
  onCancel: () => void
}) {
  const [unfolded, setUnfolded] = useState(false)
  const disabled = offline || busy
  return (
    <LoginBlock
      phone={phone}
      dot="rests"
      title={copy.title}
      sub={copy.sub}
      also={also}
      error={error}
      settingsLink={settingsLink}
      action={
        copy.cancel ? (
          <Button variant="ghost" size={phone ? 'touch' : 'login-row'} disabled={disabled} onClick={onCancel}>
            Cancel
          </Button>
        ) : null
      }
    >
      {copy.code === 'folded' && (
        <button
          type="button"
          aria-expanded={unfolded}
          onClick={() => setUnfolded((u) => !u)}
          className="ml-[18px] cursor-pointer self-start border-0 bg-transparent p-0 font-mono fs-10.5 text-[#8fd8ff] hover:text-[#c6ecff]"
        >
          {unfolded ? 'Hide ‹' : 'Browser didn’t open? ›'}
        </button>
      )}
      {run.manualUrl !== null && (copy.code === 'open' || copy.code === 'unfolded' || (copy.code === 'folded' && unfolded)) && (
        <LoginCodeEntry
          manualUrl={run.manualUrl}
          phone={phone}
          disabled={disabled}
          onFocusChange={onCodeFocus}
          onSubmit={onSubmit}
          onCancel={copy.code === 'open' ? onCancel : undefined}
        />
      )}
    </LoginBlock>
  )
}

/** How long after the code field lets go the phone's composer comes back. */
const COMPOSER_RETURN_MS = 250

/**
 * The code path, numbered as the canvas numbers it: 1 the sign-in page,
 * which shows a code, 2 the field it is pasted into. On the Mac (62d B ·
 * FALLBACK UNFOLDED) a quiet box with "copy link" and Submit beside the
 * field; on another device (62e) 44px rows, the field with its own Paste —
 * hidden where the WebView refuses the clipboard (spec § 6) — and Cancel /
 * Submit code on a row of their own, so a long code never pushes them off.
 * Submit stays dim until something is in the field.
 */
export function LoginCodeEntry({
  manualUrl,
  phone,
  disabled,
  onFocusChange,
  onSubmit,
  onCancel,
  indent = true,
}: {
  manualUrl: string
  phone: boolean
  disabled: boolean
  /** Under a notice's title, past its dot; Settings places it itself (62c). */
  indent?: boolean
  onFocusChange?: (focused: boolean) => void
  onSubmit: (code: string) => void
  /** Cancel beside Submit, where the code is the path (62e); the Mac's sits on the title row. */
  onCancel?: () => void
}) {
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState(false)
  const [pasteRefused, setPasteRefused] = useState(false)
  const read = useMemo(() => (phone ? clipboardReader() : null), [phone])
  const submitRef = useRef<HTMLDivElement>(null)
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

  const inputProps = {
    type: 'text',
    'aria-label': 'Sign-in code',
    autoComplete: 'one-time-code',
    autoCapitalize: 'off',
    autoCorrect: 'off',
    spellCheck: false,
    value: code,
    disabled,
    onChange: (e: ChangeEvent<HTMLInputElement>) => setCode(e.target.value),
    onFocus: () => {
      focused.current = true
      if (blurTimer.current) clearTimeout(blurTimer.current)
      onFocusChange?.(true)
    },
    onBlur: () => {
      focused.current = false
      // The composer comes back a beat after the field lets go: a tap on
      // Submit blurs the field first, and the composer returning at once
      // would move Submit out from under the finger.
      blurTimer.current = setTimeout(() => onFocusChange?.(false), COMPOSER_RETURN_MS)
    },
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        submit()
      }
    },
  } as const
  const step = (n: number, size: string) => (
    <span className={['w-2.5 flex-none font-mono text-[rgba(160,190,225,.5)]', size].join(' ')}>{n}</span>
  )

  if (phone || onCancel) {
    // 44px rows on the phone (62e); another Mac's are 32px (62e AIR-M3, 62g).
    const t = phone
    return (
      <div data-login-code className={['flex flex-col', t ? 'gap-2.5 pl-[18px]' : 'gap-2.5'].join(' ')}>
        <div className="flex items-center gap-2.5">
          {step(1, t ? 'fs-11.5' : 'fs-10.5')}
          <button
            type="button"
            onClick={() => openSignInPage(manualUrl)}
            className={[
              'flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 border border-[rgba(150,205,255,.18)] bg-transparent font-sans font-semibold text-[#8fd8ff] hover:bg-[rgba(150,205,255,.08)]',
              t ? 'min-h-11 rounded-[9px] px-3.5 fs-14' : 'min-h-8 rounded-[8px] px-3 fs-12.5',
            ].join(' ')}
          >
            <span>Open sign-in page</span>
            <span aria-hidden>↗</span>
          </button>
        </div>
        <div className="flex items-center gap-2.5">
          {step(2, t ? 'fs-11.5' : 'fs-10.5')}
          <div
            className={[
              'flex min-w-0 flex-1 items-center gap-1.5 border bg-[rgba(4,8,16,.6)] pr-1',
              t ? 'h-11 rounded-[9px] pl-3' : 'h-8 rounded-[8px] pl-2.5',
              code ? 'border-[oklch(85%_.12_205_/_.5)]' : 'border-[rgba(150,205,255,.16)]',
            ].join(' ')}
          >
            <input
              {...inputProps}
              placeholder="Paste the code the page shows"
              className={[
                'm-0 min-w-0 flex-1 text-ellipsis border-0 bg-transparent p-0 font-mono text-text-bright outline-none placeholder:text-[rgba(160,190,225,.45)]',
                t ? 'fs-12' : 'fs-11',
              ].join(' ')}
            />
            {read && !pasteRefused && (
              <button
                type="button"
                onClick={() => void paste()}
                disabled={disabled}
                className={[
                  'flex-none cursor-pointer border border-[rgba(150,205,255,.18)] bg-[rgba(150,205,255,.06)] font-sans font-semibold text-[rgba(220,235,255,.9)] disabled:opacity-40',
                  t ? 'min-h-9 rounded-[7px] px-3 fs-13' : 'min-h-6 rounded-[6px] px-2.5 fs-11.5',
                ].join(' ')}
              >
                Paste
              </button>
            )}
          </div>
        </div>
        <div ref={submitRef} className="flex justify-end gap-2">
          {onCancel && (
            <Button variant="ghost" size={t ? 'touch' : 'command'} disabled={disabled} onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button variant="lit" size={t ? 'touch' : 'command'} disabled={disabled || !ready} onClick={submit}>
            Submit code
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div
      data-login-code
      className={[
        indent ? 'ml-[18px]' : '',
        'flex flex-col gap-[9px] rounded-[8px] border border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.45)] px-3 py-2.5',
      ].join(' ')}
    >
      <div className="flex items-baseline gap-[9px] font-mono fs-10.5">
        {step(1, 'fs-10.5')}
        <button
          type="button"
          onClick={() => openSignInPage(manualUrl)}
          className="cursor-pointer border-0 bg-transparent p-0 font-mono fs-10.5 text-[#8fd8ff] hover:text-[#c6ecff]"
        >
          Open the sign-in page ↗
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => void copyToClipboard(manualUrl).then(setCopied)}
          className="cursor-pointer border-0 bg-transparent p-0 font-mono fs-10.5 text-[rgba(160,190,225,.55)] hover:text-[#c6ecff]"
        >
          {copied ? 'copied' : 'copy link'}
        </button>
      </div>
      <div className="flex items-center gap-[9px]">
        {step(2, 'fs-10.5')}
        <input
          {...inputProps}
          placeholder="Paste the code that page shows"
          className="m-0 min-w-0 flex-1 rounded-[7px] border border-[rgba(150,205,255,.16)] bg-[rgba(4,8,16,.6)] px-[9px] py-1.5 font-mono fs-11 text-text-bright outline-none placeholder:text-[rgba(160,190,225,.45)] focus:border-[oklch(85%_.12_205_/_.5)] focus:shadow-[0_0_0_3px_oklch(85%_.12_205_/_.1)]"
        />
        <Button variant="lit" size="command" disabled={disabled || !ready} onClick={submit}>
          Submit
        </Button>
      </div>
    </div>
  )
}

/**
 * The Desk card's answer to a lost login (canvas 62b): the card carries it
 * the way it carries a question form — a chip naming what is needed, one
 * sentence, one button. The same profile state as the transcript's notice,
 * so answering one answers both; the detail panel keeps the full notice.
 */
export function LoginCardBlock({ session, offline }: { session: ApiSession; offline: boolean }) {
  const wait = session.loginWait
  const machine = session.machine?.id
  const remote = machine !== undefined
  const entry = useProfileLogin(wait?.claudeDirId, machine, { rereadKey: wait ? `${wait.kind}:${wait.running}` : 'none' })
  const localDir = useOrbital((s) => (remote || !wait ? undefined : s.claudeDirs.find((d) => d.id === wait.claudeDirId)))
  if (!wait) return null
  const { kind, claudeDirId } = wait
  const design = kind === 'design'
  const name = entry.login?.name ?? localDir?.name ?? null
  const run = entry.login?.runs[kind] ?? null
  const running = run?.state === 'running' && entry.refused === null
  const failed = run?.state === 'failed' ? run.message : null
  const fromElsewhere = running && run.startedBy.deviceId !== null && !startedHere(profileKey(claudeDirId, machine), run, remote)
  // Started by a session, nothing opened a browser: the code is pasted in the session's notice.
  const noBrowser = running && !fromElsewhere && run.manualOnly
  const chip = running
    ? fromElsewhere || noBrowser
      ? `FROM ${run.startedBy.name.toUpperCase()}`
      : 'IN THE BROWSER'
    : design
      ? 'CLAUDE DESIGN'
      : 'LOG IN'
  // The account the login was, as `.claude.json` still names it (spec § 4).
  const email = localDir?.account ?? null
  const text = running
    ? fromElsewhere
      ? `Started from ${run.startedBy.name}; the code is entered there.`
      : noBrowser
        ? 'No browser opened; paste the sign-in code in the session’s notice.'
        : 'Finish in the browser window Orbital opened.'
    : failed
      ? failed
      : design
        ? `Claude Design isn’t signed in for the ${profilePhrase(name)}.`
        : `${theProfile(name)} lost its login${email ? ` (${email})` : ''}.`
  const canStart = entry.refused === null && (entry.login?.cliAvailable ?? true)
  return (
    <div
      data-login-card
      className="flex flex-col gap-[9px] rounded-[10px] border border-[rgba(150,205,255,.16)] bg-[rgba(5,9,18,.82)] bg-[image:linear-gradient(180deg,rgba(10,16,28,.72),rgba(5,9,18,.82))] px-3 pb-3 pt-[11px]"
    >
      <div className="flex items-center gap-2">
        <span
          className={[
            'rounded-[4px] border px-[7px] py-0.5 font-mono fs-9.5 tracking-[0.14em]',
            running
              ? 'border-[rgba(150,205,255,.22)] bg-transparent text-[rgba(214,230,248,.8)]'
              : 'border-[rgba(255,187,123,.35)] bg-[rgba(255,187,123,.1)] text-[#ffd2a8]',
          ].join(' ')}
        >
          {chip}
        </span>
      </div>
      <div className="fs-12.5 leading-[1.5] text-[rgba(232,238,248,.94)] [text-wrap:pretty]">{text}</div>
      {(running || canStart) && (
        <div className="flex gap-1.5">
          {running ? (
            <Button
              variant="ghost"
              size="login-card"
              disabled={offline || Boolean(entry.busy[kind])}
              onClick={() => void cancelLogin(claudeDirId, kind, machine)}
            >
              Cancel
            </Button>
          ) : (
            <Button
              variant="lit"
              size="login-card"
              disabled={offline || Boolean(entry.busy[kind])}
              onClick={() => void startLogin(claudeDirId, kind, machine)}
            >
              {design ? 'Sign in' : 'Log in'}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
