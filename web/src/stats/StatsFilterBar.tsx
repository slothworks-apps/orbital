import type { OrbitalModel } from '../lib/types'
import { modelChipLabel } from '../lib/models'
import { Select } from '../ui/Select'
import { Segmented } from '../ui/Segmented'
import { STATS_WINDOWS, type StatsFilters } from './filters'
import { projectOptions } from './projects'

/**
 * The dashboard's filter bar (canvas 10a): window toggle, project and model,
 * and the range the numbers on screen actually cover. Every filter applies to
 * every panel, so they are one control group over one state.
 *
 * The two dropdowns are `ui/Select` — the app never uses a native `<select>`
 * (see web/CLAUDE.md). Their `short` label is what puts `project:` inside the
 * trigger the way the canvas draws it, while the menu lists bare values.
 */
export function StatsFilterBar({
  filters,
  projects,
  models,
  summary,
  onChange,
}: {
  filters: StatsFilters
  projects: ReadonlyArray<{ cwd: string }>
  models: OrbitalModel[]
  /** What the window turned out to cover; null until the first response lands. */
  summary: { sessionCount: number; windowStart: number | null; windowEnd: number } | null
  onChange: (next: StatsFilters) => void
}) {
  const projectChoices = projectOptions(projects).map((option) => ({
    ...option,
    short: `project: ${option.label}`,
  }))

  const seenModels = new Set<string>()
  const modelChoices = [
    { value: '', label: 'all', short: 'model: all' },
    ...models
      // Two catalog entries can resolve to one model id (a variant and its
      // base), and the filter is on the resolved id — so the second is not an
      // option, it is the same option twice.
      .filter((model) => {
        if (seenModels.has(model.resolvedModel)) return false
        seenModels.add(model.resolvedModel)
        return true
      })
      .map((model) => ({
        value: model.resolvedModel,
        label: modelChipLabel(model),
        short: `model: ${modelChipLabel(model)}`,
      })),
  ]

  return (
    <div className="flex items-center gap-2.5">
      <Segmented
        label="window"
        size="filter"
        options={STATS_WINDOWS.map((value) => ({ value, label: value }))}
        value={filters.window}
        onChange={(window) => onChange({ ...filters, window })}
      />

      <Select
        aria-label="project"
        options={projectChoices}
        value={filters.project ?? ''}
        onChange={(value) => onChange({ ...filters, project: value === '' ? null : value })}
      />
      <Select
        aria-label="model"
        options={modelChoices}
        value={filters.model ?? ''}
        onChange={(value) => onChange({ ...filters, model: value === '' ? null : value })}
      />

      <span className="flex-1" />
      {summary !== null && (
        <div className="font-mono text-[10.5px] text-[rgba(160,190,225,.5)]">
          {rangeLabel(summary.windowStart, summary.windowEnd)} · {summary.sessionCount} sessions ·
          local data only
        </div>
      )}
    </div>
  )
}

/** "14 Sep – 20 Sep 2026", or "all time" for the window that has no start. */
function rangeLabel(windowStart: number | null, windowEnd: number): string {
  const end = new Date(windowEnd).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
  if (windowStart === null) return `all time · to ${end}`
  const start = new Date(windowStart).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  })
  return `${start} – ${end}`
}
