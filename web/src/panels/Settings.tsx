import { useEffect, useMemo, useState } from 'react'
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

/** Idle presets from canvas 1h. Values are the minute counts the server
 * reads back as `Number(...)` (`server/src/index.ts` → `idleTimeoutMs`), so
 * only numeric options are offered — 1h's "Never — only on Clear" needs a
 * sentinel the server can special-case and is left out until it does. */
const IDLE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '15', label: '15 min idle' },
  { value: '30', label: '30 min idle' },
  { value: '60', label: '60 min idle' },
  { value: '120', label: '2 h idle' },
]

const NAV_ITEMS: Array<{ key: string; label: string; disabled: boolean }> = [
  { key: 'general', label: 'General', disabled: true },
  { key: 'sessions', label: 'Sessions', disabled: false },
  { key: 'permissions', label: 'Permissions', disabled: true },
  // "Tags & rules" sits here in canvas 1h (4th, above Appearance) and is the
  // one nav row that navigates away — rendered separately below.
  { key: 'appearance', label: 'Appearance', disabled: true },
  { key: 'shortcuts', label: 'Shortcuts', disabled: true },
]

/** Debounce for the free-text project-dir field — the rest of this panel's
 * controls (cards, segmented steps, toggles, selects) are discrete clicks
 * and PATCH immediately. */
const DEBOUNCE_MS = 400

/** Nav row geometry from canvas 1h: 9px/12px padding, 8px radius, 13px. */
const NAV_ROW = 'flex items-center gap-2.5 rounded-lg border px-3 py-[9px] text-left text-[13px]'

/** Mono section kicker inside the settings content column (canvas 1h):
 * 8px/4px above the first group, 14px/4px above every later one. */
function SectionLabel({ children, first = false }: { children: ReactNode; first?: boolean }) {
  return (
    <div
      className={`pb-1 font-mono text-[10px] tracking-[0.18em] text-[rgba(160,190,225,.6)] ${first ? 'pt-2' : 'pt-3.5'}`}
    >
      {children}
    </div>
  )
}

/** One settings row per canvas 1h: label + description left, 320px control
 * column right, 13px vertical padding over a hairline top rule. */
function Row({ title, desc, children }: { title: string; desc: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[1fr_320px] items-start gap-6 border-t border-[rgba(150,205,255,.08)] py-[13px]">
      <div>
        <div className="text-[13.5px] font-semibold text-text-bright">{title}</div>
        <div className="mt-1 text-[12px] leading-[1.5] text-[rgba(160,190,225,.7)] [text-wrap:pretty]">
          {desc}
        </div>
      </div>
      <div className="flex min-w-0 flex-col items-start gap-2.5">{children}</div>
    </div>
  )
}

/** Orb sizes/opacities of the lineage chain illustration, verbatim from
 * canvas 1h (oldest → current, the current one accent-ringed with a core). */
