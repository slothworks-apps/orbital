/**
 * What the `/context` report dialog draws, worked out from the report the CLI
 * attaches to its answer (`notice.contextReport`; spec
 * 2026-11-19-context-report-dialog-design, canvas `Feature - Context report`
 * 70a–70f). Pure: the Mac's dialog and the phone's sheet both draw from it.
 *
 * Classification is by `kind`, never by the English `name` — the SDK's own
 * rule. The one use of a name is the colour slot, which only says which of
 * the seven known categories a `used` row is, so that a category keeps its
 * colour whichever others are present.
 */

import { homePath } from './format'
import { contextLevel, type ContextLevel, type ContextThresholds } from './usage'
import type { ContextReport } from './types'
import type { ReportPreview } from '../store/contextReport'

/** A slash command line that runs `/context`, with or without arguments. */
export function isContextCommand(text: string): boolean {
  return /^\s*\/context(?:\s|$)/.test(text)
}

const oneDecimal = (x: number): string => (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, '')

/** Tokens the way the CLI's printout writes them: `654`, `2.8k`, `108.8k`, `1M`. */
export function formatReportTokens(n: number): string {
  // 999,960 would round to "1000k": it is already "1M".
  if (Math.round(n / 100) >= 10_000) return `${oneDecimal(n / 1e6)}M`
  if (n >= 1000) return `${oneDecimal(n / 1000)}k`
  return String(Math.round(n))
}

/** A share of the window, canvas 70c's legend column: `0.3 %`, `<0.1 %`, `86 %`. */
export function formatShare(tokens: number, window: number): string {
  const p = window > 0 ? (tokens / window) * 100 : 0
  if (p <= 0) return '0 %'
  if (p < 0.1) return '<0.1 %'
  if (p < 10) return `${oneDecimal(p)} %`
  return `${Math.round(p)} %`
}

/**
 * The seven fixed category slots in the CLI's order (canvas 70e, `data-1`
 * … `data-7`). A slot belongs to its category: one that is absent leaves a
 * gap, and the others keep their colours.
 */
export const CATEGORY_SLOTS = [
  'System prompt',
  'System tools',
  'MCP tools',
  'Custom agents',
  'Memory files',
  'Skills',
  'Messages',
] as const

export type CategorySlot = 1 | 2 | 3 | 4 | 5 | 6 | 7

const SLOT_OF_NAME = new Map<string, CategorySlot>(CATEGORY_SLOTS.map((name, i) => [name, (i + 1) as CategorySlot]))

/**
 * The slot of each `used` category, in the order given. A known category
 * takes its own slot; one the CLI has added since takes the first slot no
 * known category of this report holds, so it never shares a colour with a
 * neighbour it could be confused with while there is a free one.
 */
export function categorySlots(names: readonly string[]): CategorySlot[] {
  const taken = new Set<CategorySlot>()
  for (const name of names) {
    const slot = SLOT_OF_NAME.get(name)
    if (slot) taken.add(slot)
  }
  let next = 0
  return names.map((name) => {
    const known = SLOT_OF_NAME.get(name)
    if (known) return known
    for (let tries = 0; tries < CATEGORY_SLOTS.length; tries++) {
      const slot = ((next++ % CATEGORY_SLOTS.length) + 1) as CategorySlot
      if (!taken.has(slot)) {
        taken.add(slot)
        return slot
      }
    }
    // Every slot is held: colours repeat, and the legend names them.
    return ((next++ % CATEGORY_SLOTS.length) + 1) as CategorySlot
  })
}

/** Where a skill, an agent or a memory file came from, in the CLI's printout's words. */
export function sourceLabel(source: string): string {
  switch (source) {
    case 'userSettings':
      return 'User'
    case 'projectSettings':
      return 'Project'
    case 'localSettings':
      return 'Local'
    case 'policySettings':
      return 'Managed'
    case 'built-in':
    case 'builtin':
      return 'Built-in'
    case 'syncedSkills':
      return 'claude.ai sync'
    case 'plugin':
      return 'Plugin'
    case '':
      return 'Other'
    default:
      return source
  }
}

