import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { Panel } from '../ui/Panel'
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

/** Mono section kicker inside the settings content column (canvas 1h). */
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="pb-1 pt-3.5 font-mono text-[10px] tracking-[0.18em] text-text-muted">
      {children}
    </div>
  )
}

/** One settings row per canvas 1h: label + description left, control right. */
function Row({ title, desc, children }: { title: string; desc: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[1fr_320px] items-start gap-6 border-t border-panel-border/40 py-3.5">
      <div>
        <div className="text-[13.5px] font-semibold text-text-bright">{title}</div>
        <div className="mt-1 text-xs leading-relaxed text-[rgba(160,190,225,.7)]">{desc}</div>
      </div>
      <div className="flex min-w-0 flex-col items-start gap-2.5">{children}</div>
    </div>
  )
}

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
  const setDialog = useOrbital((s) => s.setDialog)
  const [projectDirDraft, setProjectDirDraft] = useState(settings.default_project_dir ?? '')
  const [saved, setSaved] = useState(false)

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
      setSaved(true)
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

  const lineageOptions = [...LINEAGE_STEPS, 'Infinity'] as const

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(2,4,9,.5)] p-6 backdrop-blur-[3px]">
      <Panel side="float" className="flex h-[740px] max-h-full w-full max-w-[1120px] flex-col overflow-hidden">
        <div className="flex items-center gap-3.5 border-b border-panel-border/60 px-7 py-5">
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-[7px] border border-panel-border text-sm text-text-muted transition-colors hover:bg-white/5 hover:text-text-bright"
          >
            ‹
          </button>
          <div className="flex-1">
            <div className="font-mono text-[10px] tracking-[0.2em] text-accent/80">SETTINGS</div>
            <h2 className="mt-1 text-xl font-bold tracking-[-0.01em] text-text-bright">Sessions</h2>
          </div>
          {saved && (
            <span className="font-mono text-[10.5px] tracking-[0.06em] text-text-muted">
              saved · just now
            </span>
          )}
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[240px_1fr]">
          <nav
            className="flex flex-col gap-0.5 border-r border-panel-border/60 p-3"
            aria-label="Settings sections"
          >
            {NAV_ITEMS.map((item) => (
              <button
                key={item.key}
                type="button"
                disabled={item.disabled}
                aria-current={item.key === 'sessions' ? 'true' : undefined}
                title={item.disabled ? 'coming soon' : undefined}
                className={[
                  'flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-[13px]',
                  item.key === 'sessions'
                    ? 'border-panel-border bg-[rgba(150,205,255,.08)] font-semibold text-text-bright'
                    : 'border-transparent font-medium text-[rgba(220,235,255,.8)]',
                  item.disabled ? 'cursor-default opacity-60' : 'hover:bg-white/5',
                ].join(' ')}
              >
                {item.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setDialog('tags')}
              className="flex items-center gap-2.5 rounded-lg border border-transparent px-3 py-2 text-left text-[13px] font-medium text-[rgba(220,235,255,.8)] hover:bg-white/5"
            >
              Tags &amp; rules
              <span className="flex-1" />
              <span className="font-mono text-[10px] text-text-muted">›</span>
            </button>
            <span className="flex-1" />
            <div className="px-3 py-2.5 font-mono text-[10px] leading-relaxed text-[rgba(160,190,225,.45)]">
              orbital {pkg.version}
            </div>
          </nav>

          <div className="flex min-h-0 flex-col overflow-y-auto px-8 pb-5 pt-2">
            <SectionLabel>NEW SESSIONS</SectionLabel>
            <Row
              title="Default permission mode"
              desc="Applied to every new session and to sessions created by Clear. Can be changed per session."
            >
              <ModeCards
                compact
                value={defaultPermissionMode}
                onChange={(mode) => void patchAndSet({ default_permission_mode: mode })}
              />
            </Row>
            <Row title="Default project directory" desc="Pre-filled in the New session dialog.">
              <Input
                id="settings-default-dir"
                aria-label="Default project directory"
                font="mono"
                value={projectDirDraft}
                onChange={(e) => setProjectDirDraft(e.target.value)}
                placeholder="/path/to/projects"
                className="w-full"
              />
            </Row>

            <SectionLabel>CLEAR &amp; LINEAGE</SectionLabel>
            <Row
              title="Lineage depth on the map"
              desc="How many linked sessions per project stay visible as a chain. Older ones drop off the map — the sidebar history is always unlimited."
            >
              <div
                role="group"
                aria-label="Lineage depth"
                className="inline-flex overflow-hidden rounded-lg border border-[rgba(150,205,255,.18)] bg-[rgba(4,8,16,.5)]"
              >
                {lineageOptions.map((step, i) => (
                  <button
                    key={step}
                    type="button"
                    aria-pressed={lineageDepth === step}
                    onClick={() => void patchAndSet({ lineage_depth: step })}
                    className={[
                      'min-w-[40px] px-3 py-[7px] text-center font-mono text-xs transition-colors',
                      i > 0 ? 'border-l border-[rgba(150,205,255,.12)]' : '',
                      lineageDepth === step
                        ? 'bg-accent font-bold text-space'
                        : 'text-[rgba(220,235,255,.85)] hover:bg-white/5',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {step === 'Infinity' ? '∞' : step}
                  </button>
                ))}
              </div>
              {/* Mini lineage chain (canvas 1h): ended → idle → current, older fading out. */}
              <div aria-hidden className="mt-0.5 flex items-center">
                <span className="h-3 w-3 rounded-full border border-[rgba(200,215,235,.35)] bg-[#0b141d] opacity-30" />
                <span className="mx-1 w-4 border-t border-dotted border-accent/50" />
                <span className="h-3.5 w-3.5 rounded-full border border-accent/45 bg-[#111c28]" />
                <span className="mx-1 w-4 border-t border-dotted border-accent/50" />
                <span className="relative h-4 w-4 rounded-full border border-accent bg-[#111c28]">
                  <span className="absolute inset-[5px] rounded-full bg-accent" />
                </span>
                <span className="ml-3 font-mono text-[10px] text-text-muted">older stay in history</span>
              </div>
            </Row>
            <Row
              title="Confirm before Clear"
              desc="Show the confirmation dialog when running /clear or ⌘⇧N."
            >
              <Toggle
                aria-label="Confirm before clear"
                checked={confirmBeforeClear}
                onChange={(checked) =>
                  void patchAndSet({ confirm_before_clear: checked ? 'true' : 'false' })
                }
              />
            </Row>
            <Row title="New session inherits" desc="What Clear carries over from the ended session.">
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
            </Row>
            <Row
              title="Mark session ended after"
              desc="Idle time before an active session is treated as history."
            >
              <Select
                id="settings-ended-after"
                aria-label="Mark session ended after"
                font="sans"
                value={endedAfterIdle}
                onChange={(e) => void patchAndSet({ ended_after_idle_minutes: e.target.value })}
                className="w-[200px]"
              >
                {IDLE_OPTIONS.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {minutes} min idle
                  </option>
                ))}
              </Select>
            </Row>
          </div>
        </div>
      </Panel>
    </div>
  )
}
