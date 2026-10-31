import { ApiError } from '../lib/api'
import { promptWithFiles } from '../lib/attachedFiles'
import type { McpjsonDecisions } from '../lib/mcpjson'
import { modelByAnyId } from '../lib/models'
import { claudeDirPrefill, type ClaudeDirPrefillSource } from '../lib/claudeDirs'
import type { OrbitalModel, PermissionMode, SessionDefaults } from '../lib/types'
import type { DirectoryRow } from '../lib/directorySearch'
import { humanizeError } from './composer'

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

/** What Start sends (`launchSession`'s body), from what the form holds. */
export interface LaunchInput {
  cwd: string
  prompt: string
  /** Paths of the attached files that landed, which the prompt names. */
  files: string[]
  mode: PermissionMode
  model: string | null
  /** Only when the choice was offered; the device remembers it for the next prefill. */
  claudeDirId: number | null
  /** Refs of the attached images that landed. */
  refs: string[]
  mcpjson?: McpjsonDecisions
  /** The device chosen in DEVICE (canvas 50j); null before any device is known, which leaves it to the default. */
  machine: string | null
}

/**
 * The body of `POST /api/sessions` from the phone: the directory checked
 * first (`requireDirectory`), and `machine` naming the device it runs on —
 * the federation routes by it and strips it before the device sees it, so a
 * device from before groups gets the body it always did.
 */
export function launchRequest(input: LaunchInput) {
  return {
    cwd: input.cwd.trim(),
    prompt: promptWithFiles(input.prompt, input.files),
    permissionMode: input.mode,
    model: input.model ?? undefined,
    requireDirectory: true,
    ...(input.claudeDirId !== null ? { claudeDirId: input.claudeDirId } : {}),
    ...(input.refs.length > 0 ? { attachments: input.refs } : {}),
    ...(input.mcpjson ? { mcpjson: input.mcpjson } : {}),
    ...(input.machine !== null ? { machine: input.machine } : {}),
  }
}
