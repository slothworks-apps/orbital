import { useEffect, useRef, useState } from 'react'
import { PrimaryButton, SecondaryButton } from '../ui'
import { canSaveTitle } from './sessionMenu'

/**
 * Rename, swapped into the ⋯ sheet (canvas 10j Rename; 10i shows it in
 * place): one field, prefilled and selected so typing replaces it, the hint
 * that only Orbital's label changes, Cancel and Save. Save is off for an
 * empty or unchanged title.
 */
export function RenameSheet({
  title,
  onSave,
  onCancel,
}: {
  title: string
  onSave: (next: string) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(title)
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [])
  const saveable = canSaveTitle(draft, title)

  // canvas 10j Rename: the panel's text sits 18 px in, the shell's 10 plus
  // this block's 8; 14 under the buttons before the keyboard.
  return (
    <form
      className="px-2 pb-3.5"
      onSubmit={(event) => {
        event.preventDefault()
        if (saveable) onSave(draft.trim())
      }}
    >
      <div className="font-mono text-[10px] tracking-[0.2em] text-[rgba(160,190,225,.6)]">RENAME</div>
      <input
        ref={field}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        aria-label="Session title"
        enterKeyHint="done"
        className="mt-2.5 box-border h-13 w-full rounded-[14px] border border-[oklch(85%_.12_205/.5)] bg-[rgba(4,8,16,.6)] px-3.5 text-[15px] text-text-bright shadow-[0_0_0_3px_oklch(85%_.12_205/.1)] outline-none"
      />
      <div className="mt-2 font-mono text-[10px] text-[rgba(160,190,225,.55)]">
        only Orbital&apos;s label · the folder and branch don&apos;t change
      </div>
      <div className="mt-3.5 flex gap-2">
        <div className="flex-1">
          <SecondaryButton variant="sheet" onClick={onCancel}>Cancel</SecondaryButton>
        </div>
        <div className="flex-1">
          <PrimaryButton variant="sheet" type="submit" disabled={!saveable}>Save</PrimaryButton>
        </div>
      </div>
    </form>
  )
}
