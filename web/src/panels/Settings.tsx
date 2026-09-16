import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { Panel } from '../ui/Panel'
import { EscapeBoundary, useEscapeLayer } from '../ui/escapeLayer'
import { usePresence } from '../ui/usePresence'
import {
  MODAL_CLOSED,
  MODAL_ENTER_DURATION,
  MODAL_ENTER_MS,
  MODAL_EXIT_DURATION,
  MODAL_EXIT_MS,
  MODAL_OPEN,
  MODAL_TRANSITION,
  SCRIM_CLOSED,
  SCRIM_OPEN,
  EXITING,
} from '../ui/motion'
import { Input } from '../ui/Input'
import { ModeCards } from '../ui/ModeCards'
import { ModelCards } from '../ui/ModelCards'
import { Select } from '../ui/Select'
import { Checkbox, Toggle } from '../ui/Checkbox'
import { modelByValue } from '../lib/models'
import type { PermissionMode } from '../lib/types'
import { TagsRulesSection } from './TagsRules'
import pkg from '../../package.json'

export interface SettingsProps {
  open: boolean
  onClose: () => void
}

const LINEAGE_STEPS = ['1', '2', '3', '4', '5'] as const

/** Idle presets from canvas 1h. Values are minute counts, except the final
 * `'never'` sentinel — the server's `parseIdleTimeoutMs`
 * (`server/src/runner/runner.ts`) maps it to a null timeout so `Runner` never
 * arms an idle timer, and only Clear ends the session. */
const IDLE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '15', label: '15 min idle' },
  { value: '30', label: '30 min idle' },
  { value: '60', label: '60 min idle' },
  { value: '120', label: '2 h idle' },
  { value: 'never', label: 'Never — only on Clear' },
]

/**
 * How long an ended session keeps being drawn on the map. Distinct from the
 * idle preset above: that one ENDS a running web session, this one only
 * stops drawing an already-ended one. `never` means no age cutoff — the
 * sentinel `endedMaxAgeMs` (`store/store.ts`) reads.
 */
const ENDED_AGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
  { value: '14', label: '14 days' },
  { value: '30', label: '30 days' },
  { value: 'never', label: 'Never — keep drawing them' },
]

/**
 * The nav, in canvas order. Two sections are live: "Sessions" (1h) and
 * "Tags & rules" (1e) — 1e is the same dialog with the 4th row selected, not
 * a screen of its own, which is why it is a section here rather than a link.
 * The rest are drawn but inert until they have something to hold.
 */
const NAV_ITEMS = [
  { key: 'general', label: 'General', disabled: true },
  { key: 'sessions', label: 'Sessions', disabled: false },
  { key: 'permissions', label: 'Permissions', disabled: true },
  { key: 'tags', label: 'Tags & rules', disabled: false },
  { key: 'appearance', label: 'Appearance', disabled: true },
  { key: 'shortcuts', label: 'Shortcuts', disabled: true },
] as const

