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
        <h1 className="fs-32 font-bold tracking-[-.02em] text-ink-100">
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
                    'flex items-center gap-2 rounded-[7px] border border-line/10 bg-space/45 px-2.5 py-2 font-mono fs-11.5',
                    reverted ? 'text-ink-900/50' : 'text-ink-100',
                  ].join(' ')}
                >
                  <span className="shrink-0 text-ink-900/70">{reverted ? '↶' : '⚙'}</span>
                  <span className="min-w-0 flex-1 truncate">{file.path}</span>
                  {note && <span className="shrink-0 fs-10 text-ink-900/55">{note}</span>}
                  <span className="flex shrink-0 gap-1">
                    {file.steps.map((stepId) => (
                      <button
                        key={stepId}
                        type="button"
                        disabled={!stepById.has(stepId)}
                        onClick={() => onJump(stepId)}
                        className="inline-flex h-fit min-h-5 min-w-5 items-center justify-center rounded-[4px] border border-line/20 px-[5px] fs-10 text-ink-300"
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
                <div key={key} className="flex flex-col gap-2 rounded-[9px] border border-line/12 bg-space/40 px-3.5 py-3">
                  <span className="fs-13.5 font-semibold text-ink-100">{group.title || stepLabel(walkthrough, first)}</span>
                  <span className="font-mono fs-10.5 text-ink-900/70">
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
                  {group.summary && <p className="fs-12.5 leading-[1.55] text-ink-600/80">{group.summary}</p>}
                  {paths.map((path) => {
                    const file = fileByPath.get(path)
                    const note = file ? fileNote(file) : null
                    return (
                      <span key={path} className="flex gap-1.5 font-mono fs-11 text-ink-900/70">
                        <span className="min-w-0 truncate">↶ {path}</span>
                        {note && <span className="shrink-0 text-ink-900/60">{note}</span>}
                      </span>
                    )
                  })}
                </div>
              )
            })}
          </Column>

          <Column title="STILL OPEN" empty={open.length === 0 && !busy && !after ? 'nothing open' : null}>
            {open.map(({ step, call }) => (
              <div key={call.call.id} className="flex flex-col gap-1.5 rounded-[9px] border border-dashed border-line/30 bg-space/40 px-3.5 py-3">
                <span className="flex items-center gap-2 font-mono fs-11.5 text-ink-900/70">
                  <span className="min-w-0 truncate">
                    ⚙ {call.call.toolName}: <span className="text-ink-100">{pathOf(call)}</span>
                  </span>
                  <span className="flex-1" />
                  <span className="shrink-0 fs-9.5 tracking-[.12em] text-ink-100">NOT APPLIED</span>
                </span>
                {call.result?.text && (
                  <span className="whitespace-pre-wrap font-mono fs-10.5 text-ink-100">
                    <span className="text-ink-900/70">error · </span>
                    {call.result.text}
                  </span>
                )}
                <span className="fs-12.5 text-ink-600/80">
                  Go to step <JumpLink onJump={jumpTo(step.id)}>{step.ordinal}</JumpLink>.
                </span>
              </div>
            ))}
            {busy && (
              <div className="flex flex-col gap-1.5 rounded-[9px] border border-line/12 bg-space/40 px-3.5 py-3">
                <span className="flex items-center gap-2 font-mono fs-11.5 text-ink-100">
                  <BlinkDot bright />
                  {session.status === 'working' ? 'the session is still working' : 'the session is waiting on a decision'}
                </span>
                <p className="fs-12.5 text-ink-600/80">
                  Steps may still be added after {steps.length}; the cover&apos;s counts and this page update when it settles.
                </p>
              </div>
            )}
            {after && <GapLine gap={after} label="AFTER THE LAST STEP" />}
          </Column>
        </div>

        {/* 21e's "← Back to the map" is gone: the bar's esc does it (canvas
            `Feature - Page headers` 25d). */}
        <footer className="mt-auto flex items-center gap-3.5 border-t border-line/8 pt-[18px] pb-7">
          <WalkButton tone="quiet" size="md" href={mapHref(id)}>
            Open the transcript
          </WalkButton>
          <span className="flex-1" />
          <span className="font-mono fs-10.5 text-ink-900/50">esc · back to the map</span>
        </footer>
      </main>
    </div>
  )
}

function Column({ title, empty, children }: { title: string; empty: string | null; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2.5">
      <span className="border-b border-line/10 pb-2 font-mono fs-10 tracking-[.18em] text-ink-900/60">{title}</span>
      {empty && <span className="font-mono fs-11 text-ink-900/70">{empty}</span>}
      {children}
    </section>
  )
}
