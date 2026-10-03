/**
 * "Copy record as Markdown" (canvas 30f ⋯ menu; 30g: "exports steps + events
 * in order"): the harness's record as one document — each step with its
 * record and what happened, the harness's own events where they happened.
 */

import type { HarnessEvent, PreviousRun, SessionHarness, StepState } from '../../lib/types'
import {
  clock,
  eventsOfHarness,
  eventsOfStep,
  inputsLine,
  pad2,
  railItems,
  shortSha,
  stepKind,
  stepWho,
  verdictWord,
  whatHappened,
} from './model'

function recordLines(record: StepState | PreviousRun, out: string[]): void {
  const summary = record.summary ?? record.evidence
  if (summary) out.push('', summary)
  if (record.decisions?.length) {
    out.push('', '**Decisions**')
    for (const d of record.decisions) {
      out.push(`- ${d.what} — why: ${d.why}${d.alternatives ? ` — instead of: ${d.alternatives}` : ''}`)
    }
  }
  if (record.openQuestions?.length) {
    out.push('', '**Open questions**')
    for (const q of record.openQuestions) out.push(`- ◇ ${q}`)
  }
  if (record.reviews?.length) {
    out.push('', '**Reviews**')
    for (const r of record.reviews) {
      out.push(`- ${clock(r.at)} ${verdictWord(r)}: ${r.reasoning}`)
      if (r.findings.length) out.push(`  - findings: ${r.findings.join(' · ')}`)
      if (r.checked.length) out.push(`  - checked: ${r.checked.join(' · ')}`)
    }
  }
  if (record.startHead && record.endHead) out.push('', `Commits: \`${shortSha(record.startHead)}..${shortSha(record.endHead)}\``)
}

export function recordMarkdown(harness: SessionHarness, events: readonly HarnessEvent[]): string {
  const out: string[] = [`# ${harness.name}`]
  const inputs = inputsLine(harness.inputs)
  if (inputs) out.push('', inputs)
  const done = harness.state.filter((s) => s.status === 'done').length
  out.push('', `${done} of ${harness.steps.length} done · started ${clock(harness.createdAt)}`)
  const all = eventsOfHarness(harness, events)

  for (const item of railItems(harness, events)) {
    if (item.kind === 'event') {
      out.push('', `— ${item.text}`)
      continue
    }
    const i = item.index
    const step = harness.steps[i]
    const state = harness.state[i] ?? { status: 'pending' as const }
    const own = eventsOfStep(all, step, i, harness.createdAt)
    const kind = stepKind(step, state, harness, own)
    const who = stepWho(kind, step, state, harness, own)
    out.push('', `## ${pad2(i + 1)} · ${step.mode === 'gate' ? '◆' : '●'} ${step.title}`, '', `${step.mode}${who ? ` · ${who}` : ''}`)
    recordLines(state, out)

    const runs = state.previousRuns ?? []
    const since = runs.length > 0 ? runs[runs.length - 1].endedAt : 0
    const happened = whatHappened(own, harness.steps, since, Infinity)
    if (happened.length) {
      out.push('', '**What happened**')
      for (const h of happened) out.push(`- ${clock(h.at)} ${h.text}`)
    }
    let from = 0
    for (const run of runs) {
      out.push('', `### ${run.reason === 'went_back' ? 'Before going back' : 'Before you reopened it'} · ${clock(run.endedAt)}`)
      recordLines(run, out)
      const earlier = whatHappened(own, harness.steps, from, run.endedAt)
      if (earlier.length) {
        out.push('', '**What happened**')
        for (const h of earlier) out.push(`- ${clock(h.at)} ${h.text}`)
      }
      from = run.endedAt
    }
  }
  return out.join('\n') + '\n'
}
