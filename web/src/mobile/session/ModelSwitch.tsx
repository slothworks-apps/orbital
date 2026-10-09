import { useState } from 'react'
import { api } from '../../lib/api'
import { reportError } from '../../lib/errors'
import { matchModel, modelChipLabel, modelSwitchCost, sessionModelLabel } from '../../lib/models'
import { isReadOnly, type ApiSession, type OrbitalModel } from '../../lib/types'
import { useClaudeDirModels } from '../../lib/useClaudeDirModels'
import { SHEET_LABEL } from '../menu/TagSheet'
import { BottomSheet, ConfirmBody, SheetPresence } from '../ui'
import { patchSession } from './patchSession'
import type { SlotProps } from './slot'

/**
 * Header row 2, after the spacer: 9b's model chip ("Sonnet ▾") and the sheet
 * it opens (docs/superpowers/specs/2026-10-09-switch-model-and-mode-from-the-phone-design.md).
 * A pick asks first, as on the Mac (docs/decisions/a-model-switch-always-asks.md),
 * and applies from the next turn. A session the terminal owns, a Mac asleep
 * and an empty catalog leave the plain label, without its caret.
 */
export function ModelSwitch({ session, offline }: SlotProps) {
  const [open, setOpen] = useState(false)
  // What the switch offers is the session's own account's catalog, as on the Mac.
  const models = useClaudeDirModels(session.claudeDirId)
  if (!session.model && !session.resolvedModel && models.length === 0) return null
  const label = sessionModelLabel(session, models)
  const switchable = !offline && !isReadOnly(session) && models.length > 0

  const chip = (
    <span className="flex h-7 min-w-0 items-center gap-1.5 rounded-[6px] border border-[rgba(150,205,255,.2)] px-[9px] font-mono text-[11px] text-text-bright">
      <span className="truncate">{label}</span>
      {switchable && <span aria-hidden className="text-[8px] text-[rgba(160,190,225,.6)]">▾</span>}
    </span>
  )
  if (!switchable) return <span className="mx-1.5 flex min-w-0">{chip}</span>

  return (
    <>
      {/* 9b: a 44 px tall target around the 28 px chip. */}
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Change model (currently ${label})`}
        onClick={() => setOpen(true)}
        className="flex h-11 min-w-0 items-center px-1.5"
      >
        {chip}
      </button>
      <SheetPresence>
        {open && <ModelSheet session={session} models={models} onClose={() => setOpen(false)} />}
      </SheetPresence>
    </>
  )
}

function ModelSheet({ session, models, onClose }: { session: ApiSession; models: OrbitalModel[]; onClose: () => void }) {
  /** The model a pick is waiting on the confirm for. */
  const [pending, setPending] = useState<OrbitalModel | null>(null)
  const current = matchModel(session, models)

  const choose = (model: OrbitalModel) => {
    if (model.value === current?.value) onClose()
    else setPending(model)
  }

  // The desktop switcher's `apply`: the store first, the old model back if the switch fails.
  const apply = (model: OrbitalModel) => {
    onClose()
    const previous = session.model
    patchSession(session.id, { model: model.value })
    api.setSessionModel(session.id, model.value).catch((err) => {
      patchSession(session.id, { model: previous })
      reportError(err, 'Failed to switch model')
    })
  }

  return (
    <BottomSheet label={pending ? `Switch to ${modelChipLabel(pending)}?` : 'Model'} onDismiss={onClose}>
      {pending ? (
        <ConfirmBody
          eyebrow="MODEL SWITCH"
          title={`Switch to ${modelChipLabel(pending)}?`}
          body={modelSwitchCost(modelChipLabel(pending), session.contextUsedTokens)}
          confirmLabel="Switch"
          onConfirm={() => apply(pending)}
          onCancel={() => setPending(null)}
        />
      ) : (
        <>
          <div className={SHEET_LABEL}>MODEL · APPLIES FROM NEXT TURN</div>
          {/* The SDK's catalog runs long; on a short screen the list scrolls under the label. */}
          <div role="listbox" aria-label="Model" className="max-h-[60dvh] overflow-y-auto overscroll-contain">
            {models.map((model) => {
              const selected = model.value === current?.value
              return (
                // The ⋯ sheet's row (canvas 10i), two lines tall for the blurb; the current one tinted and ticked as in CHANGE TAG.
                <button
                  key={model.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => choose(model)}
                  className={[
                    'flex min-h-13 w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left',
                    selected ? 'bg-[rgba(150,205,255,.09)]' : '',
                  ].join(' ')}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[13px] text-text-bright">{modelChipLabel(model)}</span>
                    <span className="mt-0.5 block text-[12px] leading-[1.35] text-[rgba(160,190,225,.7)]">{model.blurb}</span>
                  </span>
                  <span aria-hidden className={['text-[oklch(85%_.12_205)]', selected ? 'opacity-100' : 'opacity-0'].join(' ')}>
                    ✓
                  </span>
                </button>
              )
            })}
          </div>
          <div className="mx-2.5 mt-1.5 border-t border-[rgba(150,205,255,.1)] pt-2.5 font-mono text-[10.5px] leading-[1.6] text-[rgba(160,190,225,.6)]">
            Context is kept. A divider marks the switch in the transcript.
          </div>
          <div className="h-4" />
        </>
      )}
    </BottomSheet>
  )
}
