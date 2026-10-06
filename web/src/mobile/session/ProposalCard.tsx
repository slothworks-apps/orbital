import { useState } from 'react'
import { ProposalCard as Card } from '../../panels/harness/ProposalCard'
import { useOrbital } from '../../store/store'

/**
 * What the agent proposed, under the header (spec 2026-10-06-harness-graph-
 * and-proposals-design § The phone): one amber line that opens the card —
 * attach or apply, or discard. Editing it stays on the Mac.
 */
export function ProposalLine({ sessionId }: { sessionId: string }) {
  const harness = useOrbital((s) => s.harnesses[sessionId]) ?? null
  const proposal = useOrbital((s) => s.harnessProposals[sessionId]) ?? null
  const [open, setOpen] = useState(false)
  if (!proposal) return null
  return (
    <div className="border-t border-[rgba(150,205,255,.08)]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-10 w-full min-w-0 items-center gap-2 px-4 text-left font-mono text-[10.5px] tracking-[0.06em] text-[#ffbb7b]"
      >
        <span className="min-w-0 flex-1 truncate">
          {proposal.kind === 'harness' ? `The agent proposes a harness · ${proposal.harness.name}` : 'The agent proposes a change to the harness'}
        </span>
        <span className="shrink-0 text-[rgba(160,190,225,.6)]">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="max-h-[55vh] overflow-y-auto px-4 pb-4 pt-1">
          <Card sessionId={sessionId} harness={harness} proposal={proposal} edit={false} />
        </div>
      )}
    </div>
  )
}