/**
 * A memory file's path as 70d draws it: the home directory as `~`, then the
 * file and its folder with the middle as `…`. The full path is the row's
 * tooltip.
 */
export function shortenMemoryPath(path: string): string {
  const home = homePath(path)
  const seg = home.split('/')
  return seg.length <= 4 ? home : `${seg[0]}/…/${seg.slice(-2).join('/')}`
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

export interface BreakdownItem {
  name: string
  tokens: number
}

export interface BreakdownGroup {
  /** What the row says: a server, a plugin or source, a shortened path, an agent. */
  lead: string
  /** The row's tooltip, where `lead` is shortened. */
  full: string
  mono: boolean
  /** Mono, right of the lead: a count, a type, a source. */
  tag: string
  tokens: number
  /** Tokens against the heaviest row of the section, 0–1: the row's bar. */
  share: number
  /** What the row opens to; empty for a row that does not open. */
  items: BreakdownItem[]
}

export type BreakdownKey = 'mcp' | 'skills' | 'memory' | 'agents'

export interface BreakdownSection {
  key: BreakdownKey
  name: string
  sub: string
  tokens: number
  /** The section's category colour. */
  slot: CategorySlot
  groups: BreakdownGroup[]
}

const byTokens = <T extends { tokens: number }>(a: T, b: T): number => b.tokens - a.tokens
const sum = (rows: readonly { tokens: number }[]): number => rows.reduce((total, row) => total + row.tokens, 0)

/** Rows grouped by a key, each group heaviest first, the groups heaviest first. */
function grouped<T extends { tokens: number }>(rows: readonly T[], keyOf: (row: T) => string): { key: string; rows: T[]; tokens: number }[] {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const key = keyOf(row)
    const list = groups.get(key)
    if (list) list.push(row)
    else groups.set(key, [row])
  }
  return [...groups]
    .map(([key, list]) => ({ key, rows: list.slice().sort(byTokens), tokens: sum(list) }))
    .sort(byTokens)
}

function withShares(groups: Omit<BreakdownGroup, 'share'>[]): BreakdownGroup[] {
  const max = Math.max(0, ...groups.map((g) => g.tokens))
  return groups.map((g) => ({ ...g, share: max > 0 ? g.tokens / max : 0 }))
}

/** The server an MCP tool belongs to: the report's, or the one its wire name carries. */
function serverOf(tool: { name: string; serverName: string }): string {
  return tool.serverName || /^mcp__(.+?)__/.exec(tool.name)?.[1] || 'other'
}

/** Where a skill came from: its plugin's name, or its source in words. */
function skillSourceOf(skill: { source: string; pluginName?: string }): string {
  return skill.pluginName ?? sourceLabel(skill.source)
}

/**
 * The breakdowns under the chart (canvas 70c/70d): MCP tools by server,
 * skills by plugin or source, memory files and custom agents as flat lists.
 * Every list heaviest first, the sections too; a section with no rows is
 * absent.
 */
