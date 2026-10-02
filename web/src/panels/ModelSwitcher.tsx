import { useEffect, useRef, useState } from 'react'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { useCommand } from '../lib/commands'
import { command, matches, shortcutLabel } from '../lib/keymap'
import { formatTokens } from '../lib/format'
import { matchModel, modelChipLabel, sessionModelLabel } from '../lib/models'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
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
  /** The panel holding it is mounted but not on screen: the key does not open it. */
  hidden?: boolean
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
export function ModelSwitcher({ session, models, defaultValue, disabledReason, hidden = false }: ModelSwitcherProps) {
  const [open, setOpen] = useState(false)
  /** The model a pick is waiting on the confirm for — see `SwitchDialog`. */
  const [pending, setPending] = useState<OrbitalModel | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)
  const current = matchModel(session, models)
  const label = sessionModelLabel(session, models)

  useEscapeLayer(open, () => setOpen(false))

  // The popover cannot survive a selection change: `label` and `current`
  // above are computed from `session`, so leaving it open across a switch
  // would describe the session that used to be selected.
  useEffect(() => {
    setOpen(false)
    setPending(null)
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

  // Registered here rather than by the panel, so the key is live exactly
  // while a switcher that can open is on screen — never for the inert badge
  // below, and never for the session the panel is still drawing as it slides
  // away. Focus goes to the trigger so the popover's own keyboard (and
  // Escape back to the trigger) works the way it does after a click.
  const onScreen = useOrbital((s) => s.ui.selectedId === session.id)
  useCommand(
    'session.model',
    () => {
      triggerRef.current?.focus()
      setOpen(true)
    },
    !inertReason && onScreen && !hidden
  )

  if (inertReason) {
    return (
      <span title={inertReason} data-model-badge>
        <Badge variant="model" value={label} />
      </span>
    )
  }

  function choose(model: OrbitalModel) {
    setOpen(false)
    if (model.value === session.model) return
    setPending(model)
  }

  function apply(value: string) {
    setPending(null)
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
        title={`Change model (from next turn) · ${shortcutLabel('session.model')}`}
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
                    onClick={() => choose(model)}
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
      <SwitchDialog
        to={pending}
        contextTokens={session.contextUsedTokens ?? null}
        onCancel={() => setPending(null)}
        onConfirm={() => pending && apply(pending.value)}
      />
    </span>
  )
}

/**
 * Asks before every switch, whatever state the cache is in.
 *
 * A model's prompt cache is its own: the next turn on another model reads the
 * whole conversation again at the full input rate, where the same turn on the
 * current model would have read most of it cheaply from the cache. The CLI
 * warns only while the cache is still warm (it tracks `prompt_cache_warm` and
 * an estimated re-cache cost); Orbital asks every time, because a dialog that
 * appears on one switch and not on the next reads as random (owner's call,
 * 2026-09-28). Built like `CompactDialog` — same shell, same ⏎ confirm. Not
 * on the canvas; its fidelity is checked by hand.
 */
function SwitchDialog({
  to,
  contextTokens,
  onCancel,
  onConfirm,
}: {
  to: OrbitalModel | null
  contextTokens: number | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const open = to !== null

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!matches(command('dialogs.confirm').chords[0], e)) return
      e.preventDefault()
      onConfirm()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onConfirm])

  const name = to ? modelChipLabel(to) : ''
  const amount = contextTokens ? `all ${formatTokens(contextTokens)} tokens of it` : 'all of it'
  return (
    <Dialog
      open={open}
      title={`Switch to ${name}?`}
      eyebrow="MODEL SWITCH"
      size="sm"
      onClose={onCancel}
      footerCaption="esc cancel · ⏎ switch"
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" onClick={onConfirm}>
            Switch
          </Button>
        </>
      }
    >
      <p className="text-[13px] leading-[1.55] text-[rgba(200,214,235,.85)] [text-wrap:pretty]">
        The conversation is kept, but {name} reads it from scratch on your next message — {amount}. The
        cache that makes a turn cheap belongs to the current model, so that turn uses noticeably more of your
        limit than usual.
      </p>
    </Dialog>
  )
}
