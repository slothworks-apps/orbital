import { useState } from 'react'
import { api } from '../../lib/api'
import { diffSteps, gutterLayout, withChanges } from '../../lib/harnessGraph'
import type { HarnessProposal, HarnessStep, SessionHarness } from '../../lib/types'
import { act, attempt } from './actions'
import { GutterCell } from './Gutter'
import { clock, pad2 } from './model'
import { AccentLink, FilledButton, Label, OutlineButton } from './parts'
import { StepsDialog } from './StepsDialog'

const BODY = 'text-pretty text-[12px] leading-[1.55] text-[rgba(220,232,248,.88)]'
const MONO = 'font-mono text-[10px] text-[rgba(160,190,225,.6)]'

/** A proposed harness's steps, drawn with the checklist's gutter so its branches show. */
function ProposedSteps({ steps }: { steps: readonly HarnessStep[] }) {
  const gutter = gutterLayout(steps)
  return (
    <div className="flex flex-col">
      {steps.map((step, i) => (
        <div key={step.id} className="flex gap-2.5">
          <GutterCell row={gutter.rows[i]} lanes={gutter.lanes} kind={step.mode === 'gate' ? 'pendingGate' : 'pending'} gate={step.mode === 'gate'} />
          <div className="flex min-w-0 flex-1 items-baseline gap-2 pb-2">
            <span className={MONO}>{pad2(i + 1)}</span>
            <span className="min-w-0 truncate text-[12px] font-semibold text-[rgba(220,235,255,.85)]">{step.title}</span>
            <span aria-hidden className="flex-1" />
            {step.mode === 'gate' && <span className={MONO}>gate</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

/** A proposed change as lines: + added, ~ changed, − removed, numbered as the checklist will number them. */
function ProposedChanges({ harness, proposal }: { harness: SessionHarness; proposal: Extract<HarnessProposal, { kind: 'changes' }> }) {
  const after = withChanges(harness.steps, proposal.changes)
  const n = (id: string) => pad2(after.findIndex((s) => s.id === id) + 1)
  const needs = (s: HarnessStep) => (s.dependsOn ? ` ← ${s.dependsOn.map(n).join(', ') || 'none'}` : '')
  const lines = [
    ...(proposal.changes.add ?? []).map((s) => ({ mark: '+', text: `${n(s.id)} ${s.title}${needs(s)}` })),
    ...(proposal.changes.update ?? []).map((s) => ({ mark: '~', text: `${n(s.id)} ${s.title}${needs(s)}` })),
    ...(proposal.changes.remove ?? []).map((id) => ({ mark: '−', text: harness.steps.find((s) => s.id === id)?.title ?? id })),
  ]
  return (
    <div className="flex flex-col gap-1 font-mono text-[11px] text-[rgba(220,235,255,.85)]">
      {lines.map((l, i) => (
        <div key={i} className="flex gap-2">
          <span className="w-2.5 shrink-0 text-[rgba(160,190,225,.7)]">{l.mark}</span>
          <span className="min-w-0 truncate">{l.text}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * What the agent proposed (spec 2026-10-06-harness-graph-and-proposals-design
 * § The pending proposal): a harness to attach, or a change to the running
 * one, with the agent's note. It waits for the user like a gate does. `edit`
 * off on the phone, which applies or discards only.
 */
export function ProposalCard({
  sessionId,
  harness,
  proposal,
  edit = true,
}: {
  sessionId: string
  harness: SessionHarness | null
  proposal: HarnessProposal
  edit?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const whole = proposal.kind === 'harness'
  const shown = proposal.kind === 'harness' ? proposal.harness.steps : harness ? withChanges(harness.steps, proposal.changes) : []
  const locked = harness?.state.flatMap((s, i) => (s.status === 'done' || s.status === 'awaiting_approval' ? [harness.steps[i].id] : [])) ?? []

  return (
    <div className="flex flex-col gap-2.5 rounded-[9px] border border-[oklch(84%_.113_63_/_.35)] bg-[rgba(4,8,16,.5)] px-3 py-[11px]">
      <Label>
        {whole ? 'THE AGENT PROPOSES A HARNESS' : 'THE AGENT PROPOSES A CHANGE'} · {clock(proposal.createdAt)}
      </Label>
      {proposal.kind === 'harness' && <div className="text-[13px] font-semibold text-text-bright">{proposal.harness.name}</div>}
      {proposal.note && <div className={BODY}>{proposal.note}</div>}
      {proposal.kind === 'harness' ? (
        <ProposedSteps steps={proposal.harness.steps} />
      ) : (
        harness && <ProposedChanges harness={harness} proposal={proposal} />
      )}
      <div className="flex items-center gap-2">
        <FilledButton onClick={() => void act(sessionId, 'Failed to apply the proposal', () => api.applyHarnessProposal(sessionId))}>
          {whole ? 'Attach' : 'Apply'}
        </FilledButton>
        {edit && <OutlineButton onClick={() => setEditing(true)}>Edit</OutlineButton>}
        <span aria-hidden className="flex-1" />
        <AccentLink onClick={() => void act(sessionId, 'Failed to discard the proposal', async () => void (await api.discardHarnessProposal(sessionId)))}>
          DISCARD
        </AccentLink>
      </div>
      {edit && (
        <StepsDialog
          open={editing}
          eyebrow={whole ? 'PROPOSED HARNESS' : 'PROPOSED CHANGE'}
          title={whole ? 'Edit, then attach' : 'Edit, then apply'}
          steps={shown}
          locked={locked}
          name={proposal.kind === 'harness' ? proposal.harness.name : undefined}
          saveLabel={whole ? 'Attach' : 'Apply'}
          onClose={() => setEditing(false)}
          onSave={async (steps, name) => {
            const error = await attempt(sessionId, () =>
              api.applyHarnessProposal(
                sessionId,
                whole ? { harness: { name: name ?? '', steps } } : { changes: diffSteps(harness?.steps ?? [], steps) },
              ),
            )
            if (!error) setEditing(false)
            return error
          }}
        />
      )}
    </div>
  )
}