export function breakdownSections(report: ContextReport): BreakdownSection[] {
  const sections: BreakdownSection[] = []

  if (report.mcpTools.length > 0) {
    const groups = grouped(report.mcpTools, serverOf)
    sections.push({
      key: 'mcp',
      name: 'MCP tools',
      sub: `${plural(report.mcpTools.length, 'tool', 'tools')} · ${plural(groups.length, 'server', 'servers')}`,
      tokens: sum(report.mcpTools),
      slot: 3,
      groups: withShares(
        groups.map((g) => ({
          lead: g.key,
          full: g.key,
          mono: true,
          tag: plural(g.rows.length, 'tool', 'tools'),
          tokens: g.tokens,
          // 70d: the server is the row above, so its prefix comes off.
          items: g.rows.map((t) => ({ name: t.name.replace(/^mcp__.+?__/, ''), tokens: t.tokens })),
        })),
      ),
    })
  }

  if (report.skills.length > 0) {
    const groups = grouped(report.skills, skillSourceOf)
    sections.push({
      key: 'skills',
      name: 'Skills',
      sub: `${plural(report.skills.length, 'skill', 'skills')} · ${plural(groups.length, 'source', 'sources')}`,
      tokens: sum(report.skills),
      slot: 6,
      groups: withShares(
        groups.map((g) => ({
          lead: g.key,
          full: g.key,
          mono: false,
          tag: plural(g.rows.length, 'skill', 'skills'),
          tokens: g.tokens,
          // A plugin's skill is named `plugin:skill`; the plugin is the row above.
          items: g.rows.map((s) => ({
            name: s.pluginName && s.name.startsWith(`${s.pluginName}:`) ? s.name.slice(s.pluginName.length + 1) : s.name,
            tokens: s.tokens,
          })),
        })),
      ),
    })
  }

  if (report.memoryFiles.length > 0) {
    sections.push({
      key: 'memory',
      name: 'Memory files',
      sub: plural(report.memoryFiles.length, 'file', 'files'),
      tokens: sum(report.memoryFiles),
      slot: 5,
      groups: withShares(
        report.memoryFiles
          .slice()
          .sort(byTokens)
          .map((f) => ({ lead: shortenMemoryPath(f.path), full: f.path, mono: true, tag: f.type, tokens: f.tokens, items: [] })),
      ),
    })
  }

  if (report.agents.length > 0) {
    sections.push({
      key: 'agents',
      name: 'Custom agents',
      sub: plural(report.agents.length, 'agent', 'agents'),
      tokens: sum(report.agents),
      slot: 4,
      groups: withShares(
        report.agents
          .slice()
          .sort(byTokens)
          .map((a) => ({
            lead: a.agentType,
            full: a.agentType,
            mono: true,
            tag: sourceLabel(a.source),
            tokens: a.tokens,
            items: [],
          })),
      ),
    })
  }

  return sections.sort(byTokens)
}

export interface UsedCategory {
  name: string
  tokens: number
  slot: CategorySlot
}

export interface ReserveRow {
  name: string
  tokens: number
  /** `buffer` is hatched, `free` an empty track; `other` is a kind this was not written for. */
  kind: 'buffer' | 'free' | 'other'
}

/** The fill and the chart (canvas 70c/70e). Fractions are of the window, 0–1. */
export interface ContextReportView {
  level: ContextLevel
  /** The used part of the window bar, clamped to the window. */
  fill: number
  /** More than the window holds: the fill reaches the end and adds 70e's notch. */
  spills: boolean
  /** The compaction reserve at the end of the window bar. */
  buffer: number
  /** The `used` rows with tokens, in the CLI's order: the second bar and the legend's left column. */
  used: UsedCategory[]
  /** Buffer, free space and unknown kinds, with tokens: the legend's right column, outside the chart. */
  reserve: ReserveRow[]
  /** Not in the window: listed for reference, never charted or counted. */
  deferred: { name: string; tokens: number }[]
  /** "4.5k past the compaction point", when the report is over its window. */
  overLine: string | null
  /** What the headline's figures are measured against. */
  windowNoun: string
}

const OVER_WORDS: Record<string, string> = {
  hard_limit: 'over the model’s limit',
  compaction_window: 'past the compaction point',
}

const WINDOW_NOUN: Record<string, string> = {
  hard_limit: 'tokens in the model window',
  compaction_window: 'tokens in the compaction window',
}

export function contextReportView(report: ContextReport, thresholds: ContextThresholds): ContextReportView {
  const window = report.rawMaxTokens
  const fraction = report.totalTokens / window
  const shown = report.categories.filter((c) => c.tokens > 0)
  const usedRows = shown.filter((c) => c.kind === 'used')
  const slots = categorySlots(usedRows.map((c) => c.name))
  const over = report.overLimit
  return {
    level: contextLevel(fraction, thresholds),
    fill: Math.min(1, Math.max(0, fraction)),
    spills: report.totalTokens > window,
    buffer: Math.min(1, sum(shown.filter((c) => c.kind === 'buffer')) / window),
    used: usedRows.map((c, i) => ({ name: c.name, tokens: c.tokens, slot: slots[i] })),
    reserve: shown
      .filter((c) => c.kind !== 'used' && c.kind !== 'deferred')
      .map((c) => ({ name: c.name, tokens: c.tokens, kind: c.kind === 'buffer' || c.kind === 'free' ? c.kind : 'other' })),
    deferred: shown.filter((c) => c.kind === 'deferred').map((c) => ({ name: c.name, tokens: c.tokens })),
    overLine: over ? `${formatReportTokens(over.tokensOver)} ${OVER_WORDS[over.kind] ?? 'over the window'}` : null,
    windowNoun: (over && WINDOW_NOUN[over.kind]) || 'tokens in the window',
  }
}

