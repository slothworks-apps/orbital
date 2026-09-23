import type { ReactNode } from 'react'
import type { ApiSession, FileSummary, Walkthrough, WalkthroughStep } from '../lib/types'
import { blindAlleySteps, callsOf, fileCounts, intentFor, midTurn, pathOf, plural, stepLabel, stillOpen, trailingGap } from './derive'
import { GapLine } from './GapLine'
import { BlinkDot, JumpLink, WalkButton } from './parts'
import { mapHref } from './route'

interface CloseScreenProps {
  id: string
  session: ApiSession
  walkthrough: Walkthrough
  onJump(stepId: string): void
  /** The page bar, which this screen places (canvas `Feature - Page headers` 25d). */
  bar: ReactNode
}

/**
 * Screen three (canvas 21e): every file touched and how it ended, the
 * abandoned work in one place, and what is still open — three columns.
 */
export function CloseScreen({ id, session, walkthrough, onJump, bar }: CloseScreenProps) {
  const steps = walkthrough.steps
  const blind = blindAlleySteps(walkthrough)
  const open = stillOpen(walkthrough)
  const after = trailingGap(walkthrough)
  const busy = midTurn(session)
  const stepById = new Map(steps.map((s) => [s.id, s]))
  const fileByPath = new Map(walkthrough.files.map((f) => [f.path, f]))
  const jumpTo = (stepId: string) => (stepById.has(stepId) ? () => onJump(stepId) : undefined)
  const ordinal = (stepId: string) => stepById.get(stepId)?.ordinal ?? '?'

  // Abandoned work grouped by the intent the narration put it under; without
  // a narration every blind alley stands alone.
  const abandoned = new Map<string, { title: string | null; summary: string; steps: WalkthroughStep[] }>()
  for (const step of blind) {
    const intent = intentFor(walkthrough, step.id)
    const key = intent ? `intent:${walkthrough.narration?.intents.indexOf(intent)}` : `step:${step.id}`
    const group = abandoned.get(key) ?? { title: intent?.title || null, summary: intent?.summary ?? '', steps: [] }
    group.steps.push(step)
    abandoned.set(key, group)
  }

  const fileNote = (file: FileSummary): string | null => {
    if (file.notApplied) return 'not applied'
    if (file.fate === 'reverted') {
      const revert = steps.flatMap((s) => s.fate.filter((f) => f.kind === 'reverted' && f.path === file.path)).at(-1)
      const by = revert ? stepById.get(revert.byStep)?.ordinal : undefined
      return by === undefined ? 'restored' : `restored in ${by}`
    }
    if (file.created) return `created in ${ordinal(file.steps[0])}`
    const counts = fileCounts(walkthrough, file.path)
    return counts ? `+${counts.added} −${counts.removed}` : null
  }

  return (
    <div className="flex min-h-screen flex-col">
      {bar}

      <main className="flex flex-1 flex-col gap-[30px] px-24 pt-11">
        <h1 className="text-[32px] font-bold tracking-[-.02em] text-text-bright">
          {plural(steps.length, 'step', 'steps')}, {plural(walkthrough.files.length, 'file', 'files')},{' '}
          {plural(blind.length, 'blind alley', 'blind alleys')}
        </h1>

        <div className="grid grid-cols-[1.25fr_1fr_1fr] items-start gap-7">
          <Column title="FILES · STEPS THAT TOUCHED THEM" empty={walkthrough.files.length === 0 ? 'no files touched' : null}>
            {walkthrough.files.map((file) => {
              const reverted = file.fate === 'reverted'
              const note = fileNote(file)
              return (
                <div
                  key={file.path}
                  className={[
                    'flex items-center gap-2 rounded-[7px] border border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.45)] px-2.5 py-2 font-mono text-[11.5px]',
                    reverted ? 'text-[rgba(160,190,225,.5)]' : 'text-text-bright',
                  ].join(' ')}
                >
                  <span className="shrink-0 text-text-muted">{reverted ? '↶' : '⚙'}</span>
                  <span className="min-w-0 flex-1 truncate">{file.path}</span>
                  {note && <span className="shrink-0 text-[10px] text-[rgba(160,190,225,.55)]">{note}</span>}
                  <span className="flex shrink-0 gap-1">
                    {file.steps.map((stepId) => (
                      <button
                        key={stepId}
                        type="button"
                        disabled={!stepById.has(stepId)}
                        onClick={() => onJump(stepId)}
                        className="inline-flex h-5 min-w-5 items-center justify-center rounded-[4px] border border-[rgba(150,205,255,.2)] px-[5px] text-[10px] text-text-soft"
                      >
                        {ordinal(stepId)}
                      </button>
                    ))}
                  </span>
                </div>
              )
            })}
          </Column>

          <Column title="ABANDONED · ↶" empty={abandoned.size === 0 ? 'nothing abandoned' : null}>
            {[...abandoned.entries()].map(([key, group]) => {
              const first = group.steps[0]
              const last = group.steps[group.steps.length - 1]
              const revert = group.steps.flatMap((s) => s.fate).find((f) => f.kind === 'reverted')
              const paths = [...new Set(group.steps.flatMap(callsOf).map(pathOf).filter((p): p is string => !!p))]
              return (
                <div key={key} className="flex flex-col gap-2 rounded-[9px] border border-[rgba(150,205,255,.12)] bg-[rgba(4,8,16,.4)] px-3.5 py-3">
                  <span className="text-[13.5px] font-semibold text-text-bright">{group.title || stepLabel(walkthrough, first)}</span>
                  <span className="font-mono text-[10.5px] text-text-muted">
                    {first === last ? (
                      <>
                        step <JumpLink onJump={jumpTo(first.id)}>{first.ordinal}</JumpLink>
                      </>
                    ) : (
                      <>
                        steps <JumpLink onJump={jumpTo(first.id)}>{first.ordinal}</JumpLink>–
                        <JumpLink onJump={jumpTo(last.id)}>{last.ordinal}</JumpLink>
                      </>
                    )}
                    {revert && (
                      <>
                        {' · backed out in '}
                        <JumpLink onJump={jumpTo(revert.byStep)}>{ordinal(revert.byStep)}</JumpLink>
                      </>
                    )}
                  </span>
                  {group.summary && <p className="text-[12.5px] leading-[1.55] text-[rgba(200,214,235,.8)]">{group.summary}</p>}
                  {paths.map((path) => {
                    const file = fileByPath.get(path)
                    const note = file ? fileNote(file) : null
                    return (
                      <span key={path} className="flex gap-1.5 font-mono text-[11px] text-text-muted">
                        <span className="min-w-0 truncate">↶ {path}</span>
                        {note && <span className="shrink-0 text-[rgba(160,190,225,.45)]">{note}</span>}
                      </span>
                    )
                  })}
                </div>
              )
            })}
          </Column>

          <Column title="STILL OPEN" empty={open.length === 0 && !busy && !after ? 'nothing open' : null}>
            {open.map(({ step, call }) => (
              <div key={call.call.id} className="flex flex-col gap-1.5 rounded-[9px] border border-dashed border-[rgba(150,205,255,.3)] bg-[rgba(4,8,16,.4)] px-3.5 py-3">
                <span className="flex items-center gap-2 font-mono text-[11.5px] text-text-muted">
                  <span className="min-w-0 truncate">
                    ⚙ {call.call.toolName}: <span className="text-text-bright">{pathOf(call)}</span>
                  </span>
                  <span className="flex-1" />
                  <span className="shrink-0 text-[9.5px] tracking-[.12em] text-text-bright">NOT APPLIED</span>
                </span>
                {call.result?.text && (
                  <span className="whitespace-pre-wrap font-mono text-[10.5px] text-text-bright">
                    <span className="text-text-muted">error · </span>
                    {call.result.text}
                  </span>
                )}
                <span className="text-[12.5px] text-[rgba(200,214,235,.8)]">
                  Go to step <JumpLink onJump={jumpTo(step.id)}>{step.ordinal}</JumpLink>.
                </span>
              </div>
            ))}
            {busy && (
              <div className="flex flex-col gap-1.5 rounded-[9px] border border-[rgba(150,205,255,.12)] bg-[rgba(4,8,16,.4)] px-3.5 py-3">
                <span className="flex items-center gap-2 font-mono text-[11.5px] text-text-bright">
                  <BlinkDot bright />
                  {session.status === 'working' ? 'the session is still working' : 'the session is waiting on a decision'}
                </span>
                <p className="text-[12.5px] text-[rgba(200,214,235,.8)]">
                  Steps may still be added after {steps.length}; the cover&apos;s counts and this page update when it settles. Asking is
                  paused until then.
                </p>
              </div>
            )}
            {after && <GapLine gap={after} label="AFTER THE LAST STEP" />}
          </Column>
        </div>

        {/* 21e's "← Back to the map" is gone: the bar's esc does it (canvas
            `Feature - Page headers` 25d). */}
        <footer className="mt-auto flex items-center gap-3.5 border-t border-[rgba(150,205,255,.08)] pt-[18px] pb-7">
          <WalkButton tone="quiet" size="md" href={mapHref(id)}>
            Open the transcript
          </WalkButton>
          <span className="flex-1" />
          <span className="font-mono text-[10.5px] text-[rgba(160,190,225,.5)]">esc · back to the map</span>
        </footer>
      </main>
    </div>
  )
}

function Column({ title, empty, children }: { title: string; empty: string | null; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2.5">
      <span className="border-b border-[rgba(150,205,255,.1)] pb-2 font-mono text-[10px] tracking-[.18em] text-[rgba(160,190,225,.6)]">{title}</span>
      {empty && <span className="font-mono text-[11px] text-text-muted">{empty}</span>}
      {children}
    </section>
  )
}
