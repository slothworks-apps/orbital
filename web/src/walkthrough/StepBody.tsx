import { useMemo, type ReactNode } from 'react'
import { api } from '../lib/api'
import { changeCounts, describeFileChange } from '../lib/fileEdit'
import { formatDuration } from '../lib/format'
import type { ApiSession, FateKind, StepCall, Walkthrough, WalkthroughStep } from '../lib/types'
import { ChangeView } from '../panels/DiffView'
import { AskField } from './AskField'
import { callCounts, callsOf, foldedLine, intentFor, pathOf } from './derive'
import { Counts, JumpLink, Words } from './parts'

interface StepBodyProps {
  id: string
  session: ApiSession
  walkthrough: Walkthrough
  step: WalkthroughStep
  onJump(stepId: string): void
  onRefetch(): void
}

const FATE_GLYPH: Record<FateKind, string> = { revised: '↷', reverted: '↶' }

/** One fate mark, drawn as the last row of the file block it concerns (canvas 21b). */
interface FateRow {
  key: string
  kind: FateKind
  verb: string
  stepId: string
  path: string
}

/**
 * One step (canvas 21b): what it was for, what it changed, what later became
 * of it, and the questions asked about it. A subagent's dispatch is one step
 * whose own steps open in place (canvas 21d).
 */
