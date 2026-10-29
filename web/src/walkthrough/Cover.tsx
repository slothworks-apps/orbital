import { useState, type ReactNode } from 'react'
import { api, ApiError } from '../lib/api'
import { reportError } from '../lib/errors'
import type { ApiSession, NarrationFailure, Walkthrough } from '../lib/types'
import { blindAlleySteps, plural, sessionSpan } from './derive'
import { WalkButton } from './parts'

interface CoverProps {
  id: string
  session: ApiSession
  walkthrough: Walkthrough
  onStart(): void
  onRefetch(): void
  /** The page bar, which this screen places (canvas `Feature - Page headers` 25d). */
  bar: ReactNode
}

/** Screen one (canvas 21a): what the session did, in four numbers, and the way in. */
export function Cover({ id, session, walkthrough, onStart, onRefetch, bar }: CoverProps) {
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
      {bar}

      <main className="mx-auto flex w-full max-w-[720px] flex-1 flex-col justify-center gap-9 py-12">
        <div className="flex flex-col gap-3">
          <span className="font-mono fs-10 tracking-[.2em] text-ink-900/60">
            WALKTHROUGH{span && ` · ${span}`}
          </span>
          <h1 className="fs-44 font-bold leading-[1.1] tracking-[-.02em] text-ink-100">{session.title}</h1>
          <span className="font-mono fs-12 text-ink-900/70">
            {session.cwd}
            {branch && (
              <>
                <span className="text-line/30"> · </span>
                {branch}
              </>
            )}
          </span>
        </div>

        {/* canvas 21a: the four counts share one hairline grid. */}
        <div className="grid grid-cols-4 gap-px overflow-hidden rounded-[12px] border border-line/10 bg-line/10">
          {counts.map(([label, value]) => (
            <div key={label} role="group" aria-label={label} className="flex flex-col gap-1.5 bg-space-deep/80 px-[22px] py-5">
              <span className="font-mono fs-34 leading-none tabular-nums text-ink-100">
                {value}
                {label === 'blind alleys' && <span className="fs-18 text-ink-900/60"> ↶</span>}
              </span>
              <span className="font-mono fs-10 uppercase tracking-[.16em] text-ink-900/60">{label}</span>
            </div>
          ))}
        </div>

        {empty ? (
          <p className="font-mono fs-12 text-ink-900/70">no file changes in this session</p>
        ) : (
          <>
            <NarrationBlock id={id} walkthrough={walkthrough} onRefetch={onRefetch} />
            <div className="flex items-center gap-4">
              <WalkButton tone="accent" size="lg" onClick={onStart}>
                Start →
              </WalkButton>
              <span className="font-mono fs-10.5 tracking-[.06em] text-ink-900/50">
                ⏎ start · → / ← step · esc back to the map
              </span>
            </div>
          </>
        )}
      </main>
    </div>
  )
}

/** The failure line's words, one per reason (spec 2026-09-30-narrate-out-of-band-design § Failure). */
const FAILURE: Record<NarrationFailure, string> = {
  refused: 'the model refused to narrate this record · another model can be picked in Settings',
  unparsable: 'the narration came back in a shape Orbital could not read',
  error: 'the narration failed',
}

/**
 * The narration's states (canvas 21a NARR): not asked, answered, answered but
 * steps have been added since, failed — and asked but not landed yet, while
 * the previous narration (if any) still groups the rail. The button starts a
 * query outside the session, so nothing about the session — working, ended,
 * live in a terminal — holds it back.
 */
function NarrationBlock({ id, walkthrough, onRefetch }: Pick<CoverProps, 'id' | 'walkthrough' | 'onRefetch'>) {
  const [sending, setSending] = useState(false)
  const narration = walkthrough.narration
  const stale = narration?.staleSteps ?? 0
  const failed = walkthrough.narrationFailed && !walkthrough.narrationPending

  let heading: string
  let sub: string
  let action: string
  if (walkthrough.narrationPending) {
    heading = 'Narrating…'
    sub = 'read from the session\'s record, outside the session'
    action = narration ? 'Narrate again' : 'Narrate'
  } else if (failed) {
    heading = 'Narrate this walkthrough'
    sub = 'read from the session\'s record, outside the session · counts against your subscription'
    action = 'Try again'
  } else if (!narration) {
    heading = 'Narrate this walkthrough'
    sub = 'intent titles for groups of steps, read from the session\'s record · counts against your subscription'
    action = 'Narrate'
  } else if (stale > 0) {
    heading = `Narrated · ${plural(narration.intents.length, 'intent', 'intents')}`
    sub = `${plural(stale, 'step', 'steps')} since the narration ${stale === 1 ? 'is' : 'are'} shown in the agent's own words · re-narrating reads the record again`
    action = 'Narrate again'
  } else {
    heading = `Narrated · ${plural(narration.intents.length, 'intent', 'intents')}`
    sub = 'the rail groups steps under intent titles'
    action = 'Narrate again'
  }

  const narrate = () => {
    setSending(true)
    api.narrateWalkthrough(id).then(
      () => {
        setSending(false)
        onRefetch()
      },
      (err: unknown) => {
        setSending(false)
        // Another window started one a moment ago: show that one.
        if (err instanceof ApiError && err.status === 409) onRefetch()
        else reportError(err, 'Could not start the narration')
      },
    )
  }

  return (
    <section
      className={[
        'flex flex-col rounded-[12px] border bg-[linear-gradient(180deg,color-mix(in_oklab,_var(--color-panel-solid)_72%,_transparent),color-mix(in_oklab,_var(--color-space-deep)_78%,_transparent))]',
        failed ? 'border-line/30' : 'border-line/16',
      ].join(' ')}
    >
      <div className="flex items-center gap-4 px-5 py-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-center gap-2.5 fs-14 font-semibold text-ink-100">
            {heading}
            {!walkthrough.narrationPending && !failed && stale > 0 && (
              <span className="rounded-[4px] border border-dashed border-line/30 px-[7px] py-0.5 font-mono fs-9.5 font-normal tracking-[.12em] text-ink-500/80">
                {plural(stale, 'STEP', 'STEPS')} SINCE
              </span>
            )}
          </span>
          <span className="font-mono fs-10.5 leading-[1.5] text-ink-900/60">{sub}</span>
        </div>
        <WalkButton tone="lit" size="sm" disabled={sending || walkthrough.narrationPending} onClick={narrate}>
          {action}
        </WalkButton>
      </div>
      {failed && (
        <div className="flex items-center gap-2 border-t border-dashed border-line/16 px-5 py-[9px] font-mono fs-10.5 text-ink-100">
          <span className="text-ink-900/70">notice ·</span>
          <span>{FAILURE[walkthrough.narrationFailure ?? 'error']}</span>
          <span className="flex-1" />
          <span className="text-ink-900/70">the steps below are intact, in the agent&apos;s own words</span>
        </div>
      )}
    </section>
  )
}
