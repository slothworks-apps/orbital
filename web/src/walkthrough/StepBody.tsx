import { useMemo, type ReactNode } from 'react'
import { api } from '../lib/api'
import { changeCounts, describeFileChange } from '../lib/fileEdit'
import { formatDuration } from '../lib/format'
import { ideHere } from '../lib/devices'
import type { ApiSession, FateKind, StepCall, Walkthrough, WalkthroughStep } from '../lib/types'
import { ChangeView } from '../panels/DiffView'
import { callCounts, callsOf, foldedLine, intentFor, pathOf } from './derive'
import { Counts, JumpLink, Words } from './parts'

interface StepBodyProps {
  id: string
  session: ApiSession
  walkthrough: Walkthrough
  step: WalkthroughStep
  onJump(stepId: string): void
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
 * One step (canvas 21b): what it was for, what it changed, and what later
 * became of it. A subagent's dispatch is one step
 * whose own steps open in place (canvas 21d).
 */
export function StepBody({ id, session, walkthrough, step, onJump }: StepBodyProps) {
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
    <div key={row.key} className="flex items-center gap-1.5 border-t border-line/8 px-2.5 py-[7px] font-mono fs-10.5 text-ink-500/80">
      <span className="text-ink-100">{FATE_GLYPH[row.kind]}</span>
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
        <span className="font-mono fs-10 tracking-[.18em] text-ink-900/60">
          STEP {step.ordinal} OF {total}
          {eyebrowTail && ` · ${eyebrowTail}`}
        </span>
        <h2 className="fs-26 font-bold leading-[1.2] tracking-[-.015em] text-ink-100">{title}</h2>
        {intent?.summary && <p className="fs-13.5 leading-[1.6] text-ink-600/90">{intent.summary}</p>}
        {intent?.title && step.narration && <Words>{step.narration}</Words>}
      </header>

      {folded && (
        <div className="flex items-center gap-2 rounded-[7px] border border-line/10 bg-shade/45 px-2.5 py-[7px] font-mono fs-11.5 text-ink-500/80">
          <span className="fs-9 text-ink-900/70">▸</span>
          <span className="text-ink-900/70">⚙</span>
          <span className="text-ink-100">{folded}</span>
          <span className="text-line/28">·</span>
          <span className="text-ink-900/70">inside this step</span>
          <span className="flex-1" />
          {step.durationMs !== null && <span className="text-ink-900/50">{formatDuration(step.durationMs)}</span>}
        </div>
      )}

      {step.subagent ? (
        <section className="flex flex-col gap-3">
          <span className="font-mono fs-10 tracking-[.18em] text-ink-900/60">SUBAGENT · {step.subagent.name}</span>
          {step.subagent.prompt && <Words small>{step.subagent.prompt}</Words>}
          {step.subagent.steps.map((sub, i) => (
            <SubStep key={sub.id} id={id} session={session} parent={step.ordinal} index={i + 1} sub={sub} />
          ))}
          {rows.length > 0 && (
            <div className="rounded-[7px] border border-line/18 bg-shade/55 [&>*:first-child]:border-t-0">
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
    <details className="group rounded-[7px] border border-line/10 bg-shade/45 open:border-line/18 open:bg-line/5">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 font-mono fs-11.5 text-ink-500/80 [&::-webkit-details-marker]:hidden">
        <span className="fs-9 text-ink-900/70">
          <span className="group-open:hidden">▸</span>
          <span className="hidden group-open:inline">▾</span>
        </span>
        <span className="text-ink-900/70">
          {parent}.{index}
        </span>
        <span className="min-w-0 truncate font-sans fs-12.5 text-ink-100">{title}</span>
        {paths.length > 0 && title !== paths.join(', ') && (
          <>
            <span className="text-line/28">·</span>
            <span className="min-w-0 truncate">{paths.join(', ')}</span>
          </>
        )}
        <span className="flex-1" />
        <Counts counts={callCounts(calls)} />
        <span className="text-ink-900/50">
          <span className="group-open:hidden">expand</span>
          <span className="hidden group-open:inline">collapse</span>
        </span>
      </summary>
      {calls.map((c) => (
        <FileBlock key={c.call.id} id={id} session={session} call={c} inset />
      ))}
      {sub.narration && (
        <div className="border-t border-line/8 px-2.5 py-2">
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
  const ide = ideHere(session)

  return (
    <div
      className={
        inset
          ? 'flex flex-col'
          : [
              'flex flex-col overflow-hidden rounded-[7px] border bg-shade/55',
              failed ? 'border-dashed border-line/18' : 'border-line/18',
            ].join(' ')
      }
    >
      <div
        className={[
          'flex items-center gap-2 px-2.5 py-[7px] font-mono fs-11.5 text-ink-500/80',
          inset ? 'border-t border-line/8' : '',
        ].join(' ')}
      >
        {!inset && <span className="fs-9 text-ink-900/70">▾</span>}
        <span className="text-ink-900/70">⚙</span>
        <span className="min-w-0 truncate">
          {call.call.toolName}: <span className="text-ink-100">{path}</span>
        </span>
        {created && <Tag>NEW</Tag>}
        {failed && <Tag dashed>NOT APPLIED</Tag>}
        <span className="flex-1" />
        <Counts counts={counts} />
        {/* `ideHere`: another device's session has no editor on this one. */}
        {ide && path && (
          <button
            type="button"
            // Silence is the contract for everything IDE (adr
            // `orbital-speaks-to-the-ide-itself`): a failure means the editor
            // went away, which is not news.
            onClick={() => void api.ideOpenFile(id, path, null).catch(() => false)}
            className="shrink-0 border-b border-dashed border-line/25 fs-10 text-ink-900/55"
          >
            open in {ide.ideName} ↗
          </button>
        )}
      </div>
      {failed && call.result?.text && (
        <div className="border-t border-dashed border-line/16 px-2.5 py-1.5 font-mono fs-10.5 whitespace-pre-wrap text-ink-100">
          <span className="text-ink-900/70">error · </span>
          {call.result.text}
        </div>
      )}
      <div className={['border-t border-line/8 bg-panel/90 py-1', failed ? 'opacity-72' : ''].join(' ')}>
        {change ? (
          <ChangeView change={change} isError={failed} />
        ) : (
          <pre className="overflow-x-auto whitespace-pre-wrap px-2.5 font-mono fs-10.5 text-ink-900/70">
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
        'shrink-0 rounded-[4px] border border-line/30 px-1.5 py-px fs-9.5 tracking-[.12em] text-ink-500/75',
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
