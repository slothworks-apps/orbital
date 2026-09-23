import type { Walkthrough, WalkthroughStep } from '../lib/types'
import { blindAlleySteps, callsOf, foldedLine, gapBefore, pathOf, plural, railGroups, stepLabel, stillOpen } from './derive'

interface StepRailProps {
  walkthrough: Walkthrough
  currentId: string
  onJump(stepId: string): void
}

/**
 * Every step, for a jump (canvas 21b's left column). Grouped under the
 * narration's intents when there is one. Marks are ink, not colour: `↶ n` for
 * a blind alley (reverted in step n), `not applied` for a failed call nothing
 * later made good; a gap between two steps is a dotted band saying what
 * happened in it.
 */
export function StepRail({ walkthrough, currentId, onJump }: StepRailProps) {
  const blind = new Set(blindAlleySteps(walkthrough).map((s) => s.id))
  // A failure a later call on its path made good is not marked (the close screen's rule).
  const open = new Set(stillOpen(walkthrough).map((o) => o.call))
  const firstId = walkthrough.steps[0]?.id
  const ordinalOf = (id: string) => walkthrough.steps.find((s) => s.id === id)?.ordinal

  const blindMark = (step: WalkthroughStep): string => {
    const revert = step.fate.find((f) => f.kind === 'reverted')
    const by = revert ? ordinalOf(revert.byStep) : undefined
    return by === undefined ? '↶' : `↶ ${by}`
  }

  const gapBand = (stepId: string): string | null => {
    if (stepId === firstId) return null
    const gap = gapBefore(walkthrough, stepId)
    if (!gap) return null
    const said = [foldedLine(gap.folded), gap.subagents.length > 0 ? `${plural(gap.subagents.length, 'subagent', 'subagents')}, no change` : '']
    return said.filter(Boolean).join(' · ')
  }

  return (
    <nav aria-label="step list" className="flex flex-col gap-3.5">
      {railGroups(walkthrough).map((group, g) => (
        <div key={g} className="flex flex-col gap-0.5">
          {group.title && (
            <span className="px-2.5 pt-1 pb-1.5 font-mono text-[9.5px] uppercase tracking-[.14em] text-[rgba(160,190,225,.55)]">{group.title}</span>
          )}
          {group.steps.map((step) => {
            const current = step.id === currentId
            const isBlind = blind.has(step.id)
            const calls = callsOf(step)
            const names = [...new Set(calls.map(pathOf).filter((p): p is string => !!p).map(basename))]
            const meta = step.subagent ? `subagent · ${plural(step.subagent.steps.length, 'sub-step', 'sub-steps')}` : names.join(', ')
            const notApplied = calls.some((c) => open.has(c))
            const band = gapBand(step.id)
            return (
              <div key={step.id} className="flex flex-col gap-0.5">
                {band !== null && (
                  <div className="mx-2.5 my-1 border-y border-dotted border-[rgba(150,205,255,.2)] py-1.5 font-mono text-[9.5px] text-[rgba(160,190,225,.5)]">
                    <span className="tracking-[.1em]">···</span>
                    {band && ` ${band}`}
                  </div>
                )}
                <button
                  type="button"
                  aria-current={current ? 'step' : undefined}
                  onClick={() => onJump(step.id)}
                  className={[
                    'flex items-start gap-2.5 rounded-[7px] px-2.5 py-[7px] text-left',
                    // canvas 21b: the current row's inset bar is the accent, oklch(85% .12 205).
                    current ? 'bg-[rgba(150,205,255,.1)] shadow-[inset_2px_0_0_oklch(85%_.12_205)]' : 'hover:bg-[rgba(150,205,255,.07)]',
                  ].join(' ')}
                >
                  <span
                    className={[
                      'w-4 shrink-0 font-mono text-[10.5px] leading-[1.5] tabular-nums',
                      current ? 'text-text-soft' : 'text-[rgba(160,190,225,.5)]',
                    ].join(' ')}
                  >
                    {step.ordinal}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span
                      className={[
                        'truncate text-[12.5px] leading-[1.5]',
                        current ? 'text-white' : isBlind ? 'text-[rgba(160,190,225,.5)]' : 'text-text-bright',
                      ].join(' ')}
                    >
                      {stepLabel(walkthrough, step)}
                    </span>
                    {meta && <span className="truncate font-mono text-[9.5px] text-[rgba(160,190,225,.5)]">{meta}</span>}
                  </span>
                  {isBlind && <span className="shrink-0 font-mono text-[10px] text-[rgba(160,190,225,.6)]">{blindMark(step)}</span>}
                  {notApplied && <span className="shrink-0 font-mono text-[10px] text-[rgba(160,190,225,.6)]">not applied</span>}
                </button>
              </div>
            )
          })}
        </div>
      ))}
    </nav>
  )
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
