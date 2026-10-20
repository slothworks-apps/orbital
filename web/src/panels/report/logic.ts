import { ApiError } from '../../lib/api'
import { ISSUE_REPO_URL } from '../../lib/issueReport'
import type { OrbitalModel } from '../../lib/types'

export type ReportKind = 'error' | 'broke' | 'idea'

/** Where the review is: the design component's `phase` (`Report Dialog`). */
export type ReportPhase = 'edit' | 'sending' | 'done' | 'error' | 'opened'

/** `gh` as the dialog last heard it; null until `GET /api/gh-status` answers. */
export type GhState = 'ready' | 'missing' | 'logged_out' | null

/** `owner/name`, as the PUBLIC line and the done foot name the repository. */
export const ISSUE_REPO_PATH = ISSUE_REPO_URL.replace(/^https:\/\/github\.com\//, '')

/**
 * How many issues the Claude check reads — the server's `MAX_LISTED_ISSUES`,
 * which the checking line names (canvas 61h). The two move together.
 */
export const CHECKED_ISSUES = 40

/** The similar-issues list shows at most this many (spec: "lists up to five"). */
export const MAX_SIMILAR = 5

/** The pause after the last keystroke in the title before it is searched. */
export const SIMILAR_DEBOUNCE_MS = 400

/** The setting that keeps the check's model for next time (canvas 61h: "kept for next time"). */
export const CHECK_MODEL_SETTING = 'issue_check_model'

/** The number at the end of an issue's address, or null for anything else. */
export function issueNumber(url: string | null | undefined): number | null {
  const match = url ? /\/issues\/(\d+)(?:[/?#]|$)/.exec(url) : null
  return match ? Number(match[1]) : null
}

/** 12 345 with a thin space between thousands, as the foot's char count is set. */
export function thinThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

/**
 * What `gh` said when it refused, verbatim. The server answers a refusal with
 * `{ error: <gh's output> }`, and `ApiError` carries the raw response body.
 */
export function refusalMessage(err: unknown): string {
  if (err instanceof ApiError) {
    try {
      const parsed = JSON.parse(err.message) as { error?: unknown }
      if (typeof parsed.error === 'string' && parsed.error) return parsed.error
    } catch {
      // Not JSON: the body itself is the message.
    }
    return err.message
  }
  return err instanceof Error ? err.message : String(err)
}

/** The foot line under the fields, and whether it is the bright ink of an outcome. */
export function footLine(args: {
  phase: ReportPhase
  gh: GhState
  kind: ReportKind
  length: number
  truncated: boolean
}): { text: string; bright: boolean } {
  const label = args.kind === 'idea' ? 'enhancement' : 'bug'
  if (args.phase === 'done') return { text: `Created on ${ISSUE_REPO_PATH} · labelled ${label}`, bright: true }
  if (args.phase === 'opened') {
    return {
      text: args.truncated ? 'Full record copied — paste it into Logs' : 'Opened in your browser — finish it there',
      bright: true,
    }
  }
  if (args.gh === null) return { text: '', bright: false }
  if (args.gh === 'ready') {
    return { text: `gh issue create · labelled ${label} · ${thinThousands(args.length)} chars`, bright: false }
  }
  return { text: 'With gh installed this would go straight from here', bright: false }
}

export interface CheckModel {
  value: string
  name: string
  desc: string
}

/** Canvas 61h's model menu, in its order and with its descriptions. */
const KNOWN_FAMILIES: [family: string, desc: string][] = [
  ['haiku', 'quick, light'],
  ['sonnet', 'balanced'],
  ['opus', 'deep, slow'],
  ['fable', 'frontier'],
]

/** When the catalog has not arrived: the aliases every account answers to. */
const FALLBACK: OrbitalModel[] = ['haiku', 'sonnet', 'opus'].map((value) => ({
  value,
  resolvedModel: value,
  family: value,
  version: value,
  shortVersion: value,
  variant: null,
  blurb: '',
  contextWindow: null,
}))

/**
 * The models the Claude check offers: one per family from the default
 * directory's catalog — the check runs under that account — without the
 * long-context variants a 40-issue read has no use for. Named by family, the
 * way the chip reads (`Haiku`).
 */
export function checkModels(catalog: readonly OrbitalModel[]): CheckModel[] {
  const source = catalog.length > 0 ? catalog : FALLBACK
  const seen = new Set<string>()
  const out: CheckModel[] = []
  for (const model of source) {
    if (model.variant) continue
    // The catalog's family carries its version (`Opus 5.5`); the chip names the family alone.
    const family = model.family.trim().split(/\s+/)[0].toLowerCase()
    if (seen.has(family)) continue
    seen.add(family)
    const known = KNOWN_FAMILIES.find(([f]) => f === family)
    out.push({
      value: model.value,
      name: family.charAt(0).toUpperCase() + family.slice(1),
      desc: known?.[1] ?? '',
    })
  }
  const rank = (m: CheckModel) => {
    const i = KNOWN_FAMILIES.findIndex(([f]) => f === m.name.toLowerCase())
    return i < 0 ? KNOWN_FAMILIES.length : i
  }
  return out.sort((a, b) => rank(a) - rank(b))
}

/** The kept pick when it is still offered, else Haiku (spec: "Haiku" by default), else the first. */
export function pickCheckModel(models: readonly CheckModel[], kept: string | undefined): CheckModel | undefined {
  return (
    models.find((m) => m.value === kept) ?? models.find((m) => m.name.toLowerCase() === 'haiku') ?? models[0]
  )
}