const CHAIN_ORBS = [
  { size: 14, opacity: 0.25, gap: 18, gapOpacity: 0.2 },
  { size: 16, opacity: 0.6, gap: 22, gapOpacity: 0.4 },
  { size: 18, opacity: 0.6, gap: 22, gapOpacity: 0.5 },
  { size: 22, opacity: 1, gap: 0, gapOpacity: 0 },
]

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
  const sessionCwds = useOrbital(useShallow((s) => Object.values(s.sessions).map((x) => x.cwd)))
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

  const defaultPermissionMode = ((settings.default_permission_mode as PermissionMode) || 'acceptEdits')
  const lineageDepth = settings.lineage_depth ?? '3'
  const confirmBeforeClear = settings.confirm_before_clear !== 'false'
  const inheritTags = settings.inherit_tags !== 'false'
  const inheritPermissionMode = settings.inherit_permission_mode !== 'false'
  const endedAfterIdle = settings.ended_after_idle_minutes ?? '30'
  // Canvas 1h prints a second version line. The server has no Claude Code
  // version endpoint yet; when it starts writing `claude_code_version` into
  // the settings table this row lights up on its own.
  const claudeCodeVersion = settings.claude_code_version

  // "+N in history" (canvas 1h): sessions that the current depth pushes off
  // the map, summed per project — the real number, not a placeholder.
  const droppedFromMap = useMemo(() => {
    const depth = Number(lineageDepth)
    if (!Number.isFinite(depth) || depth <= 0) return 0
    const perProject = new Map<string, number>()
    for (const cwd of sessionCwds) perProject.set(cwd, (perProject.get(cwd) ?? 0) + 1)
    let dropped = 0
    for (const count of perProject.values()) dropped += Math.max(0, count - depth)
    return dropped
  }, [sessionCwds, lineageDepth])

  if (!open) return null

  const lineageOptions = [...LINEAGE_STEPS, 'Infinity'] as const
  // Chain length tracks the depth setting plus the live session at its head —
  // 1h draws four orbs at depth 3, which is also the cap it illustrates.
  const depthNumber = Number(lineageDepth)
  const orbCount = Number.isFinite(depthNumber)
    ? Math.min(CHAIN_ORBS.length, Math.max(2, depthNumber + 1))
    : CHAIN_ORBS.length
  const chain = CHAIN_ORBS.slice(CHAIN_ORBS.length - orbCount)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(2,4,9,.5)] p-6 backdrop-blur-[3px]">
      <Panel side="float" className="flex h-[740px] max-h-full w-full max-w-[1120px] flex-col overflow-hidden">
        {/* Header: 22/28/18 padding per canvas 1h. */}
        <div className="flex items-center gap-3.5 border-b border-[rgba(150,205,255,.1)] px-7 pb-[18px] pt-[22px]">
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-[7px] border border-panel-border text-sm text-[rgba(200,220,245,.7)] transition-colors hover:bg-white/5 hover:text-text-bright"
          >
            ‹
          </button>
          <div className="flex-1">
            <div className="font-mono text-[10px] tracking-[0.2em] text-accent/80">SETTINGS</div>
            <h2 className="mt-1 text-xl font-bold tracking-[-0.01em] text-text-bright">Sessions</h2>
          </div>
          {saved && (
            <span className="font-mono text-[10.5px] tracking-[0.06em] text-[rgba(160,190,225,.55)]">
              saved · just now
            </span>
          )}
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[240px_1fr]">
          {/* Nav column: 240px, 16px/12px padding, 2px row gap (canvas 1h). */}
          <nav
            className="flex flex-col gap-0.5 border-r border-[rgba(150,205,255,.1)] px-3 py-4"
            aria-label="Settings sections"
          >
            {NAV_ITEMS.map((item) => (
              <div key={item.key} className="contents">
                <button
                  type="button"
                  disabled={item.disabled}
                  aria-current={item.key === 'sessions' ? 'true' : undefined}
                  title={item.disabled ? 'coming soon' : undefined}
                  className={[
                    NAV_ROW,
                    item.key === 'sessions'
                      ? 'border-panel-border bg-[rgba(150,205,255,.08)] font-semibold text-text-bright'
                      : 'border-transparent font-medium text-[rgba(220,235,255,.8)]',
                    item.disabled ? 'cursor-default' : 'hover:bg-white/5',
                  ].join(' ')}
                >
                  {item.label}
                </button>
                {item.key === 'permissions' && (
                  <button
                    type="button"
                    onClick={() => setDialog('tags')}
                    className={`${NAV_ROW} border-transparent font-medium text-[rgba(220,235,255,.8)] hover:bg-white/5`}
                  >
                    Tags &amp; rules
                    <span className="flex-1" />
                    <span className="font-mono text-[10px] text-[rgba(160,190,225,.5)]">›</span>
                  </button>
                )}
              </div>
            ))}
            <span className="flex-1" />
            <div className="px-3 py-2.5 font-mono text-[10px] leading-[1.6] text-[rgba(160,190,225,.45)]">
              <div>orbital {pkg.version}</div>
              {claudeCodeVersion && <div>claude-code {claudeCodeVersion}</div>}
            </div>
          </nav>

          {/* Content column: 8/32/20 padding per canvas 1h. */}
          <div className="flex min-h-0 flex-col overflow-y-auto px-8 pb-5 pt-2">
            <SectionLabel first>NEW SESSIONS</SectionLabel>
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
                size="sm"
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
                        ? 'bg-accent font-bold text-space-deep'
                        : 'text-[rgba(220,235,255,.85)] hover:bg-white/5',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {step === 'Infinity' ? '∞' : step}
                  </button>
                ))}
              </div>
              {/* Lineage chain illustration (canvas 1h): as many orbs as the
                  depth keeps on the map, the newest accent-ringed, plus the
                  live count of sessions the setting pushes into history. */}
              <div className="mt-0.5 flex items-center" data-testid="lineage-chain">
                {chain.map((orb, i) => (
                  <span key={orb.size} aria-hidden className="flex items-center">
                    {i > 0 && (
                      <span
                        className="mx-1 border-t border-dotted"
                        style={{
                          width: chain[i - 1].gap,
                          borderColor: `rgb(89 228 243 / ${chain[i - 1].gapOpacity})`,
                        }}
                      />
                    )}
                    <span
                      data-orb=""
                      className={[
                        'relative block rounded-full border',
                        orb.opacity === 1
                          ? 'border-accent/45 bg-[#111c28]'
                          : 'border-[rgba(200,215,235,.35)] bg-[#0b141d]',
                      ].join(' ')}
                      style={{ width: orb.size, height: orb.size, opacity: orb.opacity }}
                    >
                      {orb.opacity === 1 && (
                        <span className="absolute left-1/2 top-1/2 h-[3px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/80" />
                      )}
                    </span>
                  </span>
                ))}
                {droppedFromMap > 0 && (
                  <span className="ml-3 font-mono text-[10px] text-[rgba(160,190,225,.55)]">
                    +{droppedFromMap} in history
                  </span>
                )}
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
                {IDLE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
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
