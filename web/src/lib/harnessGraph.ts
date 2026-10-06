/**
 * A harness's steps as a graph (spec 2026-10-06-harness-graph-and-proposals-
 * design): what a step needs, what needs it, and how the checklist's gutter
 * draws the branches, `git log --graph` style. Pure; the server keeps the
 * same rules in `server/src/harness/logic.ts`.
 */

import type { HarnessChanges, HarnessStep, StepState } from './types'

/** The ids a step needs: the ones it names, or the step before it when it names none. */
export function depsOf(steps: readonly HarnessStep[], index: number): string[] {
  return steps[index].dependsOn ?? (index === 0 ? [] : [steps[index - 1].id])
}

/** The steps that need `index`, directly or through others, in checklist order. */
export function descendantsOf(steps: readonly HarnessStep[], index: number): number[] {
  const ids = new Set([steps[index].id])
  const found: number[] = []
  for (let j = index + 1; j < steps.length; j++) {
    if (depsOf(steps, j).some((id) => ids.has(id))) {
      ids.add(steps[j].id)
      found.push(j)
    }
  }
  return found
}

/** Whether the steps branch at all — a plain list draws no lanes worth a second look. */
export const isLinear = (steps: readonly HarnessStep[]): boolean =>
  steps.every((_, i) => {
    const deps = depsOf(steps, i)
    return i === 0 ? deps.length === 0 : deps.length === 1 && deps[0] === steps[i - 1].id
  })

/**
 * One row of the gutter. Lanes are columns, 0 on the left. A line runs down
 * a lane from one step to a step that needs it; the row's step sits in
 * `lane`.
 */
export interface GutterRow {
  lane: number
  /** Lanes whose line passes this row by, top to bottom. */
  through: number[]
  /** A line comes into the step from above, in its own lane. */
  top: boolean
  /** Lanes whose lines end at this step, drawn bending in from above. */
  merges: number[]
  /** A line leaves the step downwards, in its own lane. */
  bottom: boolean
  /** Lanes a line leaves the step for, bending out below the marker. */
  forks: number[]
  /** Every lane with a line on its way down after this row. */
  below: number[]
}

export interface Gutter {
  rows: GutterRow[]
  /** The most lanes any row uses. */
  lanes: number
}

/**
 * Lays the checklist's lines out in lanes, in reading order. Each line is one
 * dependency, from a step down to a later step that needs it; it takes the
 * step's own lane when that is free, else the leftmost free lane, and where
 * several lines end at one step, they join it.
 */
export function gutterLayout(steps: readonly HarnessStep[]): Gutter {
  const index = new Map(steps.map((s, i) => [s.id, i]))
  const needers = steps.map(() => [] as number[])
  steps.forEach((_, j) => {
    for (const id of depsOf(steps, j)) {
      const i = index.get(id)
      if (i !== undefined && i < j) needers[i].push(j)
    }
  })
  // Each lane holds the row its line is heading to, or null when free.
  const lanes: (number | null)[] = []
  const free = () => {
    const at = lanes.indexOf(null)
    return at === -1 ? lanes.length : at
  }
  const rows: GutterRow[] = []
  let widest = 1
  steps.forEach((_, r) => {
    const incoming = lanes.flatMap((to, l) => (to === r ? [l] : []))
    const lane = incoming.length > 0 ? incoming[0] : free()
    const through = lanes.flatMap((to, l) => (to !== null && to !== r ? [l] : []))
    for (const l of incoming) lanes[l] = null
    const out = needers[r]
    let bottom = false
    const forks: number[] = []
    out.forEach((to, k) => {
      if (k === 0) {
        lanes[lane] = to
        bottom = true
        return
      }
      const l = free()
      lanes[l] = to
      forks.push(l)
    })
    widest = Math.max(widest, lanes.length, lane + 1)
    const below = lanes.flatMap((to, l) => (to !== null ? [l] : []))
    rows.push({ lane, through, top: incoming.includes(lane), merges: incoming.filter((l) => l !== lane), bottom, forks, below })
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()
  })
  return { rows, lanes: widest }
}

/**
 * The step the header and the pill speak of: a gate waiting for the user
 * first — it is what the session asks for, wherever it sits in the graph —
 * then one being reviewed, then the first step not done; -1 when all are.
 */
export function currentIndex(state: readonly Pick<StepState, 'status' | 'reviewing'>[]): number {
  const waiting = state.findIndex((s) => s.status === 'awaiting_approval' && !s.reviewing)
  if (waiting !== -1) return waiting
  const reviewing = state.findIndex((s) => s.status === 'awaiting_approval')
  return reviewing !== -1 ? reviewing : state.findIndex((s) => s.status !== 'done')
}

/**
 * The change that turns `before` into `after`, as the edit route takes it:
 * steps new by id are added, steps whose fields differ are updated, steps
 * gone are removed. The order of `after` is not part of it — a running
 * harness appends what is added.
 */
export function diffSteps(before: readonly HarnessStep[], after: readonly HarnessStep[]): HarnessChanges {
  const old = new Map(before.map((s) => [s.id, s]))
  const kept = new Set(after.map((s) => s.id))
  const add = after.filter((s) => !old.has(s.id))
  const update = after.filter((s) => old.has(s.id) && JSON.stringify(normal(s)) !== JSON.stringify(normal(old.get(s.id)!)))
  const remove = before.filter((s) => !kept.has(s.id)).map((s) => s.id)
  return {
    ...(add.length ? { add } : {}),
    ...(update.length ? { update } : {}),
    ...(remove.length ? { remove } : {}),
  }
}

/** A step's fields in one order, without empty optional ones, for comparing. */
function normal(s: HarnessStep) {
  return { id: s.id, title: s.title, instructions: s.instructions, mode: s.mode, doneWhen: s.doneWhen, verify: s.verify || undefined, dependsOn: s.dependsOn }
}

/** The steps as a change would leave them, for showing a proposed change: updated in place, removed, added at the end. */
export function withChanges(steps: readonly HarnessStep[], changes: HarnessChanges): HarnessStep[] {
  const update = new Map((changes.update ?? []).map((s) => [s.id, s]))
  const removed = new Set(changes.remove ?? [])
  return [...steps.filter((s) => !removed.has(s.id)).map((s) => update.get(s.id) ?? s), ...(changes.add ?? [])]
}
