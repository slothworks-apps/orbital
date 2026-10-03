import { ApiError } from '../lib/api'
import { modelByAnyId } from '../lib/models'
import type { OrbitalModel, PermissionMode, SessionDefaults } from '../lib/types'
import { humanizeError } from './composer'

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
 * contains the query, or whose full path starts with it — case-insensitive,
 * in the order the route gave (most recent first).
 */
export function filterDirectories(projects: readonly DirectoryRow[], query: string): DirectoryList {
  const q = query.trim()
  if (!q) return { kind: 'rows', rows: projects.slice(0, RECENT_DIRECTORIES) }
  const needle = q.toLowerCase()
  const rows = projects.filter((p) => {
    const cwd = p.cwd.toLowerCase()
    return cwd.startsWith(needle) || cwd.split('/').some((segment) => segment.includes(needle))
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

/** The Mac's default mode, except that a mode that never asks is never preselected (the desktop's rule). */
export function preselectMode(defaults: SessionDefaults): PermissionMode {
  return defaults.permissionMode === 'bypassPermissions' ? 'acceptEdits' : defaults.permissionMode
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
