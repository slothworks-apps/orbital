import { useOrbital } from './store'
import { openingOf, useContextReport } from './contextReport'
import { api } from '../lib/api'
import type { ApiSession, ChatMessage } from '../lib/types'

/**
 * Opening the `/context` report from where Orbital shows how full the window
 * is — the Mac detail panel's context bar, the phone's session header — with
 * no `/context` typed and nothing added to the transcript (spec
 * 2026-11-19-context-report-dialog-design § Opening it from the context
 * read-out).
 *
 * A session Orbital runs right now is asked for a fresh report on the side
 * (`GET /api/sessions/:id/context-report`). Any other — ended, asleep, held
 * by a terminal — or one whose Mac says no, or is too old to ask, opens the
 * last `/context` answer in its loaded transcript instead.
 */

/** Where the report would come from: taken now, the transcript's last `/context`, or nowhere. */
export type ReportSource = 'live' | 'transcript' | null

/** What `takeReport` opened: a report taken now, the transcript's last one, or nothing. */
export type TakeOutcome = 'live' | 'transcript' | 'none'

/**
 * Whether the device a session runs on serves the on-demand route. Always
 * yes on the Mac, whose own server or a forwarding member answers (an older
 * member answers with an error, and the transcript opens instead); the phone
 * sets it to `MAC_FEATURES.contextReportOnDemand` (`mobile/boot.ts`), since
 * an older Mac would leave the ask to time out.
 */
let servesOnDemand: (sessionId: string) => boolean = () => true

export function configureTakeReport(opts: { servesOnDemand: (sessionId: string) => boolean }): void {
  servesOnDemand = opts.servesOnDemand
}

/** A session Orbital holds a live query for, as the client can tell: its own, not ended and not asleep. */
export function isLiveOrbitalSession(session: Pick<ApiSession, 'source' | 'status'> | undefined): boolean {
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
  session: Pick<ApiSession, 'source' | 'status'> | undefined,
  messages: readonly ChatMessage[] | undefined,
  serves: boolean,
): ReportSource {
  if (serves && isLiveOrbitalSession(session)) return 'live'
  return latestContextAnswer(messages) ? 'transcript' : null
}

/** Where `sessionId`'s report would come from, read from the stores now. */
export function reportSourceOf(sessionId: string): ReportSource {
  const { sessions, transcripts } = useOrbital.getState()
  return reportSourceFor(sessions[sessionId], transcripts[sessionId], servesOnDemand(sessionId))
}

/**
 * The same, as a hook: whether the read-out offers the report at all (null
 * hides the affordance) and whether it would be taken now. The phone's Mac
 * version is read when the stores change, not on its own.
 */
export function useReportSource(sessionId: string): ReportSource {
  return useOrbital((s) => reportSourceFor(s.sessions[sessionId], s.transcripts[sessionId], servesOnDemand(sessionId)))
}

/** Whether a report is being taken for `sessionId`: the read-out's loading state. */
export function useTakingReport(sessionId: string): boolean {
  return useContextReport((s) => s.taking === sessionId)
}

let ticket = 0

/**
 * Opens `sessionId`'s report, as `ReportSource` says: taken now from its live
 * query, else the last `/context` in its loaded transcript. While one is
 * being taken, `taking` names the session. A later `takeReport` supersedes an
 * earlier one still out, and an answer that comes once the session is no
 * longer on screen here opens nothing — it was asked for over this session,
 * not over whatever the user turned to since. Never touches the transcript.
 */
export async function takeReport(sessionId: string): Promise<TakeOutcome> {
  const fromTranscript = (): TakeOutcome => {
    const message = latestContextAnswer(useOrbital.getState().transcripts[sessionId])
    const open = message ? openingOf(sessionId, message) : null
    if (!open) return 'none'
    useContextReport.getState().showReport(open)
    return 'transcript'
  }

  if (reportSourceOf(sessionId) !== 'live') return fromTranscript()

  const mine = ++ticket
  useContextReport.setState({ taking: sessionId })
  let answer: Awaited<ReturnType<typeof api.contextReport>> | null
  try {
    answer = await api.contextReport(sessionId)
  } catch {
    // An older member Mac without the route, the network, the tunnel: the transcript's report will do.
    answer = null
  }
  if (mine !== ticket) return 'none'
  useContextReport.setState({ taking: null })
  if (useContextReport.getState().onScreen !== sessionId) return 'none'
  if (answer && 'report' in answer) {
    useContextReport.getState().showReport({
      sessionId,
      key: `taken:${answer.takenAt}`,
      report: answer.report,
      takenAt: answer.takenAt,
      text: null,
    })
    return 'live'
  }
  return fromTranscript()
}
