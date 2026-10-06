import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { gutterLayout } from '../../lib/harnessGraph'
import { pillReading } from '../../lib/harnessSession'
import type { HarnessEvent, SessionHarness } from '../../lib/types'
import { act } from '../../panels/harness/actions'
import { GutterCell } from '../../panels/harness/Gutter'
import { MARKER, eventsOfStep, isGateShape, stepKind, stepMeta, stepWho } from '../../panels/harness/model'
import { FilledButton } from '../../panels/harness/parts'
import { ProposalCard } from '../../panels/harness/ProposalCard'
import { useOrbital } from '../../store/store'

const NO_EVENTS: HarnessEvent[] = []

/** The checklist, read-only but for its gates: each waiting one carries Approve. */
function Checklist({ sessionId, harness, events }: { sessionId: string; harness: SessionHarness; events: readonly HarnessEvent[] }) {
  const gutter = gutterLayout(harness.steps)
  return (
    <div className="flex flex-col">
      {harness.steps.map((step, i) => {
        const state = harness.state[i] ?? { status: 'pending' as const }
        const own = eventsOfStep(events, step, i, harness.createdAt)
        const kind = stepKind(step, state, harness, own)
        return (
          <div key={step.id} className="flex gap-2.5">
            <GutterCell row={gutter.rows[i]} lanes={gutter.lanes} kind={kind} gate={isGateShape(kind, step)} />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5 pb-3">
              <span className="text-pretty text-[13.5px] font-semibold leading-[1.4]" style={{ color: MARKER[kind].titleInk }}>
                {step.title}
              </span>
              <span className="font-mono text-[10.5px]" style={{ color: MARKER[kind].metaInk }}>
                {stepMeta(i, step, stepWho(kind, step, state, harness, own))}
              </span>
              {kind === 'waiting' && (
                <div className="flex flex-col gap-2">
                  {state.summary && <div className="text-pretty text-[13px] leading-[1.5] text-[rgba(220,232,248,.88)]">{state.summary}</div>}
                  <div>
                    <FilledButton onClick={() => void act(sessionId, 'Failed to approve the step', () => api.approveHarnessStep(sessionId, i))}>
                      Approve
                    </FilledButton>
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * The session's harness on the phone (spec 2026-10-06-harness-graph-and-
 * proposals-design § The phone): one line under the header — its name, where
 * it stands — that opens the checklist with its branches. A gate is approved
 * here and a proposal applied or discarded; starting, editing, reopening and
 * going back stay on the Mac.
 */
export function HarnessStrip({ sessionId }: { sessionId: string }) {
  const harness = useOrbital((s) => s.harnesses[sessionId]) ?? null
  const proposal = useOrbital((s) => s.harnessProposals[sessionId]) ?? null
  const events = useOrbital((s) => s.harnessEvents[sessionId]) ?? NO_EVENTS
  const asks = useOrbital((s) => s.sessions[sessionId]?.harnessGate)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    void useOrbital.getState().loadHarness(sessionId)
  }, [sessionId, asks])

  if (!harness && !proposal) return null
  const reading = harness ? pillReading(harness) : null
  const line = reading
    ? `${harness!.name} · ${reading.count} · ${proposal ? 'a change proposed' : reading.status}`
    : 'the agent proposes a harness'
  const ink = proposal ? '#ffbb7b' : (reading?.statusInk ?? 'rgba(160,190,225,.6)')

  return (
    <div className="border-t border-[rgba(150,205,255,.08)]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-10 w-full min-w-0 items-center gap-2 px-4 text-left font-mono text-[10.5px] tracking-[0.06em]"
      >
        <span className="shrink-0 tracking-[0.16em] text-[rgba(160,190,225,.55)]">HARNESS</span>
        <span className="min-w-0 flex-1 truncate" style={{ color: ink }}>
          {line}
        </span>
        <span className="shrink-0 text-[rgba(160,190,225,.6)]">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto px-4 pb-4 pt-1">
          {proposal && <ProposalCard sessionId={sessionId} harness={harness} proposal={proposal} edit={false} />}
          {harness && <Checklist sessionId={sessionId} harness={harness} events={events} />}
        </div>
      )}
    </div>
  )
}
