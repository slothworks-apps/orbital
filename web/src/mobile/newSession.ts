import { ApiError } from '../lib/api'
import { modelByAnyId } from '../lib/models'
import { claudeDirPrefill, type ClaudeDirPrefillSource } from '../lib/claudeDirs'
import type { OrbitalModel, PermissionMode, SessionDefaults, Tag } from '../lib/types'
import { effectiveLaunchDefaults, type LaunchClaudeDirSource } from '@orbital/shared/launchDefaults'
import { humanizeError } from './composer'
import { homePath } from './format'

/** One row of `GET /api/projects`: a directory a session ran in. */
export interface DirectoryRow {
  cwd: string
  lastModel: string | null
  lastAt: number | null
}

/** How many directories 9d lists before anything is typed. */
export const RECENT_DIRECTORIES = 10

/** What the list under 9d's directory field shows. */
export type DirectoryList =
  /** Matches, most recent first (the input's order). */
  | { kind: 'rows'; rows: DirectoryRow[] }
  /** A typed `~/` or `/` path that matches nothing: offered as is. */
  | { kind: 'use-as-is'; path: string }
  /** Other text that matches nothing. */
  | { kind: 'no-match'; query: string }

/** The field holds a path of its own, not a search: it starts at `~/` or `/`. */
export function isTypedPath(query: string): boolean {
  const q = query.trim()
  return q.startsWith('~/') || q.startsWith('/')
}

/**
 * 9d's directory list (spec § 6.4). Nothing typed: the first
 * `RECENT_DIRECTORIES` rows. Otherwise every row with a path segment that
 * contains the query, or whose full path starts with it — written out or
 * from `~`, as the rows print it — case-insensitive,
 * in the order the route gave (most recent first).
 */
export function filterDirectories(projects: readonly DirectoryRow[], query: string): DirectoryList {
  const q = query.trim()
  if (!q) return { kind: 'rows', rows: projects.slice(0, RECENT_DIRECTORIES) }
  const needle = q.toLowerCase()
  const rows = projects.filter((p) => {
    const cwd = p.cwd.toLowerCase()
    return (
      cwd.startsWith(needle) ||
      homePath(p.cwd).toLowerCase().startsWith(needle) ||
      cwd.split('/').some((segment) => segment.includes(needle))
    )
  })
  if (rows.length > 0) return { kind: 'rows', rows }
  return isTypedPath(q) ? { kind: 'use-as-is', path: q } : { kind: 'no-match', query: q }
}

/**
 * The model 9d opens on: the directory's last model when the Mac remembers
 * one per project, else the Mac's default, else the catalog's first row.
 * Either may name a model the catalog no longer has; the phone has no
 * "Other…" card, so such an id falls through to the next choice.
 */
export function preselectModel(input: {
  defaults: SessionDefaults
  project: DirectoryRow | undefined
  models: OrbitalModel[]
}): string | null {
  const { defaults, project, models } = input
  const remembered = defaults.rememberModelPerProject ? modelByAnyId(project?.lastModel, models) : undefined
  return (remembered ?? modelByAnyId(defaults.model, models))?.value ?? models[0]?.value ?? null
}

/**
 * The Claude directory 9d opens on (spec
 * 2026-10-04-multiple-claude-directories-design § 7): the desktop's order
 * without its planet step, since the phone opens New session from the list,
 * never from a session — the last launch's choice, else the Mac's default. A
 * removed directory, or one missing on disk, falls through. With the step
 * that chose it, for the hint beside the row (canvas 44d: "last launch",
 * "default"). Null from a Mac without directories.
 */
export function prefillClaudeDir(defaults: SessionDefaults): { id: number; from: ClaudeDirPrefillSource } | null {
  return claudeDirPrefill({
    dirs: defaults.claudeDirs ?? [],
    planet: null,
    last: defaults.lastClaudeDir,
    fallback: defaults.defaultClaudeDir,
  })
}

/** `prefillClaudeDir`'s directory alone. */
export function preselectClaudeDir(defaults: SessionDefaults): number | null {
  return prefillClaudeDir(defaults)?.id ?? null
}

/** The Mac's default mode, except that a mode that never asks is never preselected (the desktop's rule). */
export function preselectMode(defaults: SessionDefaults): PermissionMode {
  return defaults.permissionMode === 'bypassPermissions' ? 'acceptEdits' : defaults.permissionMode
}

/**
 * Whether any tag carries a launch default, so 9d asks the Mac which tag a
 * directory's rules give. A Mac from before tag defaults sends none of the
 * fields, so nothing is asked of it and nothing is preselected.
 */
export function tagsCarryDefaults(tags: readonly Tag[]): boolean {
  return tags.some((t) => t.claude_dir_id != null || t.model != null || t.permission_mode != null)
}

/**
 * What 9d preselects for the tag the session will wear (spec
 * 2026-10-13-tag-defaults-design): the tag's directory (the default's when
 * its own has its limit used up), model and mode over the screen's own
 * prefill. A tag model the catalog does not list falls through to `model`,
 * as the phone has no "Other…" card, and a mode that never asks is never
 * preselected, the Mac's default's rule.
 */
export function tagPreselection(input: {
  tag: Tag | undefined
  defaults: SessionDefaults
  /** The screen's prefill without a tag: `prefillClaudeDir`, `preselectModel`, `preselectMode`. */
  base: { claudeDirId: number | null; model: string | null; mode: PermissionMode }
  models: OrbitalModel[]
}): { claudeDirId: number | null; claudeDirFrom: LaunchClaudeDirSource; model: string | null; mode: PermissionMode } {
  const { tag, defaults, base, models } = input
  const preset = effectiveLaunchDefaults({
    tag: tag ? { ...tag, model: modelByAnyId(tag.model, models)?.value ?? null } : undefined,
    global: { claudeDirId: base.claudeDirId, model: base.model, permissionMode: base.mode },
    defaultClaudeDirId: defaults.defaultClaudeDir ?? null,
    claudeDirs: defaults.claudeDirs ?? [],
  })
  return {
    claudeDirId: preset.claudeDirId,
    claudeDirFrom: preset.claudeDirFrom,
    model: preset.model,
    mode: preset.permissionMode === 'bypassPermissions' ? base.mode : preset.permissionMode,
  }
}

/**
 * The line under 9d's Start for any refusal but a missing directory (that one
 * has its own line under the field). Copy provisional until the canvas words it.
 */
export function startFailureLine(err: unknown, macName: string | null): string {
  const message =
    err instanceof ApiError ? err.message || `HTTP ${err.status}` : err instanceof Error ? err.message : String(err)
  const reason = humanizeError(message, macName).replace(/[.\s]+$/, '')
  return `Couldn't start the session — ${reason}.`
}

/**
 * `POST /api/sessions` refused the directory (`requireDirectory`): a 400
 * whose body is `{ error: 'no_such_directory' }`. The body is parsed, not
 * searched — `ApiError`'s message is the response text.
 */
export function noSuchDirectory(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 400) return false
  try {
    const body: unknown = JSON.parse(err.message)
    return typeof body === 'object' && body !== null && (body as { error?: unknown }).error === 'no_such_directory'
  } catch {
    return false
  }
}
