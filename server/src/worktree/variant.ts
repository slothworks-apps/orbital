/**
 * Which removal a worktree is offered, from its state (spec
 * 2026-11-02-work-in-a-worktree-design § Removing the worktree). Pure.
 */

/**
 * `c1` nothing local would be lost; `c2a` uncommitted files; `c2b` unpushed
 * commits on a clean tree; `c3` another live session works in the tree.
 */
export type WorktreeVariant = 'c1' | 'c2a' | 'c2b' | 'c3';

export interface WorktreeChoiceInput {
  uncommittedFiles: number;
  unpushedCommits: number;
  /** Other live sessions in the tree. */
  sharedWith: readonly string[];
  /** The session's status is `ended`. */
  ended: boolean;
  /** Orbital holds the session (not a terminal CLI), so Orbital can end it. */
  orbital: boolean;
}

export interface WorktreeChoice {
  variant: WorktreeVariant;
  /** Whether removal can be offered at all. */
  removable: boolean;
  /** Removing has to end the session first: the UI says "End and remove". */
  endsSession: boolean;
}

export function worktreeChoice(input: WorktreeChoiceInput): WorktreeChoice {
  const variant: WorktreeVariant = input.sharedWith.length > 0
    ? 'c3'
    : input.uncommittedFiles > 0
      ? 'c2a'
      : input.unpushedCommits > 0
        ? 'c2b'
        : 'c1';
  // A terminal session still running cannot be stopped from here, and its
  // next turn would land in a deleted directory.
  const removable = variant !== 'c3' && (input.ended || input.orbital);
  return { variant, removable, endsSession: removable && !input.ended };
}
