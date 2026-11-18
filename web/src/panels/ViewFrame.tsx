import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { VIEW_HEIGHT, clampViewHeight, type ViewPayload, type ViewResult } from '@orbital/shared/views'
import { useViewColours } from '../lib/views/theme'
import { buildViewDocument, viewThemeVars, type ViewTheme } from '../lib/views/document'
import { approveViewDomains, currentViewSource, viewDataOf, viewErrorMessage, viewMessage } from '../lib/views/load'
import { failureText, readFrameMessage, themeMessage, type ViewError } from '../lib/views/protocol'
import { loadReactRuntime, loadViewFonts } from '../lib/views/runtime'
import { useOrbital } from '../store/store'
import { ViewGlyph, ViewPlaceholder, VIEW_BUTTON_PRIMARY, VIEW_BUTTON_QUIET } from './ViewParts'

/**
 * A generated view (spec 2026-11-18-generated-views-design; canvas `Feature -
 * Views` 69a–69e): Orbital draws the header and the edge, the page draws
 * everything inside, in an `<iframe sandbox="allow-scripts">` — an opaque
 * origin with no reach into Orbital.
 *
 * `surface`: `panel` in the desktop's transcript, `phone` in the phone's
 * (the phone's height cap, 44 px controls), `maximised` in the media viewer
 * (24e's box, no maximise of its own, never put to sleep).
 *
 * The frame's states, each in its place (69b, 69c): live, asking to fetch,
 * not loaded, loading (also after sleeping), waiting for the user, sent,
 * failed. Its height is the session's, clamped; content taller than that
 * scrolls inside, and the wheel stays with the transcript until a click
 * into the view.
 */
export interface ViewFrameProps {
  sessionId: string
  /** The call drawn: the view's newest. */
  toolUseId: string
  surface: 'panel' | 'phone' | 'maximised'
  /** ⤢: opens the view maximised. Absent, no button. */
  onMaximise?: () => void
  /** Escape pressed inside the page (the maximised viewer closes on it). */
  onEscape?: () => void
  /** When the call's result arrived, for SENT hh:mm (69c). */
  resultAt?: string
  /** The session's device cannot be reached: nothing is sent from the view. */
  offline?: boolean
  /** `maximised`: the content's height; 69d's viewer draws it at 560. */
  maximisedHeight?: number
}

/** 69d: the maximised view's content, 560 px under its 34 px header in the 600 px box. */
export const MAXIMISED_CONTENT_PX = 560
/** 69c FAILED: "in place, at a fixed 196 px". */
const FAILED_PX = 196
/**
 * 69c ASLEEP: "off screen for a while, the page is unloaded". How long a
 * while is, the canvas does not say: not traced.
 */
const SLEEP_AFTER_MS = 30_000
/** How far outside the scroller a view still counts as on screen. Not traced. */
const SLEEP_MARGIN = '400px 0px'

type Load =
  | { state: 'loading' }
  | { state: 'failed'; message: string }
  | { state: 'loaded'; payload: ViewPayload }

