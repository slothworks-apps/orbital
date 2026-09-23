import { useEffect, useRef, useState } from 'react'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { matchModel, modelChipLabel, isExactModelMatch } from '../lib/models'
import { Badge } from '../ui/Badge'
import { EscapeBoundary, useEscapeLayer } from '../ui/escapeLayer'
import type { ApiSession, OrbitalModel } from '../lib/types'

/** Same wording `ui/ModelCards.tsx` uses for its empty state — one sentence, one source of truth. */
const EMPTY_CATALOG_REASON = 'The model list could not be read from Claude Code.'

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
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)
  const current = matchModel(session, models)
  // The variant only belongs on the label when the match is exact (F2): the
  // stripped-suffix fallback exists so a terminal session has a name at all,
  // and letting it also claim a variant would have the chip promise a
  // context size the read-out below cannot back up.
  const label = current
    ? (isExactModelMatch(session, current) ? modelChipLabel(current) : current.shortVersion)
    : (session.resolvedModel ?? session.model ?? 'unknown model')

  useEscapeLayer(open, () => setOpen(false))

  // The popover cannot survive a selection change: `label` and `current`
  // above are computed from `session`, so leaving it open across a switch
  // would describe the session that used to be selected.
  useEffect(() => {
    setOpen(false)
  }, [session.id])

  // `pointerdown`, not `click` — matches `ui/Select.tsx`'s own dismissal:
  // closing on click would land after the next control had already been
  // pressed, so the dismissal would fight it.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent | MouseEvent) => {
      const target = e.target
      if (!(target instanceof Node)) return
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  // An empty catalog (a probe that has never succeeded) has nothing to offer
  // a switch to — same treatment as a terminal-live session: an inert chip
  // with the reason as its tooltip, rather than a popover that opens onto
  // just a kicker and a footer.
  const inertReason = disabledReason ?? (models.length === 0 ? EMPTY_CATALOG_REASON : undefined)

  if (inertReason) {
    return (
      <span title={inertReason} data-model-badge>
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
        ref={triggerRef}
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
          <div
            ref={popupRef}
            className="orbital-no-drag absolute right-0 top-[calc(100%+6px)] z-20 w-[300px] rounded-[10px] border border-[rgba(150,205,255,.22)] bg-gradient-to-b from-[rgba(18,26,44,.98)] to-[rgba(10,14,26,.98)] shadow-[0_20px_50px_rgba(0,0,0,.6),inset_0_1px_0_rgba(255,255,255,.06)]"
          >
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
