import { diffLines, splitLines, type LineDiff } from './diff'

/**
 * What an editing tool call changed, as far as Orbital can honestly tell
 * (spec: 2026-09-23-edit-diffs-in-the-transcript).
 *
 * The SDK's editing tools are `Edit`, `Write` and `NotebookEdit`
 * (`FileEditInput`, `FileWriteInput`, `NotebookEditInput` in
 * `@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`; there is no multi-edit
 * form in the current SDK, and `MultiEdit` is gone). Only `Edit` carries both
 * sides of its change in its input. The others carry the new text and nothing
 * else, and the tool *result*'s structured payload — which does carry
 * `originalFile` and a `structuredPatch` — never reaches the browser: the
 * transcript parser keeps a `tool_result`'s text blocks and drops the rest
 * (`server/src/transcript/parser.ts`). So a `Write` is shown as content, not
 * as a diff, and the UI says which.
 */
export type FileChange =
  /** Both sides known — a real diff. */
  | { kind: 'edit'; path: string; diff: LineDiff; replaceAll: boolean }
  /** New text known, previous text known only by absence. */
  | { kind: 'write'; path: string; content: string; outcome: WriteOutcome }
  | { kind: 'notebook'; path: string; source: string; mode: NotebookMode; cellId: string | null }

/**
 * Whether a `Write` landed on a file that did not exist. The only signal the
 * browser has is the tool result's sentence, so an unrecognised or missing
 * result is `unknown` — never guessed at.
 */
export type WriteOutcome = 'created' | 'replaced' | 'unknown'

export type NotebookMode = 'replace' | 'insert' | 'delete'

/** Tools whose call is a change to a file rather than a look at one. */
export const EDITING_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

/** The `Write` tool's two result sentences, as the CLI writes them. */
const WRITE_CREATED = /^File created successfully at:/
const WRITE_REPLACED = /has been updated/

/**
 * Reads a `Write`'s outcome off its result text. Deliberately narrow: two
 * shapes recognised, everything else (a running call, an error, a future
 * rewording) is `unknown`, which the UI states rather than papers over.
 */
export function writeOutcome(resultText: string | undefined, isError?: boolean): WriteOutcome {
  if (isError || resultText === undefined) return 'unknown'
  const text = resultText.trimStart()
  if (WRITE_CREATED.test(text)) return 'created'
  if (WRITE_REPLACED.test(text)) return 'replaced'
  return 'unknown'
}

/**
 * Diffs computed for a tool input, keyed on the input object itself. The
 * store hands the same object to every render of a row, so a transcript that
 * re-renders — which it does on every websocket message — pays for each edit
 * once rather than once per frame. Weak so a session's transcript can be
 * dropped from the store without the cache holding it.
 */
const diffCache = new WeakMap<object, LineDiff>()

function cachedDiff(key: object, before: string, after: string): LineDiff {
  const hit = diffCache.get(key)
  if (hit) return hit
  const computed = diffLines(before, after)
  diffCache.set(key, computed)
  return computed
}

function stringField(input: Record<string, unknown>, field: string): string | null {
  const value = input[field]
  return typeof value === 'string' ? value : null
}

/**
 * The change a tool row should render, or null when the call is not an edit
 * (or its input is not the shape the tool declares — a malformed call falls
 * back to the raw INPUT JSON rather than to a half-drawn diff).
 */
export function describeFileChange(
  toolName: string | undefined,
  toolInput: unknown,
  resultText: string | undefined,
  isError?: boolean,
): FileChange | null {
  if (!toolName || !EDITING_TOOLS.has(toolName)) return null
  if (!toolInput || typeof toolInput !== 'object') return null
  const input = toolInput as Record<string, unknown>

  if (toolName === 'Edit') {
    const path = stringField(input, 'file_path')
    const before = stringField(input, 'old_string')
    const after = stringField(input, 'new_string')
    if (path === null || before === null || after === null) return null
    return {
      kind: 'edit',
      path,
      diff: cachedDiff(input, before, after),
      replaceAll: input.replace_all === true,
    }
  }

  if (toolName === 'Write') {
    const path = stringField(input, 'file_path')
    const content = stringField(input, 'content')
    if (path === null || content === null) return null
    return { kind: 'write', path, content, outcome: writeOutcome(resultText, isError) }
  }

  const path = stringField(input, 'notebook_path')
  if (path === null) return null
  const mode = input.edit_mode
  return {
    kind: 'notebook',
    path,
    // `new_source` is required by the schema, but a delete has nothing to show.
    source: stringField(input, 'new_source') ?? '',
    mode: mode === 'insert' || mode === 'delete' ? mode : 'replace',
    cellId: stringField(input, 'cell_id'),
  }
}

/**
 * The `+n −m` a collapsed row can carry, or null when the change has no
 * countable two sides. A `Write` over an existing file has exactly one side
 * Orbital knows, and putting a removal count on it would be inventing the
 * other; a `Write` that created the file is the case where the missing side
 * is genuinely empty, so all of it counts as added.
 */
export function changeCounts(change: FileChange): { added: number; removed: number } | null {
  if (change.kind === 'edit') return { added: change.diff.added, removed: change.diff.removed }
  if (change.kind === 'write' && change.outcome === 'created') {
    return { added: splitLines(change.content).length, removed: 0 }
  }
  return null
}
