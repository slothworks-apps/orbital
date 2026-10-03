/**
 * Settings → Harness templates, the parts worth a test (spec
 * 2026-10-02-harness-redesign-design; canvas Feature - Harness 30j–30m).
 * No React, no store.
 */

import type { HarnessInput, HarnessStep, HarnessTemplate, KnownHarnessProject, TemplateScope } from '../../lib/types'

/** `{{key}}` as the server's `fillInputs` reads it (`server/src/harness/logic.ts`). */
const KEY_PATTERN = /\{\{\s*([\w-]+)\s*\}\}/g

/** A step's text cut into plain runs and `{{key}}` runs, for drawing an unknown key underlined. */
export type KeyedPart = { text: string; key?: string; unknown?: boolean }

export function keyedParts(text: string, known: ReadonlySet<string>): KeyedPart[] {
  const parts: KeyedPart[] = []
  let at = 0
  for (const match of text.matchAll(KEY_PATTERN)) {
    const start = match.index ?? 0
    if (start > at) parts.push({ text: text.slice(at, start) })
    parts.push({ text: match[0], key: match[1], unknown: !known.has(match[1]) })
    at = start + match[0].length
  }
  if (at < text.length) parts.push({ text: text.slice(at) })
  return parts
}

/** Every key a step's texts name, in the four fields a template author writes keys into. */
function stepKeys(step: HarnessStep): string[] {
  return [step.title, step.instructions, step.doneWhen, step.verify ?? '']
    .flatMap((text) => [...text.matchAll(KEY_PATTERN)].map((m) => m[1]))
}

/**
 * 30k's two marks: inputs no step uses ("unused" in the hint row) and keys
 * the steps use that no input defines (underlined). An input with an empty
 * key is neither used nor unused; it is still being typed.
 */
export function inputUsage(inputs: readonly HarnessInput[], steps: readonly HarnessStep[]): {
  unused: Set<string>
  unknown: Set<string>
} {
  const defined = new Set(inputs.map((i) => i.key.trim()).filter(Boolean))
  const used = new Set(steps.flatMap(stepKeys))
  return {
    unused: new Set([...defined].filter((k) => !used.has(k))),
    unknown: new Set([...used].filter((k) => !defined.has(k))),
  }
}

/** 30j's STEPS column: "7 steps · 3 gates", "1 step". */
export function stepsSummary(steps: readonly HarnessStep[]): string {
  const gates = steps.filter((s) => s.mode === 'gate').length
  const count = `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`
  return gates === 0 ? count : `${count} · ${gates} ${gates === 1 ? 'gate' : 'gates'}`
}

/** The list filter: everything, the global templates, or one project's (by root). */
export type ListFilter = { kind: 'all' } | { kind: 'global' } | { kind: 'project'; root: string }

export function scopeKey(scope: TemplateScope | ListFilter): string {
  return scope.kind === 'project' ? `project:${scope.root}` : scope.kind
}

/** The filter chips after All · Global: one per project that has a template, A→Z. */
export function projectChips(templates: readonly HarnessTemplate[]): Array<{ root: string; name: string }> {
  const byRoot = new Map<string, string>()
  for (const t of templates) if (t.scope.kind === 'project') byRoot.set(t.scope.root, t.scope.name)
  return [...byRoot].map(([root, name]) => ({ root, name })).sort(byName)
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name) || 0
}

export interface TemplateGroup {
  key: string
  /** 30j's group heading: "GLOBAL · OFFERED IN EVERY PROJECT", "PROJECT · ORBITAL". */
  heading: string
  templates: HarnessTemplate[]
}

/** 30j: grouped by scope, global first, then projects A→Z; templates A→Z inside a group. */
export function groupTemplates(templates: readonly HarnessTemplate[], filter: ListFilter): TemplateGroup[] {
  const groups: TemplateGroup[] = []
  const pick = (scope: TemplateScope) => templates.filter((t) => scopeKey(t.scope) === scopeKey(scope)).sort(byName)
  if (filter.kind !== 'project') {
    const global = pick({ kind: 'global' })
    if (global.length > 0) groups.push({ key: 'global', heading: 'GLOBAL · OFFERED IN EVERY PROJECT', templates: global })
  }
  if (filter.kind !== 'global') {
    for (const project of projectChips(templates)) {
      if (filter.kind === 'project' && filter.root !== project.root) continue
      groups.push({
        key: `project:${project.root}`,
        heading: `PROJECT · ${project.name.toUpperCase()}`,
        templates: pick({ kind: 'project', root: project.root, name: project.name }),
      })
    }
  }
  return groups
}

/**
 * The project a directory belongs to, as far as the client can tell: the
 * known project whose root is the longest prefix of `cwd`. A worktree under
 * its repository (`<repo>/.claude/worktrees/x`) lands on the repository;
 * anything else falls back to the directory's own name, root `null`.
 */
export function projectOfCwd(
  cwd: string,
  projects: readonly { root: string; name: string }[],
): { root: string | null; name: string } {
  const dir = stripSlash(cwd)
  let best: { root: string; name: string } | null = null
  for (const p of projects) {
    const root = stripSlash(p.root)
    const inside = dir === root || dir.startsWith(root.endsWith('/') ? root : `${root}/`)
    if (inside && (!best || root.length > stripSlash(best.root).length)) best = p
  }
  if (best) return { root: best.root, name: best.name }
  return { root: null, name: dir.slice(dir.lastIndexOf('/') + 1) || dir || '/' }
}

function stripSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

/**
 * 30m: where a new template (or a conversation draft) lives unless the user
 * picks otherwise — the list filter's project, else the project of the
 * session they came from, else Global.
 */
export function defaultScope(
  filter: ListFilter,
  cameFrom: { root: string | null; name: string } | null,
  projects: readonly KnownHarnessProject[],
): TemplateScope {
  if (filter.kind === 'project') {
    const name = projects.find((p) => p.root === filter.root)?.name ?? projectOfCwd(filter.root, []).name
    return { kind: 'project', root: filter.root, name }
  }
  if (cameFrom?.root) return { kind: 'project', root: cameFrom.root, name: cameFrom.name }
  return { kind: 'global' }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 30l's "ran 2 d ago", "ran 3 wk ago", "ran 1 mo ago". */
export function ranAgo(at: number, now: number): string {
  const ms = Math.max(0, now - at)
  if (ms < MINUTE) return 'ran just now'
  if (ms < HOUR) return `ran ${Math.floor(ms / MINUTE)} min ago`
  if (ms < DAY) return `ran ${Math.floor(ms / HOUR)} h ago`
  if (ms < 14 * DAY) return `ran ${Math.floor(ms / DAY)} d ago`
  if (ms < 60 * DAY) return `ran ${Math.floor(ms / (7 * DAY))} wk ago`
  if (ms < 365 * DAY) return `ran ${Math.floor(ms / (30 * DAY))} mo ago`
  return `ran ${Math.floor(ms / (365 * DAY))} y ago`
}

/** One row of 30l's example-session picker. */
export interface PickerSession {
  id: string
  title: string
  project: string
  tags: Array<{ name: string; hue: number }>
  lastAt: number | null
}

/** Sorted by last run, newest first; search matches title, project and tag names. */
export function filterPickerSessions(sessions: readonly PickerSession[], query: string): PickerSession[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return sessions
    .filter((s) => {
      const hay = [s.title, s.project, ...s.tags.map((t) => t.name)].join(' ').toLowerCase()
      return words.every((w) => hay.includes(w))
    })
    .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))
}
