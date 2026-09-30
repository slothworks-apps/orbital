import { useEffect, useRef, useState } from 'react'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { PERMISSION_MODES, permissionMode } from '../lib/permissionModes'
import { ModeDot, ModeReadout } from '../ui/ModeDot'
import { Tooltip } from '../ui/Tooltip'
import { EscapeBoundary, useEscapeLayer } from '../ui/escapeLayer'
import type { ApiSession, PermissionMode } from '../lib/types'

/**
 * The detail header's permission-mode readout, made pickable: the same 24×22
 * dot box (canvas 2d, 2e) opens a listbox of the four modes.
 *
 * Unlike a model switch there is nothing to confirm — no cache is lost and
 * nothing is re-read — so a pick applies at once; the CLI consults the mode
 * on its next tool call, mid-turn included. A session the terminal owns gets
 * the plain readout: Orbital cannot reach its process
 * (docs/decisions/a-permission-mode-switch-applies-at-once.md).
 *
 * Not on the canvas; the popover borrows `ModelSwitcher`'s shell so the two
 * header dropdowns read as a pair.
 */
export function ModeSwitcher({ session, disabled }: { session: ApiSession; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)
  const current = session.permissionMode
  const descriptor = permissionMode(current)

  useEscapeLayer(open, () => setOpen(false))

  // Same reason as `ModelSwitcher`: the popover describes the session that
  // was selected when it opened.
  useEffect(() => setOpen(false), [session.id])

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

  if (!current || !descriptor) return null
  if (disabled) return <ModeReadout mode={current} />

  function choose(mode: PermissionMode) {
    setOpen(false)
    if (mode === current) return
    const previous = current
    const patch = (value: PermissionMode | null) =>
      useOrbital.setState((state) => {
        const row = state.sessions[session.id]
        if (!row) return state
        return { sessions: { ...state.sessions, [session.id]: { ...row, permissionMode: value } } }
      })
    patch(mode)
    api.setSessionPermissionMode(session.id, mode).catch((err) => {
      patch(previous)
      reportError(err, 'Failed to switch permission mode')
    })
  }

  return (
    <span className="relative inline-flex">
      <Tooltip title={descriptor.label} description={descriptor.description} align="right" suppressed={open}>
        <button
          ref={triggerRef}
          type="button"
          data-mode={current}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`Change permission mode (currently ${descriptor.label})`}
          onClick={() => setOpen((v) => !v)}
          className={[
            'flex h-[22px] w-6 items-center justify-center rounded-[5px] border',
            'bg-[rgba(4,8,16,.5)] transition-colors outline-none',
            open ? 'border-accent/55' : 'border-[rgba(150,205,255,.2)]',
            'hover:border-accent/55 focus-visible:border-accent/55',
          ].join(' ')}
        >
          <ModeDot mode={current} size={8} />
        </button>
      </Tooltip>
      {open && (
        <EscapeBoundary>
          <div
            ref={popupRef}
            className="orbital-no-drag absolute right-0 top-[calc(100%+6px)] z-20 w-[300px] rounded-[10px] border border-[rgba(150,205,255,.22)] bg-gradient-to-b from-[rgba(18,26,44,.98)] to-[rgba(10,14,26,.98)] shadow-[0_20px_50px_rgba(0,0,0,.6),inset_0_1px_0_rgba(255,255,255,.06)]"
          >
            <div className="px-3 pb-1.5 pt-2.5 font-mono text-[9.5px] tracking-[0.18em] text-[rgba(160,190,225,.6)]">
              PERMISSION MODE · APPLIES NOW
            </div>
            <div role="listbox" aria-label="Permission mode" className="flex flex-col px-1.5 pb-1.5">
              {PERMISSION_MODES.map((mode) => {
                const selected = mode.value === current
                return (
                  <button
                    key={mode.value}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    aria-label={mode.label}
                    onClick={() => choose(mode.value)}
                    className={[
                      'grid grid-cols-[1fr_auto] items-center gap-2 rounded-[7px] border px-2 py-[9px] text-left',
                      selected ? 'border-accent/35 bg-accent/10' : 'border-transparent hover:bg-white/5',
                    ].join(' ')}
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <ModeDot mode={mode.value} />
                        <span className="truncate font-mono text-xs text-text-bright">{mode.label}</span>
                      </span>
                      <span className="mt-0.5 block pl-[15px] text-[11px] text-[rgba(160,190,225,.7)]">
                        {mode.description}
                      </span>
                    </span>
                    {selected && (
                      <span className="font-mono text-[9.5px] tracking-[0.1em] text-accent">CURRENT</span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        </EscapeBoundary>
      )}
    </span>
  )
}
