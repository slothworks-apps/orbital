/**
 * What an edit tool is about to do to a file, and how to say the same thing
 * back in that tool's own vocabulary (spec 2026-09-23-ide-bridge-design
 * § Talking back to the editor).
 *
 * `openDiff` shows a human two versions of a file and hands back the one they
 * settled on. Neither half of that is something the SDK gives us: the
 * `canUseTool` callback carries the tool's INPUT — a patch, for `Edit` — not
 * the file it would produce, and an approval may only travel back as an
 * input, never as bytes Orbital writes itself.
 *
 * So both directions are arithmetic over the tool's input, and all of it is
 * pure: the file is read by the caller and handed in.
 */

/** One `Edit`'s replacement, which `MultiEdit` carries a list of. */
interface EditOp {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/**
 * The tools whose edit Orbital can render as a diff.
 *
 * Deliberately a list rather than a guess. Every member here has an input
 * that both *determines* the resulting file and can be rewritten to produce
 * any other file — which is exactly the pair of properties the round trip
 * needs, and is why there is no "some other tool" branch to worry about.
 */
const WRITE_TOOL = 'Write';
const EDIT_TOOL = 'Edit';
const MULTI_EDIT_TOOL = 'MultiEdit';

export const DIFFABLE_TOOLS: readonly string[] = [WRITE_TOOL, EDIT_TOOL, MULTI_EDIT_TOOL];

/** Whether this tool's ask is one the editor could review as a diff. */
export function isDiffableTool(toolName: string): boolean {
  return DIFFABLE_TOOLS.includes(toolName);
}

function stringField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The absolute path an edit tool names, or null when it names none. */
export function editTargetPath(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  if (!isDiffableTool(toolName)) return null;
  return stringField(input, 'file_path');
}

function editOpsOf(input: Record<string, unknown>): EditOp[] | null {
  const raw = input.edits;
  if (!Array.isArray(raw)) return null;
  const ops: EditOp[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const op = entry as Record<string, unknown>;
    if (typeof op.old_string !== 'string' || typeof op.new_string !== 'string') return null;
    ops.push({
      old_string: op.old_string,
      new_string: op.new_string,
      replace_all: op.replace_all === true,
    });
  }
  return ops;
}

/**
 * Applies one replacement the way the CLI's `Edit` does, or null when it
 * would not apply: a string that is not there, or an ambiguous one that
 * `replace_all` was not asked for. Returning null rather than guessing is
 * what keeps the diff from showing a change the tool will not make.
 */
function applyOp(content: string, op: EditOp): string | null {
  const first = content.indexOf(op.old_string);
  if (first === -1) return null;
  if (op.replace_all) return content.split(op.old_string).join(op.new_string);
  if (content.indexOf(op.old_string, first + op.old_string.length) !== -1) return null;
  return content.slice(0, first) + op.new_string + content.slice(first + op.old_string.length);
}

/**
 * The file as this tool would leave it, or null when that cannot be worked
 * out — an unreadable input, or a patch that does not apply to what is on
 * disk. Null means "no diff to show", never "show an empty one".
 *
 * `original` is null for a file that is not there yet, which only `Write`
 * can be asked about.
 */
export function proposedContents(
  toolName: string,
  input: Record<string, unknown>,
  original: string | null,
): string | null {
  if (toolName === WRITE_TOOL) {
    const content = input.content;
    return typeof content === 'string' ? content : null;
  }
  if (original === null) return null;
  if (toolName === EDIT_TOOL) {
    const oldString = input.old_string;
    const newString = input.new_string;
    if (typeof oldString !== 'string' || typeof newString !== 'string') return null;
    return applyOp(original, {
      old_string: oldString,
      new_string: newString,
      replace_all: input.replace_all === true,
    });
  }
  if (toolName === MULTI_EDIT_TOOL) {
    const ops = editOpsOf(input);
    if (!ops || ops.length === 0) return null;
    let content = original;
    for (const op of ops) {
      const next = applyOp(content, op);
      if (next === null) return null;
      content = next;
    }
    return content;
  }
  return null;
}

/**
 * The tool's input rewritten so that running it produces exactly `saved` —
 * the file as the human left the diff tab, which need not be what Orbital
 * proposed.
 *
 * This is the whole reason a hand-edit in the editor is not silently
 * discarded. The agent's own tool still does the writing, so the edit lands
 * in the transcript as the tool call it was, rather than as bytes that
 * appeared from nowhere.
 *
 * The patch tools are rewritten to a single whole-file replacement:
 * `old_string` is the entire original, which occurs exactly once in it, so
 * the replacement is unambiguous by construction. Null when there is nothing
 * to key the replacement on — an empty original for a patch tool.
 *
 * Safe under either answer to the one thing about `openDiff` that is not
 * measured, namely whether the extension writes the file itself on save: if
 * it did, the rewritten `old_string` no longer matches and the tool errors
 * with the file already correct; if it did not, the tool writes `saved`.
 * Neither branch produces a file that is wrong.
 */
export function inputForSavedContents(
  toolName: string,
  input: Record<string, unknown>,
  original: string | null,
  saved: string,
): Record<string, unknown> | null {
  if (toolName === WRITE_TOOL) return { ...input, content: saved };
  if (original === null || original === '') return null;
  const filePath = stringField(input, 'file_path');
  if (filePath === null) return null;
  if (toolName === EDIT_TOOL) {
    return { file_path: filePath, old_string: original, new_string: saved, replace_all: false };
  }
  if (toolName === MULTI_EDIT_TOOL) {
    return { file_path: filePath, edits: [{ old_string: original, new_string: saved }] };
  }
  return null;
}
