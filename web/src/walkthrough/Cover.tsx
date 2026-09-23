import { useState } from 'react'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import type { ApiSession, Walkthrough } from '../lib/types'
import { blindAlleySteps, midTurn, plural, refusalOf, sessionSpan } from './derive'
import { WalkButton } from './parts'
import { TopBar } from './TopBar'

interface CoverProps {
  id: string
  session: ApiSession
  walkthrough: Walkthrough
  onStart(): void
  onRefetch(): void
}

/** Screen one (canvas 21a): what the session did, in four numbers, and the way in. */
export function Cover({ id, session, walkthrough, onStart, onRefetch }: CoverProps) {
  const empty = walkthrough.steps.length === 0
  const span = sessionSpan(session.firstAt, session.lastAt)
  const branch = session.git?.ref
  const counts: Array<[label: string, value: number]> = [
    ['steps', walkthrough.steps.length],
    ['files touched', walkthrough.files.length],
    ['blind alleys', blindAlleySteps(walkthrough).length],
    ['subagents that wrote', walkthrough.steps.filter((s) => s.subagent).length],
  ]

  return (
    <div className="flex min-h-screen flex-col">
      <TopBar id={id} session={session} />

      <main className="mx-auto flex w-full max-w-[720px] flex-1 flex-col justify-center gap-9 py-12">
        <div className="flex flex-col gap-3">
          <span className="font-mono text-[10px] tracking-[.2em] text-[rgba(160,190,225,.6)]">
            WALKTHROUGH{span && ` · ${span}`}
          </span>
          <h1 className="text-[44px] font-bold leading-[1.1] tracking-[-.02em] text-text-bright">{session.title}</h1>
          <span className="font-mono text-[12px] text-text-muted">
            {session.cwd}
            {branch && (
              <>
                <span className="text-[rgba(150,205,255,.3)]"> · </span>
                {branch}
              </>
            )}
          </span>
        </div>

        {/* canvas 21a: the four counts share one hairline grid. */}
        <div className="grid grid-cols-4 gap-px overflow-hidden rounded-[12px] border border-[rgba(150,205,255,.1)] bg-[rgba(150,205,255,.1)]">
          {counts.map(([label, value]) => (
            <div key={label} role="group" aria-label={label} className="flex flex-col gap-1.5 bg-[rgba(8,12,22,.8)] px-[22px] py-5">
              <span className="font-mono text-[34px] leading-none tabular-nums text-text-bright">
                {value}
                {label === 'blind alleys' && <span className="text-[18px] text-[rgba(160,190,225,.6)]"> ↶</span>}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[.16em] text-[rgba(160,190,225,.6)]">{label}</span>
            </div>
          ))}
        </div>

        {empty ? (
          <p className="font-mono text-[12px] text-text-muted">no file changes in this session</p>
        ) : (
          <>
            <NarrationBlock id={id} session={session} walkthrough={walkthrough} onRefetch={onRefetch} />
            <div className="flex items-center gap-4">
              <WalkButton tone="accent" size="lg" onClick={onStart}>
                Start →
              </WalkButton>
              <span className="font-mono text-[10.5px] tracking-[.06em] text-[rgba(160,190,225,.5)]">
                ⏎ start · → / ← step · esc back to the map
              </span>
            </div>
          </>
        )}
      </main>
    </div>
  )
}

const BUSY = 'the session is working — narrating waits until it settles'
const PARKED = 'the session is waiting on a decision — narrating waits until it settles'
const NOT_OURS = 'this session is not Orbital\'s to continue'

/**
 * The narration's states (canvas 21a NARR): not asked, answered, answered but
 * steps have been added since, answered in a shape the server could not read
 * — and asked but not answered yet, while the previous narration (if any)
 * still groups the rail. The button asks the session for one turn.
 */
function NarrationBlock({ id, session, walkthrough, onRefetch }: Omit<CoverProps, 'onStart'>) {
  const [sending, setSending] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const narration = walkthrough.narration
  const stale = narration?.staleSteps ?? 0
  const busy = midTurn(session)
  const failed = walkthrough.narrationFailed && !walkthrough.narrationPending

  let heading: string
  let sub: string
  let action: string
  if (walkthrough.narrationPending) {
    heading = 'Narrating…'
    sub = 'one turn, answered by this session'
    action = narration ? 'Narrate again' : 'Narrate'
  } else if (failed) {
    heading = 'Narrate this walkthrough'
    sub = 'one turn, answered by this session · counts against your subscription'
    action = 'Try again'
  } else if (!narration) {
    heading = 'Narrate this walkthrough'
    sub = 'one turn, answered by this session · intent titles for groups of steps · counts against your subscription'
    action = 'Narrate'
  } else if (stale > 0) {
    heading = `Narrated · ${plural(narration.intents.length, 'intent', 'intents')}`
    sub = `${plural(stale, 'step', 'steps')} since the narration ${stale === 1 ? 'is' : 'are'} shown in the agent's own words · re-narrating is one more turn`
    action = 'Narrate again'
  } else {
    heading = `Narrated · ${plural(narration.intents.length, 'intent', 'intents')}`
    sub = 'one turn · the rail groups steps under intent titles'
    action = 'Narrate again'
  }

  const narrate = () => {
    setSending(true)
    setRefusal(null)
    api.narrateWalkthrough(id).then(
      () => {
        setSending(false)
        onRefetch()
      },
      (err: unknown) => {
        setSending(false)
        const why = refusalOf(err)
        if (why === 'busy') setRefusal(BUSY)
        else if (why === 'terminal_session') setRefusal(NOT_OURS)
        else reportError(err, 'Could not ask the session to narrate')
      },
    )
  }

  const reason = refusal ?? (busy ? (session.status === 'working' ? BUSY : PARKED) : null)

  return (
    <section
      className={[
        'flex flex-col rounded-[12px] border bg-[linear-gradient(180deg,rgba(14,20,34,.72),rgba(8,12,22,.78))]',
        failed ? 'border-[rgba(150,205,255,.3)]' : 'border-[rgba(150,205,255,.16)]',
      ].join(' ')}
    >
      <div className="flex items-center gap-4 px-5 py-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-center gap-2.5 text-[14px] font-semibold text-text-bright">
            {heading}
            {!walkthrough.narrationPending && !failed && stale > 0 && (
              <span className="rounded-[4px] border border-dashed border-[rgba(150,205,255,.3)] px-[7px] py-0.5 font-mono text-[9.5px] font-normal tracking-[.12em] text-[rgba(200,220,245,.8)]">
                {plural(stale, 'STEP', 'STEPS')} SINCE
              </span>
            )}
          </span>
          <span className="font-mono text-[10.5px] leading-[1.5] text-[rgba(160,190,225,.6)]">{reason ?? sub}</span>
        </div>
        <WalkButton tone="lit" size="sm" disabled={sending || busy || walkthrough.narrationPending} onClick={narrate}>
          {action}
        </WalkButton>
      </div>
      {failed && (
        <div className="flex items-center gap-2 border-t border-dashed border-[rgba(150,205,255,.16)] px-5 py-[9px] font-mono text-[10.5px] text-text-bright">
          <span className="text-text-muted">notice ·</span>
          <span>the narration did not come back as expected</span>
          <span className="flex-1" />
          <span className="text-text-muted">the steps below are intact, in the agent&apos;s own words</span>
        </div>
      )}
    </section>
  )
}
