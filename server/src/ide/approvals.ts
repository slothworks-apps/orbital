import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { IdeStore } from './store.js';
import { CLOSE_TAB_TOOL, OPEN_DIFF_TOOL } from './protocol.js';
import {
  editTargetPath,
  inputForSavedContents,
  isDiffableTool,
  proposedContents,
} from './edits.js';

/**
 * The editor as a SECOND route to a parked decision's verdict — never the
 * only one (spec 2026-09-23-ide-bridge-design § Talking back to the editor,
 * adr `the-editor-is-a-second-route-to-one-verdict`).
 *
 * The Runner owns the decision; this is the narrow thing it asks. An
 * interface rather than the class so the Runner's tests can drive both
 * routes racing each other without an editor anywhere — which is the only
 * way the settle-exactly-once property can actually be exercised.
 */
export interface IdeApprovals {
  /**
   * Whether an editor covering `cwd` could review this ask as a diff. False
   * for everything: no editor, no `openDiff`, a tool whose input is not an
   * edit, a file outside the sandbox, a patch that does not apply.
   */
  offers(cwd: string, toolName: string, input: Record<string, unknown>): boolean;
  /**
   * Opens the diff and waits for the human. Resolves with the verdict they
   * gave in the editor, or **null for every kind of no-verdict** — no
   * editor, a refused call, a socket that went away, a tab closed without a
   * decision, or the wait being abandoned because the browser answered
   * first. Null must leave the decision exactly as it was.
   */
  review(req: IdeReviewRequest): Promise<IdeReviewVerdict | null>;
}

export interface IdeReviewRequest {
  cwd: string;
  toolName: string;
  input: Record<string, unknown>;
  /** The parked decision's id — what the tab is named after, so two sessions
   * reviewing one file do not fight over one tab. */
  decisionId: string;
  /** Abandons the review. Aborting also drops the tab. */
  signal: AbortSignal;
}

export type IdeReviewVerdict =
  | { approved: true; updatedInput?: Record<string, unknown> }
  | { approved: false; message: string };

/**
 * What the model reads back when the human rejected the diff. Plain, like
 * every other refusal: it has to be able to pick another route without
 * reading the refusal as an instruction.
 */
const REJECTED_MESSAGE = 'The user rejected this edit in the editor.';

/** How much of a decision id is enough to tell two review tabs apart. */
const TAB_ID_CHARS = 6;

/**
 * What the tab is called. The file is what the person is looking at, so it
 * comes first; the rest says who opened it and which ask it belongs to.
 * Stable for the life of one review, because `close_tab` names it.
 */
export function diffTabName(path: string, decisionId: string): string {
  return `${basename(path)} · Orbital (${decisionId.slice(-TAB_ID_CHARS)})`;
}

/** The file as it is now, or null when it is not there (or not readable). */
function readOriginal(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The live `IdeApprovals`, over the store that holds the connections.
 *
 * Every read here is best-effort by construction: the file is read off disk
 * rather than out of the editor's buffer, and a mismatch between the two only
 * ever shows the human a diff whose left side is stale — which they can see,
 * and which no decision is made from. The verdict is theirs either way.
 */
export function ideApprovals(ide: IdeStore): IdeApprovals {
  const prepare = (cwd: string, toolName: string, input: Record<string, unknown>) => {
    if (!isDiffableTool(toolName)) return null;
    const path = editTargetPath(toolName, input);
    if (path === null) return null;
    if (!ide.supports(cwd, OPEN_DIFF_TOOL)) return null;
    // Without `close_tab` an abandoned review would leave a tab behind that
    // nothing can drop, which is worse than not offering the route at all.
    if (!ide.supports(cwd, CLOSE_TAB_TOOL)) return null;
    const original = readOriginal(path);
    const contents = proposedContents(toolName, input, original);
    if (contents === null) return null;
    return { path, original, contents };
  };

  return {
    offers(cwd, toolName, input) {
      return prepare(cwd, toolName, input) !== null;
    },

    async review(req) {
      const prepared = prepare(req.cwd, req.toolName, req.input);
      if (!prepared) return null;
      const tabName = diffTabName(prepared.path, req.decisionId);
      const outcome = await ide.openDiff(
        req.cwd,
        {
          // The same path on both sides: this is one file being changed, not
          // a move, and naming it twice is what the extension expects.
          oldPath: prepared.path,
          newPath: prepared.path,
          contents: prepared.contents,
          tabName,
        },
        req.signal,
      );
      if (outcome === null) return null;
      // Closing the tab is not an answer. It says "not here" — so the
      // decision stays parked and the browser card goes on owning it.
      if (outcome.kind === 'closed') return null;
      if (outcome.kind === 'rejected') return { approved: false, message: REJECTED_MESSAGE };

      const saved = outcome.contents;
      // Saved unchanged — the common case, and exactly the browser's
      // approve: allow the tool, do not touch what it was asked to do.
      if (saved === null || saved === prepared.contents) return { approved: true };
      // Saved after a hand-edit. The agent's own tool still does the
      // writing, so the change lands in the transcript as the tool call it
      // was; `inputForSavedContents` is what makes it write those bytes.
      const updatedInput = inputForSavedContents(
        req.toolName,
        req.input,
        prepared.original,
        saved,
      );
      // No way to express the hand-edit as an input: approving would write
      // the version the human edited away from, so the ask is declined and
      // says why. The model re-reads the file and proposes again.
      if (!updatedInput) {
        return {
          approved: false,
          message: 'The user edited this change by hand in the editor. Re-read the file first.',
        };
      }
      return { approved: true, updatedInput };
    },
  };
}
