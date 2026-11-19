import { useOrbital } from './store'
import {
  snapshotOf,
  useContextReport,
  type OpenContextReport,
  type ReportFailure,
  type ReportOrigin,
  type ReportPreview,
  type ReportSnapshot,
} from './contextReport'
import { ApiError, api, type ContextReportAnswer } from '../lib/api'
import { isMemberOffline } from '../lib/devices'
import { recordError } from '../lib/errors'
import { contextWindowFor } from '../lib/models'
import type { ApiSession, ChatMessage } from '../lib/types'

/**
 * Opening the `/context` report from where Orbital shows how full the window
 * is — the Mac detail panel's context read-out, the phone's session header —
 * with no `/context` typed and nothing added to the transcript (spec
 * 2026-11-19-context-report-dialog-design § Opening it from the context
 * read-out; canvas `Feature - Context report from the read-out` 71a–71e).
 *
 * The Mac keeps each session's latest report, whichever way it was taken
 * (`contextReportAt` on the session). A session Orbital runs right now takes
 * a fresh one; any other opens the kept one. Against an older Mac, which
 * keeps none and has no route, the read-out opens the last `/context` in the
 * loaded transcript.
 */

/**
 * Where the read-out's report comes from: taken now, the Mac's kept one,
 * the loaded transcript's last `/context` (an older Mac), or nowhere — and
 * then the read-out offers nothing (canvas 71b).
 */
export type ReportSource = 'live' | 'kept' | 'transcript' | null

/** What `takeReport` did: opened a fresh report, a kept or transcript one, a failure, or nothing. */
export type TakeOutcome = 'live' | 'kept' | 'transcript' | 'failed' | 'none'

/**
 * Whether the device a session runs on is out of reach now: the phone's
 * Mac asleep, which is a failure there (canvas 71e). Never on the Mac; the
 * phone sets it (`mobile/boot.ts`).
 */
let asleep: (sessionId: string) => boolean = () => false

export function configureTakeReport(opts: { asleep: (sessionId: string) => boolean }): void {
  asleep = opts.asleep
}

/** A session Orbital holds a live query for, as the client can tell: its own, working or waiting. */
function isLiveOrbitalSession(session: Pick<ApiSession, 'source' | 'status'> | undefined): boolean {
  return session?.source === 'web' && (session.status === 'working' || session.status === 'needs_input')
}

const latest = new WeakMap<readonly ChatMessage[], ChatMessage | null>()

/**
 * The newest `/context` answer in a transcript that carries a report, or
 * null. Remembered per transcript array, which the store replaces on every
 * change, so a read-out asking on every render scans each version once.
 */
export function latestContextAnswer(messages: readonly ChatMessage[] | undefined): ChatMessage | null {
  if (!messages) return null
  const known = latest.get(messages)
  if (known !== undefined) return known
  let found: ChatMessage | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'notice' && messages[i].notice?.contextReport) {
      found = messages[i]
      break
    }
  }
  latest.set(messages, found)
  return found
}

/** Where a report for this session would come from right now; null when there is nothing to open. */
export function reportSourceFor(
  session: Pick<ApiSession, 'source' | 'status' | 'contextReportAt'> | undefined,
  messages: readonly ChatMessage[] | undefined,
): ReportSource {
  if (!session) return null
  // An older Mac sends no `contextReportAt`: it keeps nothing and has no route to ask.
  if (session.contextReportAt === undefined) return latestContextAnswer(messages) ? 'transcript' : null
  if (isLiveOrbitalSession(session)) return 'live'
  if (session.contextReportAt !== null) return 'kept'
  // A newer Mac keeps a session's /context only once its transcript is next
  // indexed: until then the loaded transcript's own is still there to open.
  return latestContextAnswer(messages) ? 'transcript' : null
}

/**
 * Whether the read-out opens a report (`ReportSource` not null), as a hook:
 * the affordance — "report ›", the hover, the pointer, the phone's tap into
 * the report sheet — is there only when it is.
 */
export function useReportSource(sessionId: string): ReportSource {
  return useOrbital((s) => reportSourceFor(s.sessions[sessionId], s.transcripts[sessionId]))
}

/** What the footer of a report from the read-out says about its session (canvas 71d). */
export function originOf(session: Pick<ApiSession, 'source' | 'status'> | undefined): ReportOrigin {
  if (session?.status === 'ended') return 'ended'
  return session?.source === 'terminal' ? 'terminal' : 'readout'
}

