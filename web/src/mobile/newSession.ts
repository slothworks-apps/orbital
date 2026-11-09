import { ApiError } from '../lib/api'
import { promptWithFiles } from '../lib/attachedFiles'
import type { McpjsonDecisions } from '../lib/mcpjson'
import { modelByAnyId } from '../lib/models'
import { claudeDirPrefill, type ClaudeDirPrefillSource } from '../lib/claudeDirs'
import type { HarnessLaunch, HarnessProject, HarnessTemplate, OrbitalModel, PermissionMode, SessionDefaults } from '../lib/types'
import { gateCount, isOptional, missingInputs, plural, templateMeta } from '../panels/harness/templates'
import { macSupports } from './version'
import type { DirectoryRow } from '../lib/directorySearch'
import type { WorktreeLaunch } from '@orbital/shared/worktree'
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
  /** The WORKTREE group's choice (spec 2026-11-02-work-in-a-worktree-design § Launch); absent, the session starts in the directory. */
  worktree?: WorktreeLaunch
  /** The harness screen's template, inputs and Feeling lucky (spec 2026-11-09-harness-from-new-session-design § Phone); absent, a plain launch. */
  harness?: HarnessLaunch
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
    ...(input.worktree ? { worktree: input.worktree } : {}),
    ...(input.harness ? { harness: input.harness } : {}),
  }
}

/**
 * Whether New session offers *With harness…* (canvas 65d; spec
 * 2026-11-09-harness-from-new-session-design § Phone). The chosen device
 * must accept `harness` on launch: an older Mac would ignore the field and
 * start a plain session, so against one the button is not there at all.
 * Past that only a known off hides it — the settings read answered off and
 * came from the chosen device. A setting not known (the read refused or not
 * answered yet) or read from another device leaves the button, and the
 * template route answers `harness_disabled` on the harness screen instead.
 */
export function offersHarness(input: {
  /** The Harness switch as the settings read had it; null when not known. */
  harnessOn: boolean | null
  /** The settings read came from the device the session would run on. */
  readFromChosen: boolean
  /** The chosen device's Orbital version. */
  version: string | null
}): boolean {
  if (!macSupports('harnessLaunch', input.version)) return false
  return !(input.readFromChosen && input.harnessOn === false)
}

export { templateMeta }

/** The Steps row's count (canvas 65d): "5 steps", and how many of them wait for you. */
export function stepsSummary(t: HarnessTemplate): { steps: string; gates: string | null } {
  const g = gateCount(t)
  return { steps: plural(t.steps.length, 'step'), gates: g === 0 ? null : `${g} ${g === 1 ? 'waits' : 'wait'} for you` }
}

/** One line of the template sheet (canvas 65d): a group's caption, or a template. */
export type TemplateSheetLine =
  | { kind: 'caption'; label: string; scope: 'project' | 'global' }
  | { kind: 'row'; template: HarnessTemplate; meta: string }

/**
 * The template sheet's lines: this project's templates first, then the
 * global ones, each group under its caption, narrowed by the search on the
 * name. The template last run here says so.
 */
export function templateSheetLines(
  templates: readonly HarnessTemplate[],
  project: HarnessProject | null,
  lastUsedId: number | null,
  query: string,
): TemplateSheetLine[] {
  const q = query.trim().toLowerCase()
  const shown = templates.filter((t) => q === '' || t.name.toLowerCase().includes(q))
  const row = (t: HarnessTemplate): TemplateSheetLine => ({
    kind: 'row',
    template: t,
    meta: templateMeta(t) + (t.id === lastUsedId ? ' · last used here' : ''),
  })
  const own = shown.filter((t) => t.scope.kind === 'project')
  const global = shown.filter((t) => t.scope.kind === 'global')
  return [
    ...(own.length > 0
      ? [{ kind: 'caption', label: `${(project?.name ?? 'this project').toUpperCase()} · THIS PROJECT`, scope: 'project' } as const, ...own.map(row)]
      : []),
    ...(global.length > 0 ? [{ kind: 'caption', label: 'GLOBAL', scope: 'global' } as const, ...global.map(row)] : []),
  ]
}

/** Whether `input` must be filled before Start: required unless its hint says optional (the start view's rule). */
export function inputRequired(input: { hint?: string }): boolean {
  return !isOptional(input.hint)
}

/** "Task link" → "a task link"; an acronym keeps its capitals ("PR URL" → "a PR URL"). */
function withArticle(label: string): string {
  const trimmed = label.trim()
  const word = /^[A-Z][A-Z]/.test(trimmed) ? trimmed : trimmed.charAt(0).toLowerCase() + trimmed.slice(1)
  return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`
}

/**
 * Why the harness screen's Start cannot go yet, in the words its button
 * shows (canvas 65d START), or null when it can: no template offered, none
 * picked, or a required input still empty. Nothing else is said in red.
 */
export function harnessStartBlock(input: {
  templates: readonly HarnessTemplate[] | null
  template: HarnessTemplate | null
  inputs: Record<string, string>
}): string | null {
  if (input.templates !== null && input.templates.length === 0) return 'No template to start with'
  if (!input.template) return 'Pick a template to start'
  const [missing] = missingInputs(input.template, input.inputs)
  return missing ? `Add ${withArticle(missing.label)} to start` : null
}

/** What `harness` on the launch carries: the template's inputs only, trimmed, and Feeling lucky as the screen holds it. */
export function harnessLaunch(template: HarnessTemplate, inputs: Record<string, string>, lucky: boolean): HarnessLaunch {
  return {
    templateId: template.id,
    inputs: Object.fromEntries(template.inputs.map((i) => [i.key, (inputs[i.key] ?? '').trim()])),
    lucky,
  }
}