export function StepBody({ id, session, walkthrough, step, onJump, onRefetch }: StepBodyProps) {
  const total = walkthrough.steps.length
  const intent = intentFor(walkthrough, step.id)
  const title = intent?.title || step.narration || (step.subagent ? step.subagent.prompt : '')
  const eyebrowTail = step.subagent ? 'SUBAGENT' : intent?.title ? intent.title.toUpperCase() : null
  const folded = foldedLine(step.folded)
  const stepById = new Map(walkthrough.steps.map((s) => [s.id, s]))
  const jumpTo = (stepId: string) => (stepById.has(stepId) ? () => onJump(stepId) : undefined)

  // What later steps did to this one, and what this one did to earlier ones —
  // one row per step, kind and path, set inside the block for that path.
  const rows: FateRow[] = [
    ...uniqueBy(step.fate, (f) => `${f.kind}:${f.byStep}:${f.path}`).map((f) => ({
      key: `by:${f.kind}:${f.byStep}:${f.path}`,
      kind: f.kind,
      verb: f.kind === 'revised' ? 'revised in' : 'reverted in',
      stepId: f.byStep,
      path: f.path,
    })),
    ...walkthrough.steps.flatMap((other) =>
      uniqueBy(other.fate.filter((f) => f.byStep === step.id), (f) => `${f.kind}:${f.path}`).map((f) => ({
        key: `of:${f.kind}:${other.id}:${f.path}`,
        kind: f.kind,
        verb: f.kind === 'revised' ? 'revises' : 'reverts',
        stepId: other.id,
        path: f.path,
      })),
    ),
  ]
  const fateRows = (row: FateRow) => (
    <div key={row.key} className="flex items-center gap-1.5 border-t border-[rgba(150,205,255,.08)] px-2.5 py-[7px] font-mono text-[10.5px] text-[rgba(200,220,245,.8)]">
      <span className="text-text-bright">{FATE_GLYPH[row.kind]}</span>
      <span>{row.verb}</span>
      <JumpLink onJump={jumpTo(row.stepId)}>step {stepById.get(row.stepId)?.ordinal ?? '?'}</JumpLink>
    </div>
  )

  // Each row goes to the last block on its path; a row whose path no block
  // here names falls back to the last block.
  const calls = step.subagent ? [] : step.calls
  const lastOnPath = new Map<string, number>()
  calls.forEach((c, i) => {
    const p = pathOf(c)
    if (p) lastOnPath.set(p, i)
  })
  const rowsFor = (i: number) =>
    rows.filter((r) => lastOnPath.get(r.path) === i || (i === calls.length - 1 && !lastOnPath.has(r.path)))

  return (
    <article className="flex flex-1 flex-col gap-5">
      <header className="flex flex-col gap-2.5">
        <span className="font-mono text-[10px] tracking-[.18em] text-[rgba(160,190,225,.6)]">
          STEP {step.ordinal} OF {total}
          {eyebrowTail && ` · ${eyebrowTail}`}
        </span>
        <h2 className="text-[26px] font-bold leading-[1.2] tracking-[-.015em] text-text-bright">{title}</h2>
        {intent?.summary && <p className="text-[13.5px] leading-[1.6] text-[rgba(200,214,235,.9)]">{intent.summary}</p>}
        {intent?.title && step.narration && <Words>{step.narration}</Words>}
      </header>

      {folded && (
        <div className="flex items-center gap-2 rounded-[7px] border border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.45)] px-2.5 py-[7px] font-mono text-[11.5px] text-[rgba(200,220,245,.8)]">
          <span className="text-[9px] text-text-muted">▸</span>
          <span className="text-text-muted">⚙</span>
          <span className="text-text-bright">{folded}</span>
          <span className="text-[rgba(150,205,255,.28)]">·</span>
          <span className="text-text-muted">inside this step</span>
          <span className="flex-1" />
          {step.durationMs !== null && <span className="text-[rgba(160,190,225,.5)]">{formatDuration(step.durationMs)}</span>}
        </div>
      )}

      {step.subagent ? (
        <section className="flex flex-col gap-3">
          <span className="font-mono text-[10px] tracking-[.18em] text-[rgba(160,190,225,.6)]">SUBAGENT · {step.subagent.name}</span>
          {step.subagent.prompt && <Words small>{step.subagent.prompt}</Words>}
          {step.subagent.steps.map((sub, i) => (
            <SubStep key={sub.id} id={id} session={session} parent={step.ordinal} index={i + 1} sub={sub} />
          ))}
          {rows.length > 0 && (
            <div className="rounded-[7px] border border-[rgba(150,205,255,.18)] bg-[rgba(4,8,16,.55)] [&>*:first-child]:border-t-0">
              {rows.map(fateRows)}
            </div>
          )}
        </section>
      ) : (
        calls.map((c, i) => (
          <FileBlock key={c.call.id} id={id} session={session} call={c}>
            {rowsFor(i).map(fateRows)}
          </FileBlock>
        ))
      )}

      {/* canvas 21b: the ask well sits at the foot of the flow, the exchanges under it. */}
      <section className="mt-auto flex flex-col gap-2 pt-2">
        <AskField key={step.id} id={id} step={step} session={session} onSent={onRefetch} />
        <div className="flex flex-col gap-1.5 px-1 pb-[18px]">
          {step.questions.map((q) => (
            <div key={q.messageId} className="flex flex-col gap-1.5">
              <p className="max-w-[80%] self-end rounded-[12px_12px_4px_12px] border border-[oklch(80%_.13_210/.3)] bg-[oklch(80%_.13_210/.12)] px-3 py-2 text-[12.5px] leading-[1.5] text-text-bright">
                {q.question}
              </p>
              <span className="self-end rounded-[7px] border border-[rgba(150,205,255,.14)] px-[9px] py-1 font-mono text-[10.5px] text-[rgba(200,220,245,.8)]">
                ▸ walkthrough · ask<span className="text-[rgba(160,190,225,.5)]"> · step {step.ordinal}</span>
              </span>
              {q.answer === null ? (
                <p className="font-mono text-[11px] text-text-muted">waiting for the answer…</p>
              ) : (
                <p className="max-w-[92%] self-start whitespace-pre-wrap text-[12.5px] leading-[1.55] text-[rgba(232,238,248,.92)]">{q.answer}</p>
              )}
            </div>
          ))}
        </div>
      </section>
    </article>
  )
}

/**
 * One of a subagent's own steps (canvas 21d): a row that says which step of
 * the agent it is and what it changed, opening in place to the changes and
 * the agent's words.
 */
function SubStep({ id, session, parent, index, sub }: { id: string; session: ApiSession; parent: number; index: number; sub: WalkthroughStep }) {
  const calls = callsOf(sub)
  const paths = [...new Set(calls.map(pathOf).filter((p): p is string => !!p))]
  const title = sub.narration.split('\n')[0]?.trim() || paths.join(', ')
  return (
    <details className="group rounded-[7px] border border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.45)] open:border-[rgba(150,205,255,.18)] open:bg-[rgba(150,205,255,.05)]">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 font-mono text-[11.5px] text-[rgba(200,220,245,.8)] [&::-webkit-details-marker]:hidden">
        <span className="text-[9px] text-text-muted">
          <span className="group-open:hidden">▸</span>
          <span className="hidden group-open:inline">▾</span>
        </span>
        <span className="text-text-muted">
          {parent}.{index}
        </span>
        <span className="min-w-0 truncate font-sans text-[12.5px] text-text-bright">{title}</span>
        {paths.length > 0 && title !== paths.join(', ') && (
          <>
            <span className="text-[rgba(150,205,255,.28)]">·</span>
            <span className="min-w-0 truncate">{paths.join(', ')}</span>
          </>
        )}
        <span className="flex-1" />
        <Counts counts={callCounts(calls)} />
        <span className="text-[rgba(160,190,225,.5)]">
          <span className="group-open:hidden">expand</span>
          <span className="hidden group-open:inline">collapse</span>
        </span>
      </summary>
      {calls.map((c) => (
        <FileBlock key={c.call.id} id={id} session={session} call={c} inset />
      ))}
      {sub.narration && (
        <div className="border-t border-[rgba(150,205,255,.08)] px-2.5 py-2">
          <Words small>{sub.narration}</Words>
        </div>
      )}
    </details>
  )
}

