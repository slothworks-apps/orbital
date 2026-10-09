import { useState } from 'react'
import { api } from '../../lib/api'
import { reportError } from '../../lib/errors'
import { permissionMode } from '../../lib/permissionModes'
import { isReadOnly, type PermissionMode } from '../../lib/types'
import { ModeCards } from '../../ui/ModeCards'
import { ModeDot } from '../../ui/ModeDot'
import { SHEET_LABEL } from '../menu/TagSheet'
import { BottomSheet, SheetPresence } from '../ui'
import { patchSession } from './patchSession'
import type { SlotProps } from './slot'

/**
 * Header row 2, last: 9b's mode dot in its 28 px box, and the sheet of 9d's
 * four cards it opens (docs/superpowers/specs/2026-10-09-switch-model-and-mode-from-the-phone-design.md).
 * A pick applies at once, without asking, as on the Mac
 * (docs/decisions/a-permission-mode-switch-applies-at-once.md). A session the
 * terminal owns and a Mac asleep leave the plain dot.
 */
export function ModeSwitch({ session, offline }: SlotProps) {
  const [open, setOpen] = useState(false)
  const current = session.permissionMode
  if (!current) return null
  const label = permissionMode(current)?.label ?? current
  const box = (
    <span className="grid h-7 w-7 place-items-center rounded-[6px] border border-[rgba(150,205,255,.2)]">
      <ModeDot mode={current} size={8} />
    </span>
  )
  if (offline || isReadOnly(session)) {
    return (
      <span role="img" aria-label={`Permission mode ${label}`} className="mx-2 shrink-0">
        {box}
      </span>
    )
  }

  const choose = (mode: PermissionMode) => {
    setOpen(false)
    if (mode === current) return
    patchSession(session.id, { permissionMode: mode })
    api.setSessionPermissionMode(session.id, mode).catch((err) => {
      patchSession(session.id, { permissionMode: current })
      reportError(err, 'Failed to switch permission mode')
    })
  }

  return (
    <>
      {/* 9b: a 44 px square around the 28 px box. */}
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Change permission mode (currently ${label})`}
        onClick={() => setOpen(true)}
        className="grid h-11 w-11 shrink-0 place-items-center"
      >
        {box}
      </button>
      <SheetPresence>
        {open && (
          <BottomSheet label="Permission mode" onDismiss={() => setOpen(false)}>
            <div className={SHEET_LABEL}>PERMISSION MODE · APPLIES NOW</div>
            <div className="px-2">
              <ModeCards value={current} onChange={choose} touch />
            </div>
            <div className="h-4" />
          </BottomSheet>
        )}
      </SheetPresence>
    </>
  )
}
