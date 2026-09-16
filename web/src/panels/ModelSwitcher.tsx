import { useState } from 'react'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { matchModel, modelChipLabel } from '../lib/models'
import { Badge } from '../ui/Badge'
import { EscapeBoundary, useEscapeLayer } from '../ui/escapeLayer'
import type { ApiSession, OrbitalModel } from '../lib/types'

export interface ModelSwitcherProps {
  session: ApiSession
  models: OrbitalModel[]
  /** SDK `value` of the Settings default, marked `DEFAULT` in the list. */
  defaultValue: string | null
  /** When set, the badge is inert and carries this as its tooltip. */
  disabledReason?: string
}

/**
 * The model chip in the detail header (canvas 4a) and the listbox it opens.
 *
 * Switching takes effect from the next turn — the SDK's `setModel` changes
 * what serves the conversation, not the conversation itself, which is why the
 * footer can promise the context is kept. The transcript's divider is not
 * written here: `Transcript` derives it from the messages themselves, so it
 * survives a reload and also shows switches Orbital never performed.
 */
export function ModelSwitcher({ session, models, defaultValue, disabledReason }: ModelSwitcherProps) {
  const [open, setOpen] = useState(false)
  const current = matchModel(session, models)
  const label = current
    ? modelChipLabel(current)
    : (session.resolvedModel ?? session.model ?? 'unknown model')

  useEscapeLayer(open, () => setOpen(false))

  if (disabledReason) {
    return (
      <span title={disabledReason} data-model-badge>
        <Badge variant="model" value={label} />
      </span>
    )
  }

  function choose(value: string) {
    setOpen(false)
    if (value === session.model) return
    const previous = session.model
    useOrbital.setState((state) => {
      const row = state.sessions[session.id]
      if (!row) return state
      return { sessions: { ...state.sessions, [session.id]: { ...row, model: value } } }
    })
    api.setSessionModel(session.id, value).catch((err) => {
      useOrbital.setState((state) => {
        const row = state.sessions[session.id]
        if (!row) return state
        return { sessions: { ...state.sessions, [session.id]: { ...row, model: previous } } }
      })
      reportError(err, 'Failed to switch model')
    })
  }

  return (
    // `inline-flex`, not a bare `<span>`: this is the popover's containing
    // block, and `web/CLAUDE.md` warns that an inline box's geometry is not
    // its own.
    <span className="relative inline-flex">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Change model (currently ${label})`}
        title="Change model (from next turn)"
        onClick={() => setOpen((v) => !v)}
        className="rounded-[5px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <Badge variant="model" interactive value={label} />
      </button>
      {open && (
        <EscapeBoundary>
          {/* Canvas 4a: 300px/10px-radius popover, the same glass gradient +
              inset top highlight `ui/Select.tsx`'s listbox uses. */}
          <div className="absolute right-0 top-[calc(100%+6px)] z-20 w-[300px] rounded-[10px] border border-[rgba(150,205,255,.22)] bg-gradient-to-b from-[rgba(18,26,44,.98)] to-[rgba(10,14,26,.98)] shadow-[0_20px_50px_rgba(0,0,0,.6),inset_0_1px_0_rgba(255,255,255,.06)]">
            <div className="px-3 pb-1.5 pt-2.5 font-mono text-[9.5px] tracking-[0.18em] text-[rgba(160,190,225,.6)]">
              MODEL · APPLIES FROM NEXT TURN
            </div>
            <div role="listbox" aria-label="Model" className="flex flex-col px-1.5 pb-1.5">
              {models.map((model) => {
                const selected = model.value === current?.value
                return (
                  <button
                    key={model.value}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    aria-label={model.shortVersion}
                    onClick={() => choose(model.value)}
                    className={[
                      'grid grid-cols-[1fr_auto] items-center gap-2 rounded-[7px] border px-2 py-[9px] text-left',
                      selected ? 'border-accent/35 bg-accent/10' : 'border-transparent hover:bg-white/5',
                    ].join(' ')}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-xs text-text-bright">{modelChipLabel(model)}</span>
                      <span className="mt-0.5 block text-[11px] text-[rgba(160,190,225,.7)]">{model.blurb}</span>
                    </span>
                    {selected ? (
                      <span className="font-mono text-[9.5px] tracking-[0.1em] text-accent">CURRENT</span>
                    ) : model.value === defaultValue ? (
                      <span className="font-mono text-[9.5px] tracking-[0.1em] text-[rgba(160,190,225,.5)]">DEFAULT</span>
                    ) : null}
                  </button>
                )
              })}
            </div>
            <div className="border-t border-[rgba(150,205,255,.1)] px-3 pb-2.5 pt-2 font-mono text-[10px] leading-[1.6] text-[rgba(160,190,225,.6)] [text-wrap:pretty]">
              Context is kept. A divider marks the switch in the transcript.
            </div>
          </div>
        </EscapeBoundary>
      )}
    </span>
  )
}
