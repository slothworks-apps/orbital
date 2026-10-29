import { BottomSheet, PrimaryButton } from '../ui'

/**
 * Start found the directory missing (spec
 * 2026-10-12-new-session-missing-directory-design § 2): create it and start,
 * or back to the form, which keeps every field. A sheet over the dimmed form
 * like the `.mcp.json` question; copy and layout provisional until the canvas
 * draws it.
 */
export function MissingDirectorySheet({
  path,
  project,
  macName,
  pending,
  onCreate,
  onBack,
}: {
  /** The path as the Mac reads it, `~` expanded. */
  path: string
  /** The project's folder name, for the eyebrow. */
  project: string
  macName: string
  pending: boolean
  onCreate: () => void
  onBack: () => void
}) {
  return (
    <BottomSheet label="Create this folder?" onDismiss={onBack} variant="question" swipeToDismiss>
      <div className="shrink-0 px-5 pb-3 pt-0.5">
        <div className="font-mono fs-10 tracking-[0.18em] text-accent/80">
          NEW SESSION · {project.toUpperCase()}
        </div>
        <h2 className="mt-1 fs-19 font-bold leading-[1.25] tracking-[-0.01em]">Create this folder?</h2>
      </div>
      <div className="flex flex-col gap-3.5 px-5 pb-3.5">
        <p className="break-all rounded-[14px] border border-line/12 bg-shade/45 px-3.5 py-3 font-mono fs-13 text-ink-100">
          {path}
        </p>
        <p className="fs-13.5 leading-[1.5] text-pretty text-ink-600/88">
          It doesn't exist on {macName} yet. Orbital can create it, with any missing folders above it, and start the
          session there.
        </p>
      </div>
      <div className="flex shrink-0 flex-col gap-0.5 border-t border-line/10 px-4 pt-2.5">
        <PrimaryButton disabled={pending} onClick={onCreate}>
          Create and start
        </PrimaryButton>
        <button
          type="button"
          onClick={onBack}
          className="h-11 w-full fs-14 font-semibold text-ink-500/80"
        >
          Back to the form
        </button>
      </div>
    </BottomSheet>
  )
}
