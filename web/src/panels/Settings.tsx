import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { Panel } from '../ui/Panel'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { ModeCards } from '../ui/ModeCards'
import { Select } from '../ui/Select'
import { Checkbox, Toggle } from '../ui/Checkbox'
import type { PermissionMode } from '../lib/types'
import pkg from '../../package.json'

export interface SettingsProps {
  open: boolean
  onClose: () => void
}

const LINEAGE_STEPS = ['1', '2', '3', '4', '5'] as const
const IDLE_OPTIONS = ['15', '30', '60'] as const

const NAV_ITEMS: Array<{ key: string; label: string; disabled: boolean }> = [
  { key: 'general', label: 'General', disabled: true },
  { key: 'sessions', label: 'Sessions', disabled: false },
  { key: 'permissions', label: 'Permissions', disabled: true },
  { key: 'appearance', label: 'Appearance', disabled: true },
  { key: 'shortcuts', label: 'Shortcuts', disabled: true },
]

/** Debounce for the free-text project-dir field — the rest of this panel's
 * controls (cards, segmented steps, toggles, selects) are discrete clicks
 * and PATCH immediately. */
const DEBOUNCE_MS = 400

/**
 * Sessions section of Settings (artboard 1h) — the only section v1
 * implements; General/Permissions/Appearance/Shortcuts are nav placeholders
 * per the spec's deferral. Every control PATCHes `/api/settings` then
 * updates the store only after the request resolves ("await-then-update",
 * the same ordering `ClearDialog`'s "don't ask again" uses in Task 12) so a
 * rejected PATCH never leaves the store claiming a preference the server
 * never actually saved.
 */
export function Settings({ open, onClose }: SettingsProps) {
  const settings = useOrbital(useShallow((s) => s.settings))
  const [projectDirDraft, setProjectDirDraft] = useState(settings.default_project_dir ?? '')

  useEffect(() => {
    if (open) setProjectDirDraft(settings.default_project_dir ?? '')
    // Only reseed on open — an in-flight PATCH from a prior keystroke resolving
    // must not fight the user's current typing while the panel stays open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  async function patchAndSet(patch: Record<string, string>) {
    try {
      await api.patchSettings(patch)
      useOrbital.setState((state) => ({ settings: { ...state.settings, ...patch } }))
    } catch (err) {
      reportError(err, 'Failed to save settings')
    }
  }

  // Debounced PATCH for the free-text project-dir field.
  useEffect(() => {
    if (!open) return
    if (projectDirDraft === (settings.default_project_dir ?? '')) return
    const timer = setTimeout(() => {
      void patchAndSet({ default_project_dir: projectDirDraft })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDirDraft, open])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) return null

  const defaultPermissionMode = ((settings.default_permission_mode as PermissionMode) || 'acceptEdits')
  const lineageDepth = settings.lineage_depth ?? '3'
  const confirmBeforeClear = settings.confirm_before_clear !== 'false'
  const inheritTags = settings.inherit_tags !== 'false'
  const inheritPermissionMode = settings.inherit_permission_mode !== 'false'
  const endedAfterIdle = settings.ended_after_idle_minutes ?? '30'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-space/70 p-6 backdrop-blur-sm">
      <Panel side="float" className="flex max-h-full w-full max-w-3xl flex-col gap-4 overflow-hidden p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-mono text-sm font-semibold tracking-wide text-text-soft">Settings</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            Close
          </Button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[10rem_1fr] gap-6">
          <nav className="flex flex-col gap-1" aria-label="Settings sections">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.key}
                type="button"
                disabled={item.disabled}
                aria-current={item.key === 'sessions' ? 'true' : undefined}
                className={[
                  'flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm',
                  item.key === 'sessions' ? 'bg-white/10 text-text-bright' : 'text-text-soft',
                  item.disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-white/5',
                ].join(' ')}
              >
                <span>{item.label}</span>
                {item.disabled && <span className="font-mono text-[10px] text-text-muted">soon</span>}
              </button>
            ))}
          </nav>

          <div className="flex flex-col gap-5 overflow-y-auto pr-1">
            <section className="flex flex-col gap-2">
              <h3 className="font-mono text-[11px] tracking-[0.15em] text-text-muted">
                DEFAULT PERMISSION MODE
              </h3>
              <ModeCards
                value={defaultPermissionMode}
                onChange={(mode) => void patchAndSet({ default_permission_mode: mode })}
              />
            </section>

            <section className="flex flex-col gap-2">
              <label htmlFor="settings-default-dir" className="font-mono text-[11px] tracking-[0.15em] text-text-muted">
                DEFAULT PROJECT DIRECTORY
              </label>
              <Input
                id="settings-default-dir"
                font="mono"
                value={projectDirDraft}
                onChange={(e) => setProjectDirDraft(e.target.value)}
                placeholder="/path/to/projects"
              />
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="font-mono text-[11px] tracking-[0.15em] text-text-muted">LINEAGE DEPTH</h3>
              <div role="group" aria-label="Lineage depth" className="flex gap-1.5">
                {LINEAGE_STEPS.map((step) => (
                  <button
                    key={step}
                    type="button"
                    aria-pressed={lineageDepth === step}
                    onClick={() => void patchAndSet({ lineage_depth: step })}
                    className={[
                      'h-7 w-7 rounded-md border font-mono text-xs',
                      lineageDepth === step
                        ? 'border-text-bright bg-white/10 text-text-bright'
                        : 'border-panel-border text-text-soft hover:bg-white/5',
                    ].join(' ')}
                  >
                    {step}
                  </button>
                ))}
                <button
                  type="button"
                  aria-pressed={lineageDepth === 'Infinity'}
                  onClick={() => void patchAndSet({ lineage_depth: 'Infinity' })}
                  className={[
                    'h-7 w-7 rounded-md border font-mono text-xs',
                    lineageDepth === 'Infinity'
                      ? 'border-text-bright bg-white/10 text-text-bright'
                      : 'border-panel-border text-text-soft hover:bg-white/5',
                  ].join(' ')}
                >
                  ∞
                </button>
              </div>
            </section>

            <section className="flex flex-col gap-2">
              <Toggle
                checked={confirmBeforeClear}
                onChange={(checked) =>
                  void patchAndSet({ confirm_before_clear: checked ? 'true' : 'false' })
                }
                label="Confirm before clear"
              />
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="font-mono text-[11px] tracking-[0.15em] text-text-muted">
                NEW SESSION INHERITS
              </h3>
              <Checkbox
                checked={inheritTags}
                onChange={(checked) => void patchAndSet({ inherit_tags: checked ? 'true' : 'false' })}
                label="Tags"
              />
              <Checkbox
                checked={inheritPermissionMode}
                onChange={(checked) =>
                  void patchAndSet({ inherit_permission_mode: checked ? 'true' : 'false' })
                }
                label="Permission mode"
              />
            </section>

            <section className="flex flex-col gap-2">
              <label htmlFor="settings-ended-after" className="font-mono text-[11px] tracking-[0.15em] text-text-muted">
                MARK SESSION ENDED AFTER
              </label>
              <Select
                id="settings-ended-after"
                value={endedAfterIdle}
                onChange={(e) => void patchAndSet({ ended_after_idle_minutes: e.target.value })}
                className="w-32"
              >
                {IDLE_OPTIONS.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {minutes} min
                  </option>
                ))}
              </Select>
            </section>
          </div>
        </div>

        <p className="border-t border-panel-border pt-3 font-mono text-[11px] text-text-muted">
          orbital v{pkg.version}
        </p>
      </Panel>
    </div>
  )
}