// ---- An opening's words (canvas `Feature - Context report from the read-out` 71c–71e)

/** The words an opening needs: its phase, where it came from and when it was taken. */
export interface OpeningWords {
  phase: 'loading' | 'ready' | 'failed'
  origin: 'row' | 'readout' | 'ended' | 'terminal'
  failure?: 'timeout' | 'failed' | 'asleep' | 'unreachable'
  /** `loading` only: a fresh count, which the words say; false while the kept report is only fetched. */
  counting?: boolean
}

/**
 * The header's line under the title (70c, 71c; 70f, 71e): when, or what is
 * happening. The Mac closes it with "a snapshot"; the phone passes `model`,
 * which stands there instead (null when nothing says which).
 */
export function openingMeta(o: OpeningWords, time: string | null, model?: string | null): string {
  const tail = model === undefined ? 'a snapshot' : model
  if (o.phase === 'loading') return o.counting ? 'taking a report now' : (tail ?? '')
  if (o.phase === 'failed') return 'no report taken'
  return [time ? `taken ${time}` : null, tail].filter(Boolean).join(' · ')
}

/**
 * The footer (70c, 71c, 71d): a typed `/context` points at running it again,
 * one from the read-out at opening it again; an ended or terminal session's
 * says it is the last one. `earlierTime` is the failed opening's earlier
 * report.
 */
export function openingFoot(o: OpeningWords, time: string | null, earlierTime: string | null = null): string {
  if (o.phase === 'loading') {
    return o.counting ? 'counting in the session · nothing is added to the transcript' : 'nothing is added to the transcript'
  }
  if (o.phase === 'failed') {
    return earlierTime ? `the last report for this session is from ${earlierTime}` : 'nothing is added to the transcript'
  }
  const at = time ?? '—'
  if (o.origin === 'ended') return `the session has ended · this is its last report, taken ${at}`
  if (o.origin === 'terminal') return `running in Terminal · this is the last /context typed there, at ${at}`
  const from = time ? `a snapshot from ${time}` : 'a snapshot'
  return `${from} · it doesn’t update · ${o.origin === 'row' ? 'run /context again' : 'open it again'} for a new one`
}

/**
 * Why no report was taken (71c, 71e). `timeoutSeconds` is the Mac's wait,
 * `CONTEXT_REPORT_TIMEOUT_MS`. The canvas words the timeout and the Mac
 * asleep; the session refusing and the Mac out of reach are worded the same
 * way.
 */
export function failureText(failure: OpeningWords['failure'], timeoutSeconds: number): string {
  if (failure === 'asleep') return 'The Mac is asleep, so the session can’t count now.'
  if (failure === 'unreachable') return 'Couldn’t take a report. The Mac didn’t answer.'
  if (failure === 'failed') return 'Couldn’t take a report. The session couldn’t count it.'
  return `Couldn’t take a report. The session didn’t answer within ${timeoutSeconds} seconds.`
}

/** The report a read-out preview stands for until the real one arrives: the figure and the window, nothing split. */
export function previewReport(preview: ReportPreview): ContextReport {
  return {
    model: preview.model,
    totalTokens: preview.used,
    rawMaxTokens: preview.window,
    percentage: Math.round((preview.used / preview.window) * 100),
    categories: [],
    mcpTools: [],
    memoryFiles: [],
    agents: [],
    skills: [],
  }
}