/**
 * One writing call (canvas 21b): its header, the change as the transcript's
 * own diff view draws it, and — as its last rows — what later steps did to
 * it. A call that failed is framed dashed, says it did not apply and why; the
 * proposed change still shows, dimmed, since it is what the agent meant.
 * `inset` is the same block inside a sub-step's row (canvas 21d), which
 * already draws the frame.
 */
function FileBlock({ id, session, call, inset = false, children }: { id: string; session: ApiSession; call: StepCall; inset?: boolean; children?: ReactNode }) {
  const failed = call.result?.isError === true
  const change = useMemo(
    () => describeFileChange(call.call.toolName, call.call.toolInput, call.result?.text, failed),
    [call.call.toolName, call.call.toolInput, call.result?.text, failed],
  )
  const counts = change ? changeCounts(change) : null
  const path = pathOf(call)
  const created = change?.kind === 'write' && change.outcome === 'created'

  return (
    <div
      className={
        inset
          ? 'flex flex-col'
          : [
              'flex flex-col overflow-hidden rounded-[7px] border bg-[rgba(4,8,16,.55)]',
              failed ? 'border-dashed border-[rgba(150,205,255,.18)]' : 'border-[rgba(150,205,255,.18)]',
            ].join(' ')
      }
    >
      <div
        className={[
          'flex items-center gap-2 px-2.5 py-[7px] font-mono text-[11.5px] text-[rgba(200,220,245,.8)]',
          inset ? 'border-t border-[rgba(150,205,255,.08)]' : '',
        ].join(' ')}
      >
        {!inset && <span className="text-[9px] text-text-muted">▾</span>}
        <span className="text-text-muted">⚙</span>
        <span className="min-w-0 truncate">
          {call.call.toolName}: <span className="text-text-bright">{path}</span>
        </span>
        {created && <Tag>NEW</Tag>}
        {failed && <Tag dashed>NOT APPLIED</Tag>}
        <span className="flex-1" />
        <Counts counts={counts} />
        {session.ide && path && (
          <button
            type="button"
            // Silence is the contract for everything IDE (adr
            // `orbital-speaks-to-the-ide-itself`): a failure means the editor
            // went away, which is not news.
            onClick={() => void api.ideOpenFile(id, path, null).catch(() => false)}
            className="shrink-0 border-b border-dashed border-[rgba(150,205,255,.25)] text-[10px] text-[rgba(160,190,225,.55)]"
          >
            open in {session.ide.ideName} ↗
          </button>
        )}
      </div>
      {failed && call.result?.text && (
        <div className="border-t border-dashed border-[rgba(150,205,255,.16)] px-2.5 py-1.5 font-mono text-[10.5px] whitespace-pre-wrap text-text-bright">
          <span className="text-text-muted">error · </span>
          {call.result.text}
        </div>
      )}
      <div className={['border-t border-[rgba(150,205,255,.08)] bg-[rgba(10,15,26,.9)] py-1', failed ? 'opacity-72' : ''].join(' ')}>
        {change ? (
          <ChangeView change={change} isError={failed} />
        ) : (
          <pre className="overflow-x-auto whitespace-pre-wrap px-2.5 font-mono text-[10.5px] text-text-muted">
            {JSON.stringify(call.call.toolInput, null, 2)}
          </pre>
        )}
      </div>
      {children}
    </div>
  )
}

function Tag({ dashed = false, children }: { dashed?: boolean; children: string }) {
  return (
    <span
      className={[
        'shrink-0 rounded-[4px] border border-[rgba(150,205,255,.3)] px-1.5 py-px text-[9.5px] tracking-[.12em] text-[rgba(200,220,245,.75)]',
        dashed ? 'border-dashed' : '',
      ].join(' ')}
    >
      {children}
    </span>
  )
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const k = key(item)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