/** The house clock reading, as `MessageView` writes it. */
function clock(at: string | number | undefined): string {
  if (at === undefined) return ''
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** What was sent, short enough for the footer: a list of words joined, a string as is, anything else as JSON. */
export function sentSummary(value: unknown): string {
  const text = Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'number')
    ? value.join(', ')
    : typeof value === 'string'
      ? value
      : JSON.stringify(value)
  const line = (text ?? 'nothing').replace(/\s+/g, ' ').trim()
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

function textScale(): number {
  if (typeof getComputedStyle === 'undefined') return 1
  const style = getComputedStyle(document.documentElement)
  const raw = style.getPropertyValue('--transcript-text-scale').trim() || style.getPropertyValue('--text-scale').trim()
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : 1
}

/** The domains of a view that are allowed now: the payload's, and any allowed since. */
function allowedOf(payload: ViewPayload, sessionDomains: readonly string[] | undefined): Set<string> {
  return new Set([...payload.approvedDomains, ...(sessionDomains ?? [])].map((d) => d.toLowerCase()))
}

export function ViewFrame({
  sessionId,
  toolUseId,
  surface,
  onMaximise,
  onEscape,
  resultAt,
  offline = false,
  maximisedHeight = MAXIMISED_CONTENT_PX,
}: ViewFrameProps) {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [reloads, setReloads] = useState(0)

  const pending = useOrbital((s) => s.pendingDecisions[sessionId])
  const waitingHere = pending?.kind === 'view' && pending.id === toolUseId
  const answer = useOrbital((s) => s.viewAnswers[toolUseId])
  const sessionDomains = useOrbital((s) => s.viewDomains[sessionId])
  const setViewDomains = useOrbital((s) => s.setViewDomains)
  const answerView = useOrbital((s) => s.answerView)
  const sendViewMessage = useOrbital((s) => s.sendViewMessage)

  // The payload: on mount, on Reload, and once a wait ends — the result is
  // what the sent state says.
  const waitedRef = useRef(waitingHere)
  const [resultSeq, setResultSeq] = useState(0)
  useEffect(() => {
    if (waitedRef.current && !waitingHere) setResultSeq((n) => n + 1)
    waitedRef.current = waitingHere
  }, [waitingHere])
  useEffect(() => {
    let live = true
    currentViewSource()
      .payload(sessionId, toolUseId)
      .then((payload) => live && setLoad({ state: 'loaded', payload }))
      .catch((err: unknown) => {
        if (!live) return
        setLoad((before) =>
          // A refresh that fails keeps what was drawn.
          before.state === 'loaded' ? before : { state: 'failed', message: err instanceof Error ? err.message : String(err) },
        )
      })
    return () => {
      live = false
    }
  }, [sessionId, toolUseId, reloads, resultSeq])

  const payload = load.state === 'loaded' ? load.payload : null
  const title = payload?.title ?? ''
  const height =
    surface === 'maximised'
      ? maximisedHeight
      : clampViewHeight(payload?.height ?? VIEW_HEIGHT.default, surface === 'phone')

  // Domains: asked, allowed (here or anywhere), or turned down here.
  const allowed = useMemo(() => (payload ? allowedOf(payload, sessionDomains) : new Set<string>()), [payload, sessionDomains])
  const asked = useMemo(() => payload?.liveDomains ?? [], [payload])
  const needsAllow = asked.some((d) => !allowed.has(d.toLowerCase()))
  const [declined, setDeclined] = useState(false)
  const [allowing, setAllowing] = useState(false)
  const allow = () => {
    if (!payload || allowing) return
    setAllowing(true)
    setDeclined(false)
    approveViewDomains(sessionId, asked)
      .then((domains) => setViewDomains(sessionId, domains))
      .catch(() => setDeclined(false))
      .finally(() => setAllowing(false))
  }

  // What was answered: this tab's own answer first, else the call's result.
  const result: ViewResult | null = payload?.result ?? null
  const answered = Boolean(answer) || (payload?.wait === true && result !== null && !waitingHere)
  const waiting = waitingHere && !answer

  // Asleep (69c): out of sight for a while, the page is unloaded; a waiting
  // view never is, nor the maximised one.
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [asleep, setAsleep] = useState(false)
  const canSleep = surface !== 'maximised' && !waiting
  useEffect(() => {
    const el = rootRef.current
    if (!el || !canSleep || typeof IntersectionObserver === 'undefined') {
      setAsleep(false)
      return
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting)
        if (visible) {
          if (timer) clearTimeout(timer)
          timer = null
          setAsleep(false)
        } else if (!timer) {
          timer = setTimeout(() => setAsleep(true), SLEEP_AFTER_MS)
        }
      },
      { rootMargin: SLEEP_MARGIN },
    )
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (timer) clearTimeout(timer)
    }
  }, [canSleep])

  // The page, built once the payload is in, the domains are settled and the view is awake.
  const colours = useViewColours()
  const coloursRef = useRef(colours)
  coloursRef.current = colours
  const approvedForPage = useMemo(() => asked.filter((d) => allowed.has(d.toLowerCase())), [asked, allowed])
  const approvedKey = approvedForPage.join(' ')
  const [doc, setDoc] = useState<{ srcdoc: string; key: number } | null>(null)
  const [error, setError] = useState<ViewError | null>(null)
  const [ready, setReady] = useState(false)
  const [contentHeight, setContentHeight] = useState(0)
  const build = payload !== null && !needsAllow && !asleep
  useEffect(() => {
    setDoc(null)
    setReady(false)
    setError(null)
    setContentHeight(0)
    if (!build || !payload) return
    let live = true
    const theme: ViewTheme = { colours: coloursRef.current, textScale: textScale() }
    Promise.all([
      loadViewFonts(),
      payload.kind === 'react' ? loadReactRuntime() : Promise.resolve(undefined),
      viewDataOf(sessionId, payload),
    ])
      .then(([fonts, runtime, data]) => {
        if (!live) return
        const srcdoc = buildViewDocument({
          payload: { ...payload, approvedDomains: approvedKey ? approvedKey.split(' ') : [] },
          data,
          theme,
          fonts,
          runtime,
        })
        setDoc((before) => ({ srcdoc, key: (before?.key ?? 0) + 1 }))
      })
      .catch((err: unknown) => {
        if (live) setError({ kind: 'page', message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      live = false
    }
    // `payload` changes identity on every refresh; the page is rebuilt only for what it draws from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [build, payload?.toolUseId, payload?.kind, approvedKey, reloads, sessionId])

  // The frame and what it says.
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const loadsRef = useRef(0)
  const lastSendAt = useRef<number | null>(null)
  const [blocked, setBlocked] = useState(false)
  const latest = useRef({ waiting, answered, pending, offline, payload, onEscape })
  latest.current = { waiting, answered, pending, offline, payload, onEscape }
  useEffect(() => {
    if (!pending) setBlocked(false)
  }, [pending])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const now = latest.current
      const action = readFrameMessage(event, {
        frame: frameRef.current?.contentWindow ?? null,
        userActive: typeof navigator !== 'undefined' && navigator.userActivation ? navigator.userActivation.isActive : false,
        now: Date.now(),
        lastSendAt: lastSendAt.current,
        waiting: now.waiting,
        answered: now.answered,
        otherDecisionPending: now.pending !== undefined && now.pending.id !== toolUseId,
        offline: now.offline,
      })
      switch (action.kind) {
        case 'ready':
          setReady(true)
          return
        case 'height':
          setContentHeight(action.height)
          return
        case 'error':
          setError((before) => before ?? action.error)
          return
        case 'open':
          window.open(action.url, '_blank', 'noopener')
          return
        case 'escape':
          now.onEscape?.()
          return
        case 'send':
          lastSendAt.current = Date.now()
          if (action.as === 'answer') answerView(sessionId, toolUseId, { value: action.value })
          else if (now.payload) void sendViewMessage(sessionId, viewMessage(now.payload, action.value))
          return
        case 'refused':
          if (action.reason === 'blocked') setBlocked(true)
          return
        case 'ignore':
          return
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [sessionId, toolUseId, answerView, sendViewMessage])

  // A new colour theme reaches a page that is up without reloading it.
  const vars = useMemo(() => viewThemeVars({ colours, textScale: textScale() }), [colours])
  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(themeMessage(vars), '*')
  }, [vars])

  // A second `load` is the page navigating itself away: put it back, as failed.
  const onFrameLoad = () => {
    loadsRef.current += 1
    if (loadsRef.current > 1) {
      setError({ kind: 'page', message: 'The page navigated away from itself' })
      setDoc(null)
    }
  }
  useEffect(() => {
    loadsRef.current = 0
  }, [doc?.key])

  const reload = useCallback(() => {
    setReloads((n) => n + 1)
  }, [])

  const [errorSent, setErrorSent] = useState(false)
  useEffect(() => setErrorSent(false), [error])
  const sendError = () => {
    if (!payload || !error) return
    const { detail } = failureText(error)
    setErrorSent(true)
    void sendViewMessage(sessionId, viewErrorMessage(payload, detail)).then((ok) => ok || setErrorSent(false))
  }

  // The wheel stays with the transcript until a click into a view that scrolls inside.
  const [engaged, setEngaged] = useState(false)
  const clipped = contentHeight > height + 1 && error === null
  const phone = surface === 'phone'

  // ---- What the frame shows
  const failed = error !== null || load.state === 'failed'
  const failure = error
    ? failureText(error)
    : load.state === 'failed'
      ? { title: 'This view could not be read', detail: load.message, hint: 'Reload asks the session’s Mac again.' }
      : null
  const tag = waiting ? 'PENDING' : answered ? `SENT${clock(resultAt ?? answer?.at) ? ` ${clock(resultAt ?? answer?.at)}` : ''}` : 'VIEW'
  const tagInk = waiting ? 'text-accent' : 'text-ink-900/60'
  const edge = waiting ? 'border-accent/30' : answered ? 'border-line/12' : 'border-line/16'

  const footer = waiting
    ? { dot: true, ink: 'text-ink-200/80', text: 'Waiting for you · answer in the view, then send it' }
    : blocked
      ? { dot: false, ink: 'text-ink-200/80', text: 'The session is waiting on another answer · answer that first' }
      : answered && !failed
        ? { dot: false, ink: 'text-ink-900/60', text: `Read only · ${answeredText(answer, result)}` }
        : clipped && !needsAllow && !asleep
          ? {
              dot: false,
              ink: 'text-ink-900/60',
              text: `scrolls inside · ${height} of ${contentHeight} px${onMaximise && surface !== 'maximised' ? ' · ⤢ shows it whole' : ''}`,
            }
          : null

  const domainChips = asked.length > 0 ? [`↗ ${asked[0]}`, ...(asked.length > 1 ? [`+${asked.length - 1}`] : [])] : []

  let body: ReactNode
  if (failed && failure) {
    body = (
      <div className="flex h-full flex-col gap-2 bg-space/60 p-4">
        <div className="flex items-center gap-2 fs-13 font-semibold text-ink-100">
          <span
            aria-hidden
            className="grid h-4 w-4 flex-none place-items-center rounded-full border-[1.3px] border-danger-soft fs-10 font-bold text-danger-soft"
          >
            !
          </span>
          {failure.title}
        </div>
        <div
          data-selectable
          className="break-words rounded-[7px] border border-line/8 bg-space/60 px-2.5 py-2 font-mono fs-11 leading-[1.5] text-ink-200/80"
        >
          {failure.detail}
        </div>
        <div className="fs-11.5 leading-[1.45] text-ink-900/60">{failure.hint}</div>
        <div className="mt-auto flex gap-2">
          <button type="button" onClick={reload} className={[VIEW_BUTTON_QUIET, phone ? 'min-h-11' : ''].join(' ')}>
            Reload
          </button>
          {error && payload && (
            <button
              type="button"
              onClick={sendError}
              disabled={errorSent || pending !== undefined || offline}
              title={pending !== undefined ? 'The session is waiting on an answer; send it after' : undefined}
              className={[VIEW_BUTTON_QUIET, phone ? 'min-h-11' : ''].join(' ')}
            >
              {errorSent ? 'Sent to the session' : 'Send the error to the session'}
            </button>
          )}
        </div>
      </div>
    )
  } else if (!payload) {
    body = <ViewPlaceholder>Loading view…</ViewPlaceholder>
  } else if (needsAllow && declined) {
    body = (
      <ViewPlaceholder>
        Not loaded ·{' '}
        <button type="button" onClick={allow} className="cursor-pointer border-0 bg-transparent p-0 font-mono text-sky">
          allow
        </button>
      </ViewPlaceholder>
    )
  } else if (needsAllow) {
    body = (
      <div className="flex h-full flex-col gap-2.5 bg-space/60 px-4 pb-3.5 pt-4">
        <div className="fs-13 leading-[1.5] text-ink-100">This view wants to fetch data from:</div>
        <div className="flex flex-col gap-1">
          {asked.map((domain) => (
            <div key={domain} className="flex items-center gap-2 font-mono fs-12 text-ink-50">
              <span aria-hidden className="text-ink-900/60">
                ↗
              </span>
              {domain}
            </div>
          ))}
        </div>
        <div className="fs-11.5 leading-[1.45] text-ink-900/60">
          Nothing loads until you allow it. Allowed for the rest of this session.
        </div>
        <div className="mt-auto flex gap-2">
          <button
            type="button"
            onClick={allow}
            disabled={allowing}
            className={[VIEW_BUTTON_PRIMARY, phone ? 'min-h-11' : ''].join(' ')}
          >
            Allow
          </button>
          <button type="button" onClick={() => setDeclined(true)} className={[VIEW_BUTTON_QUIET, phone ? 'min-h-11' : ''].join(' ')}>
            Don’t load
          </button>
        </div>
      </div>
    )
  } else {
    body = (
      <>
        {doc && (
          <iframe
            key={doc.key}
            ref={frameRef}
            title={title}
            sandbox="allow-scripts"
            srcDoc={doc.srcdoc}
            onLoad={onFrameLoad}
            className="block h-full w-full border-0 bg-space"
          />
        )}
        {(!doc || !ready) && (
          <div className="absolute inset-0">
            <ViewPlaceholder>Loading view…</ViewPlaceholder>
          </div>
        )}
        {clipped && ready && (
          // 69b TALLER THAN 480: a fade at the foot over the scrolling page.
          <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-[linear-gradient(180deg,transparent,var(--color-space))]" />
        )}
        {clipped && ready && !engaged && surface !== 'maximised' && (
          // The wheel goes to the transcript; a click hands the view the pointer.
          <div aria-hidden className="absolute inset-0 cursor-pointer" onPointerDown={() => setEngaged(true)} />
        )}
        {answered && (
          // 69c SENT: the page keeps what was selected and takes no input.
          <div title="Read only" className="absolute inset-0 cursor-default" />
        )}
      </>
    )
  }

  return (
    <div
      ref={rootRef}
      data-view-frame
      data-view-id={payload?.viewId}
      onClick={surface === 'maximised' ? (event) => event.stopPropagation() : undefined}
      onPointerLeave={() => setEngaged(false)}
      className={[
        'w-full flex-none overflow-hidden rounded-[11px] border bg-panel-solid/96',
        edge,
      ].join(' ')}
    >
      {/* 69b: the window glyph, the name, the tag, the domains and ⤢, over a hairline. */}
      <div className={['flex items-center gap-2 border-b border-line/8 pl-[11px] pr-1.5', phone ? 'h-11' : 'h-[34px]'].join(' ')}>
        <span className="flex text-ink-900/60">
          <ViewGlyph />
        </span>
        <span className="min-w-0 flex-[0_1_auto] truncate fs-12.5 font-semibold text-ink-100">{title}</span>
        <span className={['flex-none font-mono fs-9.5 tracking-[0.12em]', tagInk].join(' ')}>{tag}</span>
        <span className="flex-1" />
        {domainChips.map((chip, i) => (
          <span
            key={chip}
            title={i === 0 ? asked[0] : asked.slice(1).join('\n')}
            className="flex h-5 flex-none items-center gap-1 whitespace-nowrap rounded-[5px] border border-line/16 px-[7px] font-mono fs-10 text-ink-200/80"
          >
            {chip}
          </span>
        ))}
        {onMaximise && surface !== 'maximised' && (
          <button
            type="button"
            title="Maximise"
            aria-label="Maximise"
            onClick={onMaximise}
            className={[
              'grid flex-none cursor-pointer place-items-center rounded-[6px] border-0 bg-transparent p-0 text-ink-200/80 hover:bg-line/14 hover:text-ink-50',
              phone ? 'h-11 w-11' : 'h-[26px] w-[26px]',
            ].join(' ')}
          >
            <MaximiseGlyph />
          </button>
        )}
      </div>
      <div className="relative bg-space" style={{ height: failed ? FAILED_PX : height }}>
        {asleep && payload && !failed ? <ViewPlaceholder>Loading view…</ViewPlaceholder> : body}
      </div>
      {footer && (
        <div className={['flex min-h-[30px] items-center gap-2 border-t border-line/8 px-[11px] py-1.5 font-mono fs-10 leading-[1.5]', footer.ink].join(' ')}>
          {footer.dot && <span aria-hidden className="h-1.5 w-1.5 flex-none rounded-full bg-accent" />}
          <span>{footer.text}</span>
        </div>
      )}
    </div>
  )
}

/** The footer's words for an answered view (69c SENT says what was sent). */
function answeredText(answer: { at: number } & ({ value: unknown } | { text: string }) | undefined, result: ViewResult | null): string {
  if (answer) return 'text' in answer ? 'answered in words' : `sent ${sentSummary(answer.value)}`
  switch (result?.outcome) {
    case 'sent':
      return `sent ${sentSummary(result.value)}`
    case 'answered':
      return 'answered in words'
    case 'cancelled':
      return 'nothing was sent'
    default:
      return 'sent'
  }
}

/** 69b: ⤢, two corners. */
function MaximiseGlyph() {
  return (
    <span aria-hidden className="relative block h-[11px] w-[11px]">
      <span className="absolute right-0 top-0 block h-[5px] w-[5px] border-r-[1.4px] border-t-[1.4px] border-current" />
      <span className="absolute bottom-0 left-0 block h-[5px] w-[5px] border-b-[1.4px] border-l-[1.4px] border-current" />
    </span>
  )
}
