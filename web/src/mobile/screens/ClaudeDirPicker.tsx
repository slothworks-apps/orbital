import { useMemo, useState } from 'react'
import { claudeDirChoosable, claudeDirMonograms, claudeDirSubline } from '../../lib/claudeDirs'
import type { ClaudeDirName } from '../../lib/types'
import { ClaudeDirMark } from '../../ui/ClaudeDirMark'
import { FieldLabel } from '../ui'

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
  onChange,
}: {
  dirs: readonly ClaudeDirName[]
  value: number | null
  /** The label row's right-hand note: where the choice came from. */
  hint: string
  onChange: (id: number) => void
}) {
  const [open, setOpen] = useState(false)
  const monograms = useMemo(() => claudeDirMonograms(dirs), [dirs])
  const chosen = dirs.find((d) => d.id === value) ?? null

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <FieldLabel hint={hint}>CLAUDE DIRECTORY</FieldLabel>
        <button
          type="button"
          aria-haspopup="dialog"
          aria-label={chosen ? `Claude directory: ${chosen.name}` : 'Claude directory'}
          onClick={() => setOpen(true)}
          className="box-border flex min-h-[52px] w-full items-center gap-2.5 rounded-[14px] border border-[rgba(150,205,255,.14)] bg-transparent py-1 pl-3.5 pr-2.5 text-left"
        >
          {chosen && <ClaudeDirMark mono={monograms.get(chosen.id) ?? '?'} size="phone" />}
          <span className="line-clamp-2 min-w-0 flex-1 text-[14.5px] font-semibold text-text-bright">{chosen?.name ?? ''}</span>
          <span aria-hidden className="grid h-11 w-11 flex-none place-items-center text-[20px] text-[rgba(160,190,225,.6)]">
            ›
          </span>
        </button>
      </div>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Run this session under"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-20 flex items-end bg-[rgba(2,4,9,.6)]"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="flex w-full flex-col rounded-t-[24px] border-t border-[rgba(150,205,255,.18)] bg-[oklch(15%_.02_258)] px-3 pb-[calc(28px+env(safe-area-inset-bottom))] pt-2"
          >
            <span aria-hidden className="mb-3 mt-0.5 block h-1 w-9 self-center rounded-[2px] bg-[rgba(200,220,245,.3)]" />
            <div className="px-2 pb-2 font-mono text-[10px] tracking-[0.16em] text-[rgba(160,190,225,.6)]">
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
                    on ? 'bg-[rgba(150,205,255,.09)]' : 'bg-transparent',
                  ].join(' ')}
                >
                  <ClaudeDirMark mono={monograms.get(dir.id) ?? '?'} size="sheet" />
                  <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                    <span className="line-clamp-2 text-[15px] font-semibold text-text-bright">{dir.name}</span>
                    <span className="truncate font-mono text-[11px] text-[rgba(160,190,225,.6)]">{claudeDirSubline(dir)}</span>
                  </span>
                  <span
                    aria-hidden
                    className={['w-6 flex-none font-mono text-[13px] text-accent', on ? 'opacity-100' : 'opacity-0'].join(' ')}
                  >
                    ✓
                  </span>
                </button>
              )
            })}
            <div className="px-2 pt-2.5 font-mono text-[10px] leading-[1.6] text-[rgba(160,190,225,.5)]">
              add or rename directories on the Mac · Settings → General
            </div>
          </div>
        </div>
      )}
    </>
  )
}