type SectionKey = (typeof NAV_ITEMS)[number]['key']

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
  const models = useOrbital(useShallow((s) => s.models))
  const sessionCwds = useOrbital(useShallow((s) => Object.values(s.sessions).map((x) => x.cwd)))
  const [projectDirDraft, setProjectDirDraft] = useState(settings.default_project_dir ?? '')
  const [saved, setSaved] = useState(false)
  const [section, setSection] = useState<SectionKey>('sessions')

  useEffect(() => {
    if (!open) return
    // Every visit starts on Sessions, and with no stale "saved · just now"
    // left over from the last one — the dialog is held mounted across `open`.
    setSection('sessions')
    setSaved(false)
  }, [open])

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

  // Closes the dialog. A rule row open inside Tags & rules registers a deeper
  // layer and is peeled first (see `TagsRulesSection`).
  useEscapeLayer(open, onClose)
  // Held mounted through the close transition (see `ui/usePresence`).
  const { mounted, state: presence } = usePresence(open, MODAL_ENTER_MS, MODAL_EXIT_MS)

  const sectionTitle = NAV_ITEMS.find((item) => item.key === section)?.label ?? 'Sessions'

  const defaultPermissionMode = ((settings.default_permission_mode as PermissionMode) || 'acceptEdits')
  const lineageDepth = settings.lineage_depth ?? '3'
  const confirmBeforeClear = settings.confirm_before_clear !== 'false'
  const inheritTags = settings.inherit_tags !== 'false'
  const inheritPermissionMode = settings.inherit_permission_mode !== 'false'
  const endedAfterIdle = settings.ended_after_idle_minutes ?? '30'
  const mapEndedMaxAge = settings.map_ended_max_age_days ?? '1'
  // `default_model` is a value, not a flag — a missing key means "no
  // preference yet", not "off", so it reads as `null` rather than a default.
  const defaultModel = settings.default_model ?? ''
  const rememberModelPerProject = settings.remember_model_per_project !== 'false'
  const mapShowModel = settings.map_show_model !== 'false'
  // canvas 4c: the sample chip beside the toggle above shows what it will
  // actually draw — the selected default's family, upper-cased — rather than
  // a placeholder, so it renders nothing when there is no catalog or no
  // matching row instead of showing something that could look real.
  const mapModelSample = modelByValue(defaultModel || null, models)?.family.toUpperCase()
  // Canvas 1h prints a second version line. The server resolves the bundled
  // Claude Code CLI version at boot into `claude_code_version`; when it can't
  // (no SDK/manifest) the key stays absent and this row stays hidden.
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

  if (!mounted) return null

  const entered = presence === 'entered'
  const duration = presence === 'exiting' ? MODAL_EXIT_DURATION : MODAL_ENTER_DURATION
  const lineageOptions = [...LINEAGE_STEPS, 'Infinity'] as const
  // Chain length tracks the depth setting plus the live session at its head —
  // 1h draws four orbs at depth 3, which is also the cap it illustrates.
  const depthNumber = Number(lineageDepth)
  const orbCount = Number.isFinite(depthNumber)
    ? Math.min(CHAIN_ORBS.length, Math.max(2, depthNumber + 1))
    : CHAIN_ORBS.length
  const chain = CHAIN_ORBS.slice(CHAIN_ORBS.length - orbCount)

  return (
    <EscapeBoundary>
    <div
      data-state={presence}
      // Still painted on the way out, but no longer a live surface.
      inert={presence === 'exiting' || undefined}
      className={[
        'fixed inset-0 z-50 flex items-center justify-center bg-[rgba(2,4,9,.5)] p-6 backdrop-blur-[3px]',
        MODAL_TRANSITION,
        duration,
        entered ? SCRIM_OPEN : SCRIM_CLOSED,
        presence === 'exiting' ? EXITING : '',
      ].join(' ')}
    >
      {/* The motion lives on a wrapper, not on `Panel`: Panel's base classes
          already declare `transition-[width]`, and a second transition-property
          utility would resolve by stylesheet order rather than by intent. */}
      <div
        className={[
          'flex h-[740px] max-h-full w-full max-w-[1120px]',
          MODAL_TRANSITION,
          duration,
          entered ? MODAL_OPEN : MODAL_CLOSED,
        ].join(' ')}
      >
      <Panel side="float" className="flex h-full w-full flex-col overflow-hidden">
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
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[10px] tracking-[0.2em] text-accent/80">SETTINGS</div>
            {/* The title is the section's, not the dialog's: 1e and 1h are the
                same screen under two nav rows. */}
            <h2 className="mt-1 text-xl font-bold tracking-[-0.01em] text-text-bright">{sectionTitle}</h2>
          </div>
          {saved && (
            <span
              data-testid="save-status"
              className="shrink-0 font-mono text-[10.5px] tracking-[0.06em] text-[rgba(160,190,225,.55)]"
            >
              saved · just now
            </span>
          )}
        </div>

        {/* Tags & rules brings a second fixed column with it (1e: nav 240 ·
            tags 330 · rules), so the body's tracks are the section's too. */}
        <div
          className={[
            'grid min-h-0 flex-1',
            section === 'tags'
              ? 'grid-cols-[240px_minmax(0,330px)_minmax(0,1fr)]'
              : 'grid-cols-[240px_minmax(0,1fr)]',
          ].join(' ')}
        >
          {/* Nav column: 240px, 16px/12px padding, 2px row gap (canvas 1h). */}
          <nav
            className="flex flex-col gap-0.5 border-r border-[rgba(150,205,255,.1)] px-3 py-4"
            aria-label="Settings sections"
          >
            {NAV_ITEMS.map((item) => (
              <button
                key={item.key}
                type="button"
                disabled={item.disabled}
                aria-current={item.key === section ? 'true' : undefined}
                title={item.disabled ? 'coming soon' : undefined}
                onClick={item.disabled ? undefined : () => setSection(item.key)}
                className={[
                  NAV_ROW,
                  item.key === section
                    ? 'border-panel-border bg-[rgba(150,205,255,.08)] font-semibold text-text-bright'
                    : 'border-transparent font-medium text-[rgba(220,235,255,.8)]',
                  item.disabled ? 'cursor-default' : 'hover:bg-white/5',
                ].join(' ')}
              >
                {item.label}
              </button>
            ))}
            <span className="flex-1" />
            <div className="px-3 py-2.5 font-mono text-[10px] leading-[1.6] text-[rgba(160,190,225,.45)]">
              <div>orbital {pkg.version}</div>
              {claudeCodeVersion && <div>claude-code {claudeCodeVersion}</div>}
            </div>
          </nav>

          {section === 'tags' ? (
            <TagsRulesSection active onSaved={() => setSaved(true)} />
          ) : (
          /* Content column: 8/32/20 padding per canvas 1h. Only Sessions can
             be selected besides Tags & rules, so this column is the other
             branch outright. The project-dir draft lives in `Settings`, not
             here, so swapping the column away costs no state. */
          <div className="flex min-h-0 flex-col overflow-y-auto px-8 pb-5 pt-2">
            <SectionLabel first>NEW SESSIONS</SectionLabel>
            <Row
              title="Default model"
              desc="Pre-selected in the New session dialog and used by Clear. Never changes a running session."
            >
              <ModelCards
                compact
                models={models}
                value={defaultModel || null}
                onChange={(value) => void patchAndSet({ default_model: value })}
              />
              <Checkbox
                label="Remember last model per project"
                checked={rememberModelPerProject}
                onChange={(checked) =>
                  void patchAndSet({ remember_model_per_project: String(checked) })
                }
              />
            </Row>
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
                options={IDLE_OPTIONS}
                value={endedAfterIdle}
                onChange={(next) => void patchAndSet({ ended_after_idle_minutes: next })}
                className="w-[200px]"
              />
            </Row>
            <Row
              title="Stop drawing ended sessions after"
              desc="Older history stays in the sidebar and in search — it just leaves the map."
            >
              <Select
                id="settings-map-ended-age"
                aria-label="Stop drawing ended sessions after"
                font="sans"
                options={ENDED_AGE_OPTIONS}
                value={mapEndedMaxAge}
                onChange={(next) => void patchAndSet({ map_ended_max_age_days: next })}
                className="w-[200px]"
              />
            </Row>
            {/* canvas 4c: MAP section, beside the map row above. */}
            <Row
              title="Model name under planet label"
              desc="Family only (no version)."
            >
              <div className="flex items-center gap-3">
                <Toggle
                  aria-label="Model name under planet label"
                  checked={mapShowModel}
                  onChange={(checked) => void patchAndSet({ map_show_model: checked ? 'true' : 'false' })}
                />
                {/* canvas 4c: sample chip beside the toggle, JetBrains Mono
                    9.5px/.1em tracking, rgba(160,190,225,.7). */}
                {mapModelSample && (
                  <span
                    data-testid="map-model-sample"
                    className="font-mono text-[9.5px] tracking-[0.1em] text-[rgba(160,190,225,.7)]"
                  >
                    {mapModelSample}
                  </span>
                )}
              </div>
            </Row>
          </div>
          )}
        </div>
      </Panel>
      </div>
    </div>
    </EscapeBoundary>
  )
}
