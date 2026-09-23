import { Fragment, useState } from 'react'
import { formatDuration } from '../lib/format'
import type { Gap } from '../lib/types'
import { foldedParts } from './derive'
import { Words } from './parts'

/**
 * How many lines of what the agent said show before `more` (canvas 21c).
 * `Words` spells the same number as its `line-clamp-*` class, since Tailwind
 * cannot build a class from a variable; change both together.
 * `SAID_CLAMP_CHARS` guesses when one long paragraph wraps past the clamp.
 */
const SAID_CLAMP_LINES = 3
const SAID_CLAMP_CHARS = 280

interface GapLineProps {
  gap: Gap | null
  /** The eyebrow: `BETWEEN 3 AND 4`, `BEFORE STEP 1`, `AFTER THE LAST STEP`. */
  label: string
  /** The step before the gap, for the `▲` line above it; absent before the first step. */
  prev?: { ordinal: number; title: string }
}

/**
 * What happened between two changes (canvas 21c): how long, what it read and
 * ran, subagents that wrote nothing, and what the agent said — verbatim, its
 * own text node, so the words are the transcript's.
 */
export function GapLine({ gap, label, prev }: GapLineProps) {
  const [open, setOpen] = useState(false)
  if (!gap) return null
  const parts = foldedParts(gap.folded)
  const facts = [
    ...parts.map((p) => (
      <span key={`f:${p}`} className="text-text-bright">
        {p}
      </span>
    )),
    ...gap.subagents.map((name, i) => (
      <span key={`s:${i}`}>
        subagent &ldquo;<span className="text-text-bright">{name}</span>&rdquo; changed nothing
      </span>
    )),
  ]
  const long = gap.said.split('\n').length > SAID_CLAMP_LINES || gap.said.length > SAID_CLAMP_CHARS

  return (
    <div className="flex flex-col gap-2">
      {prev && (
        <span className="flex min-w-0 gap-1.5 font-mono text-[10.5px] text-[rgba(160,190,225,.45)]">
          <span className="shrink-0">▲ step {prev.ordinal}</span>
          <span className="text-[rgba(150,205,255,.25)]">·</span>
          <span className="truncate">{prev.title}</span>
        </span>
      )}
      <div className="flex flex-col gap-1.5 rounded-[9px] border border-dotted border-[rgba(150,205,255,.25)] bg-[rgba(4,8,16,.35)] px-4 py-3">
        <span className="flex font-mono text-[9.5px] tracking-[.14em] text-[rgba(160,190,225,.55)]">
          {label}
          <span className="flex-1" />
          {gap.durationMs !== null && <span className="tracking-normal text-[rgba(160,190,225,.5)]">{formatDuration(gap.durationMs)}</span>}
        </span>
        {facts.length > 0 && (
          <span className="flex flex-wrap gap-x-1.5 font-mono text-[11px] text-[rgba(200,220,245,.8)]">
            {facts.map((fact, i) => (
              <Fragment key={i}>
                {i > 0 && <span className="text-[rgba(150,205,255,.28)]">·</span>}
                {fact}
              </Fragment>
            ))}
          </span>
        )}
        {gap.said && (
          <div className="flex flex-col items-start gap-0.5">
            <Words small clamp={!open}>
              {gap.said}
            </Words>
            {long && (
              <button type="button" onClick={() => setOpen(!open)} className="pl-3.5 font-mono text-[10.5px] text-text-muted hover:underline">
                {open ? 'less' : 'more'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
