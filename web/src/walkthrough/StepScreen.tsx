import type { ApiSession, Walkthrough } from '../lib/types'
import { gapBefore, stepLabel } from './derive'
import { GapLine } from './GapLine'
import { WalkButton } from './parts'
import { StepBody } from './StepBody'
import { StepRail } from './StepRail'
import { TopBar } from './TopBar'

interface StepScreenProps {
  id: string
  session: ApiSession
  walkthrough: Walkthrough
  index: number
  onPrev(): void
  onNext(): void
  onJump(stepId: string): void
  onRefetch(): void
}

/** Screen two (canvas 21b): the rail on the left, one step in the middle, and the way on. */
export function StepScreen({ id, session, walkthrough, index, onPrev, onNext, onJump, onRefetch }: StepScreenProps) {
  const total = walkthrough.steps.length
  const step = walkthrough.steps[index]
  if (!step) return null
  const n = index + 1
  const prev = index > 0 ? walkthrough.steps[index - 1] : null

  return (
    <div className="flex h-screen flex-col">
      <TopBar id={id} session={session} crumb={`step ${n} of ${total}`} />

      <div className="flex min-h-0 flex-1">
        <aside className="w-[320px] shrink-0 overflow-y-auto border-r border-[rgba(150,205,255,.08)] px-3.5 py-[18px]">
          <StepRail walkthrough={walkthrough} currentId={step.id} onJump={onJump} />
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="flex min-h-full max-w-[820px] flex-col gap-5 px-12 pt-[30px]">
            <GapLine
              key={step.id}
              gap={gapBefore(walkthrough, step.id)}
              label={prev ? `BETWEEN ${prev.ordinal} AND ${step.ordinal}` : `BEFORE STEP ${step.ordinal}`}
              prev={prev ? { ordinal: prev.ordinal, title: stepLabel(walkthrough, prev) } : undefined}
            />
            <StepBody id={id} session={session} walkthrough={walkthrough} step={step} onJump={onJump} onRefetch={onRefetch} />
          </div>
        </main>
      </div>

      <footer className="flex h-[60px] shrink-0 items-center gap-4 border-t border-[rgba(150,205,255,.08)] px-12">
        <WalkButton tone="quiet" size="sm" disabled={index === 0} onClick={onPrev}>
          ← Previous
        </WalkButton>
        <span className="flex-1 text-center font-mono text-[10.5px] tracking-[.1em] tabular-nums text-[rgba(160,190,225,.5)]">
          {n} / {total}
        </span>
        <WalkButton tone="lit" size="sm" onClick={onNext}>
          {index === total - 1 ? 'Close →' : 'Next →'}
        </WalkButton>
      </footer>
    </div>
  )
}