/** What the read-out shows — used, window and model — or null when it does not know both numbers. */
export function previewOf(session: ApiSession | undefined): ReportPreview | null {
  if (!session || session.contextUsedTokens == null) return null
  const { models, contextWindows } = useOrbital.getState()
  const window = contextWindowFor(session, models, contextWindows)
  if (window === null || window <= 0) return null
  return { used: session.contextUsedTokens, window, model: session.resolvedModel ?? session.model ?? null }
}

let ticket = 0

/**
 * Opens `sessionId`'s report from the read-out, as `ReportSource` says.
 *
 * - `transcript`: the loaded transcript's last `/context`, at once.
 * - `kept`: the transcript's `/context` at once when it is the kept one;
 *   else the kept one is fetched, the dialog open meanwhile.
 * - `live`: the dialog opens at once with the preview (`loading`, counting),
 *   and the fresh report fills it in when it comes.
 *
 * A failure keeps the dialog open with why, Try again (`takeReport` again,
 * with the opening's `key`) and the earlier report — the Mac's, else the
 * transcript's. An answer for an opening that has been closed or replaced
 * meanwhile, or that a later `takeReport` superseded, is dropped. Nothing
 * here touches the transcript.
 */
export async function takeReport(sessionId: string, opts: { key?: string } = {}): Promise<TakeOutcome> {
  const { sessions, transcripts } = useOrbital.getState()
  const session = sessions[sessionId]
  const source = reportSourceFor(session, transcripts[sessionId])
  if (source === null) return 'none'
  const origin = originOf(session)
  const twin = latestContextAnswer(transcripts[sessionId])
  const twinSnapshot = twin ? snapshotOf(twin) : null
  const key = opts.key ?? `readout:${sessionId}:${++ticket}`
  const base = { sessionId, key, origin, preview: previewOf(session) }
  const show = (open: Omit<OpenContextReport, 'sessionId' | 'key' | 'origin' | 'preview'>) =>
    useContextReport.getState().showReport({ ...base, ...open })

  if (source === 'transcript' || (source === 'kept' && twinSnapshot && isKeptTwin(twinSnapshot, session))) {
    if (!twinSnapshot) return 'none'
    show({ phase: 'ready', snapshot: twinSnapshot })
    return source
  }

  if (asleep(sessionId)) {
    show({ phase: 'failed', snapshot: null, failure: 'asleep', earlier: twinSnapshot })
    return 'failed'
  }

  const mine = ++ticket
  show({ phase: 'loading', snapshot: null, counting: source === 'live' })
  let answer: ContextReportAnswer | null
  let failure: ReportFailure | null = null
  try {
    answer = await api.contextReport(sessionId)
  } catch (err) {
    answer = null
    failure = thrownFailure(err)
    // Anything but the Mac out of reach is a failure worth keeping: the
    // dialog says it in its own place, so no toast.
    if (failure === 'failed') recordError(err, 'Could not take the context report')
  }
  if (mine !== ticket || useContextReport.getState().open?.key !== key) return 'none'

  if (answer && 'report' in answer) {
    show({ phase: 'ready', snapshot: { report: answer.report, takenAt: answer.takenAt, text: null } })
    return answer.fresh ? 'live' : 'kept'
  }
  const earlier: ReportSnapshot | null =
    answer?.earlier ? { report: answer.earlier.report, takenAt: answer.earlier.takenAt, text: null } : twinSnapshot
  show({ phase: 'failed', snapshot: null, failure: failure ?? failureOf(answer), earlier })
  return 'failed'
}

function failureOf(answer: ContextReportAnswer | null): ReportFailure {
  return answer && 'error' in answer && answer.error === 'timeout' ? 'timeout' : 'failed'
}

/**
 * What a thrown `api.contextReport` means. Out of reach (`unreachable`): an
 * older Mac without the route (a 404 with no error it names — the named ones
 * come back as values), a member Mac of the group offline, or a request that
 * never got an answer — the network, or the phone's tunnel, which rejects
 * with a `TypeError` as `fetch` does. Any other status is the Mac failing.
 */
function thrownFailure(err: unknown): ReportFailure {
  if (!(err instanceof ApiError)) return 'unreachable'
  return err.status === 404 || isMemberOffline(err) ? 'unreachable' : 'failed'
}

/** Whether the transcript's last `/context` is the report the Mac keeps: then it opens without asking. */
function isKeptTwin(twin: ReportSnapshot, session: ApiSession | undefined): boolean {
  return twin.takenAt !== null && session?.contextReportAt != null && Date.parse(twin.takenAt) >= session.contextReportAt
}
