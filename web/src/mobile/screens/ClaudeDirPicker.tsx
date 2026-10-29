import { useMemo, useState } from 'react'
import { claudeDirChoosable, claudeDirMonograms, claudeDirSubline } from '../../lib/claudeDirs'
import type { ClaudeDirName } from '../../lib/types'
import { ClaudeDirMark } from '../../ui/ClaudeDirMark'
import { FieldLabel, SheetPresence } from '../ui'

/**
 * The phone's Claude directory choice (canvas 44d): one 52px row under
 * DIRECTORY with the mark and the name, opening a bottom sheet of every
 * directory — mark, name, path and account, ✓ on the choice. A directory
 * missing on disk is shown at half strength and cannot be chosen.
 * Directories are managed on the Mac only, and the sheet says where.
 */
export function ClaudeDirPicker({
  dirs,
  value,
  hint,
  profilesSection,
  onChange,
}: {
  dirs: readonly ClaudeDirName[]
  value: number | null
  /** The label row's right-hand note: where the choice came from. */
  hint: string
  /** The Mac has Settings → Profiles (`MAC_FEATURES.profileLogin`); an older one keeps them elsewhere, so the sheet names no section. */
  profilesSection: boolean
  onChange: (id: number) => void
}) {
  const [open, setOpen] = useState(false)
  const monograms = useMemo(() => claudeDirMonograms(dirs), [dirs])
  const chosen = dirs.find((d) => d.id === value) ?? null

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <FieldLabel hint={hint}>PROFILE</FieldLabel>
        <button
          type="button"
          aria-haspopup="dialog"
          aria-label={chosen ? `Profile: ${chosen.name}` : 'Profile'}
          onClick={() => setOpen(true)}
          className="box-border flex min-h-[52px] w-full items-center gap-2.5 rounded-[14px] border border-line/14 bg-transparent py-1 pl-3.5 pr-2.5 text-left"
        >
          {chosen && <ClaudeDirMark mono={monograms.get(chosen.id) ?? '?'} size="phone" />}
          <span className="line-clamp-2 min-w-0 flex-1 fs-14.5 font-semibold text-ink-100">{chosen?.name ?? ''}</span>
          <span aria-hidden className="grid h-11 w-11 flex-none place-items-center fs-20 text-ink-900/60">
            ›
          </span>
        </button>
      </div>

      <SheetPresence>
        {open && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Run this session under"
            onClick={() => setOpen(false)}
            className="orbital-sheet-backdrop fixed inset-0 z-20 flex items-end bg-shade/60"
          >
            <div
              onClick={(event) => event.stopPropagation()}
              className="orbital-sheet-panel flex w-full flex-col rounded-t-[24px] border-t border-line/18 bg-[var(--color-panel-solid)] px-3 pb-[calc(28px+env(safe-area-inset-bottom))] pt-2"
            >
              <span aria-hidden className="mb-3 mt-0.5 block h-1 w-9 self-center rounded-[2px] bg-ink-500/30" />
              <div className="px-2 pb-2 font-mono fs-10 tracking-[0.16em] text-ink-900/60">
                RUN THIS SESSION UNDER
              </div>
              {dirs.map((dir) => {
                const on = dir.id === value
                const choosable = claudeDirChoosable(dir)
                return (
                  <button
                    key={dir.id}
                    type="button"
                    aria-pressed={on}
                    disabled={!choosable}
                    onClick={() => {
                      onChange(dir.id)
                      setOpen(false)
                    }}
                    className={[
                      'box-border flex min-h-[60px] w-full items-center gap-3 rounded-[12px] p-2.5 text-left disabled:opacity-50',
                      on ? 'bg-line/9' : 'bg-transparent',
                    ].join(' ')}
                  >
                    <ClaudeDirMark mono={monograms.get(dir.id) ?? '?'} size="sheet" />
                    <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                      <span className="line-clamp-2 fs-15 font-semibold text-ink-100">{dir.name}</span>
                      <span className="truncate font-mono fs-11 text-ink-900/60">{claudeDirSubline(dir)}</span>
                    </span>
                    <span
                      aria-hidden
                      className={['w-6 flex-none font-mono fs-13 text-accent', on ? 'opacity-100' : 'opacity-0'].join(' ')}
                    >
                      ✓
                    </span>
                  </button>
                )
              })}
              <div className="px-2 pt-2.5 font-mono fs-10 leading-[1.6] text-ink-900/50">
                {profilesSection ? 'add or rename profiles on the Mac · Settings → Profiles' : 'add or rename profiles on the Mac'}
              </div>
            </div>
          </div>
        )}
      </SheetPresence>
    </>
  )
}
