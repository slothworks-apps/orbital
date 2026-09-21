import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  useOrbital,
  parsePlanetScale,
  PLANET_SCALE_MAX,
  PLANET_SCALE_MIN,
  parseContextThresholds,
  showContext,
  showCompactBadge,
  CONTEXT_THRESHOLD_MIN,
  CONTEXT_THRESHOLD_MAX,
} from '../store/store'
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
/**
 * The Clusters release delay (spec 2026-09-18-tag-clusters-design § 6):
 * how long an ended session keeps its tag bond on the map before it falls
 * into the corner hole. Stored in minutes; 2h is the canvas 4b default.
 */
const RELEASE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '30', label: '30 minutes' },
  { value: '120', label: '2 hours' },
  { value: '480', label: '8 hours' },
  { value: '1440', label: '1 day' },
  { value: 'never', label: 'Never — keep them bonded' },
]

/**
 * The nav, in canvas order. Three sections are live: "Sessions" (1h),
 * "Tags & rules" (1e — the same dialog with the 4th row selected, not a
 * screen of its own, which is why it is a section here rather than a link)
 * and "Appearance" (5a, `Feature - Planet size.dc.html`). The rest are drawn
 * but inert until they have something to hold.
 */
const NAV_ITEMS = [
  { key: 'general', label: 'General', disabled: true },
  { key: 'sessions', label: 'Sessions', disabled: false },
  { key: 'permissions', label: 'Permissions', disabled: true },
  { key: 'tags', label: 'Tags & rules', disabled: false },
  { key: 'appearance', label: 'Appearance', disabled: false },
  { key: 'shortcuts', label: 'Shortcuts', disabled: true },
] as const

type SectionKey = (typeof NAV_ITEMS)[number]['key']

/** Debounce for the free-text fields — the rest of this panel's controls
 * (cards, segmented steps, toggles, selects) are discrete clicks and PATCH
 * immediately. */
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

/**
 * The Appearance preview's three size tiers, transcribed from canvas 5a
 * (ended · live · live with subagents). `base` is the 1.00× diameter in px,
 * `capK` the canvas's caption-gap coefficient (`margin-top = base × scale ×
 * capK + 8`). The tick ring is the artboard's `repeating-conic-gradient`
 * masked to a band `mask[0]`/`mask[1]` px inside the edge; the lg tier's
 * ring spin is left out — a settings illustration, not the map.
 */
const PREVIEW_TIERS = [
  {
    base: 34,
    capK: 0.24,
    inset: '-22%',
    dim: true,
    ring: 'repeating-conic-gradient(rgba(200,215,235,.4) 0 2deg, transparent 2deg 12deg)',
    mask: [3, 2],
    body: 'oklch(16% .01 230)',
    border: '1px solid rgba(200,215,235,.35)',
    core: null as string | null,
    shadow: undefined as string | undefined,
  },
  {
    base: 60,
    capK: 0.24,
    inset: '-22%',
    dim: false,
    ring: 'repeating-conic-gradient(oklch(80% .13 210 / .45) 0 1.5deg, transparent 1.5deg 8deg)',
    mask: [5, 4],
    body: 'radial-gradient(circle at 50% 45%, oklch(28% .05 220), oklch(18% .04 225) 70%)',
    border: '1px solid oklch(80% .13 210 / .45)',
    core: 'oklch(80% .13 210 / .8)',
    shadow: undefined,
  },
  {
    base: 92,
    capK: 0.28,
    inset: '-26%',
    dim: false,
    ring: 'repeating-conic-gradient(oklch(80% .13 60 / .5) 0 1.2deg, transparent 1.2deg 6deg)',
    mask: [6, 5],
    body: 'radial-gradient(circle at 50% 45%, oklch(30% .05 220), oklch(20% .04 225) 70%, oklch(16% .03 230))',
    border: '1px solid oklch(80% .13 60 / .6)',
    core: 'oklch(80% .13 60 / .85)',
    shadow: '0 0 22px oklch(80% .13 60 / .25), inset 0 0 0 5px rgba(0,0,0,.25)',
  },
]

/** One mock body of the Appearance preview (canvas 5a), sized to the live scale. */
function PreviewTier({ tier, scale }: { tier: (typeof PREVIEW_TIERS)[number]; scale: number }) {
  const size = Math.round(tier.base * scale)
  const maskCss = `radial-gradient(farthest-side, transparent calc(100% - ${tier.mask[0]}px), #000 calc(100% - ${tier.mask[1]}px))`
  return (
    <div className="flex flex-none flex-col items-center">
      <div
        className="relative transition-[width,height] duration-[180ms] ease-out"
        style={{ width: size, height: size, opacity: tier.dim ? 0.6 : undefined }}
      >
        <span
          aria-hidden
          className="absolute block rounded-full"
          style={{ inset: tier.inset, background: tier.ring, maskImage: maskCss, WebkitMaskImage: maskCss }}
        />
        <span
          aria-hidden
          className="absolute inset-0 block rounded-full"
          style={{ background: tier.body, border: tier.border, boxShadow: tier.shadow }}
        />
        {tier.core && (
          <span
            aria-hidden
            className="absolute left-1/2 top-1/2 block h-[16%] w-[16%] -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ background: tier.core }}
          />
        )}
      </div>
      <div
        className="font-mono text-[10px] tracking-[0.06em] text-[rgba(160,190,225,.6)]"
        style={{ marginTop: Math.round(tier.base * scale * tier.capK + 8) }}
      >
        {size}px
      </div>
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
  const [cliPathDraft, setCliPathDraft] = useState(settings.claude_executable_path ?? '')
  const [saved, setSaved] = useState(false)
  const [section, setSection] = useState<SectionKey>('sessions')
  // Appearance preview (canvas 5a): open by default, collapse state lives
  // only for the dialog's visit — deliberately not persisted (spec).
  const [previewOpen, setPreviewOpen] = useState(true)

  useEffect(() => {
    if (!open) return
    // Every visit starts on Sessions, and with no stale "saved · just now"
    // left over from the last one — the dialog is held mounted across `open`.
    setSection('sessions')
    setSaved(false)
    setPreviewOpen(true)
  }, [open])

  useEffect(() => {
    if (!open) return
    setProjectDirDraft(settings.default_project_dir ?? '')
    setCliPathDraft(settings.claude_executable_path ?? '')
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

  /**
   * The planet-size slider is the one continuous control in here, so the
   * panel's await-then-update rule (made for discrete clicks) does not apply:
   * the store gets the value IMMEDIATELY — the map behind the dialog rescales
   * live, no Apply (canvas 5a) — and the PATCH is debounced. A failed save is
   * recorded, and the optimistic value stands until reload (spec:
   * 2026-09-18-planet-size-design).
   */
  const scaleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (scaleTimerRef.current) clearTimeout(scaleTimerRef.current)
    },
    []
  )

  function setPlanetScale(next: number) {
    const clamped = Math.min(PLANET_SCALE_MAX, Math.max(PLANET_SCALE_MIN, next))
    const value = String(Math.round(clamped * 100) / 100)
    useOrbital.setState((state) => ({ settings: { ...state.settings, planet_scale: value } }))
    if (scaleTimerRef.current) clearTimeout(scaleTimerRef.current)
    scaleTimerRef.current = setTimeout(() => {
      void patchAndSet({ planet_scale: value })
    }, DEBOUNCE_MS)
  }

  /** Canvas 5b keyboard spec: ←/→ one step (native), ⇧ five, Home = 1.00×
   * (native Home would jump to the minimum instead). */
  function handleScaleKeys(e: ReactKeyboardEvent<HTMLInputElement>, current: number) {
    if (e.key === 'Home') {
      e.preventDefault()
      setPlanetScale(1)
    } else if (e.shiftKey && (e.key === 'ArrowRight' || e.key === 'ArrowUp')) {
      e.preventDefault()
      setPlanetScale(current + 0.25)
    } else if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowDown')) {
      e.preventDefault()
      setPlanetScale(current - 0.25)
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

  // Same draft-then-debounce treatment for the CLI override (spec
  // 2026-09-16-electron-wrapper-design § 3), the panel's other free-text field.
  useEffect(() => {
    if (!open) return
    if (cliPathDraft === (settings.claude_executable_path ?? '')) return
    const timer = setTimeout(() => {
      void patchAndSet({ claude_executable_path: cliPathDraft })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cliPathDraft, open])

  /**
   * Context thresholds (canvas 1h, spec context-fill-arc): typed number
   * fields, so they get the project-dir field's draft-then-debounce
   * treatment rather than PATCHing on every keystroke. An out-of-range or
   * inverted (`warn >= critical`) pair is never sent — the parser's
   * fall-back-to-defaults is a last resort for garbage already in the
   * database, not something the UI should invite by saving one; the old
   * stored values simply stand until a valid pair is typed.
   */
  const [warnDraft, setWarnDraft] = useState(String(parseContextThresholds(settings).warn))
  const [criticalDraft, setCriticalDraft] = useState(String(parseContextThresholds(settings).critical))

  useEffect(() => {
    if (!open) return
    const thresholds = parseContextThresholds(settings)
    setWarnDraft(String(thresholds.warn))
    setCriticalDraft(String(thresholds.critical))
    // Only reseed on open, same reasoning as the project-dir draft above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const warn = Number(warnDraft)
    const critical = Number(criticalDraft)
    const valid =
      Number.isInteger(warn) &&
      Number.isInteger(critical) &&
      warn >= CONTEXT_THRESHOLD_MIN &&
      warn <= CONTEXT_THRESHOLD_MAX &&
      critical >= CONTEXT_THRESHOLD_MIN &&
      critical <= CONTEXT_THRESHOLD_MAX &&
      warn < critical
    if (!valid) return
    // Compare against the parsed (already-defaulted) thresholds, not the raw
    // keys — a settings object with the keys simply absent parses to the
    // same 50/80 the drafts start at, and must not read as "changed".
    const current = parseContextThresholds(settings)
    if (warn === current.warn && critical === current.critical) return
    const timer = setTimeout(() => {
      void patchAndSet({
        context_threshold_warn: String(warn),
        context_threshold_critical: String(critical),
      })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warnDraft, criticalDraft, open])

  // Closes the dialog. A rule row open inside Tags & rules registers a deeper
  // layer and is peeled first (see `TagsRulesSection`).
  useEscapeLayer(open, onClose)
  // Held mounted through the close transition (see `ui/usePresence`).
  const { mounted, state: presence } = usePresence(open, MODAL_ENTER_MS, MODAL_EXIT_MS)

  const sectionTitle = NAV_ITEMS.find((item) => item.key === section)?.label ?? 'Sessions'

  const defaultPermissionMode = ((settings.default_permission_mode as PermissionMode) || 'acceptEdits')
  const lineageDepth = settings.lineage_depth ?? '3'
  const confirmBeforeClear = settings.confirm_before_clear !== 'false'
  // Opt-in, so the default is the absent key reading as off — the opposite of
  // every `!== 'false'` above it.
  const autoTitleSessions = settings.auto_title_sessions === 'true'
  const inheritTags = settings.inherit_tags !== 'false'
  const inheritPermissionMode = settings.inherit_permission_mode !== 'false'
  const endedAfterIdle = settings.ended_after_idle_minutes ?? '30'
  const releaseEndedAfter = settings.map_release_ended_after_minutes ?? '120'
  // `default_model` is a value, not a flag — a missing key means "no
  // preference yet", not "off", so it reads as `null` rather than a default.
  const defaultModel = settings.default_model ?? ''
  const rememberModelPerProject = settings.remember_model_per_project !== 'false'
  const mapShowModel = settings.map_show_model !== 'false'
  // Context-fill arc (canvas 1h, spec context-fill-arc): master switch and
  // the /compact badge sub-toggle, both default-on.
  const mapShowContext = showContext(settings)
  const mapShowCompactBadge = showCompactBadge(settings)
  // Appearance (canvas 5a).
  const planetScale = parsePlanetScale(settings)
  const mapScaleLabels = settings.map_scale_labels === 'true'
  const scaleNote =
    planetScale === 1 ? 'default' : planetScale > 1 ? 'larger bodies · fewer per screen' : 'denser map'
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
          ) : section === 'appearance' ? (
            /* Appearance (canvas 5a): MAP kicker, the planet-size slider, the
               collapsible preview and the labels toggle. */
            <div className="flex min-h-0 flex-col overflow-y-auto px-8 pb-5 pt-2">
              <SectionLabel first>MAP</SectionLabel>
              <Row
                title="Default planet size"
                desc="Baseline scale for every body on the map. Tier differences are preserved — this multiplies the whole family. Orbit radii and zoom are unaffected."
              >
                <div className="flex w-full flex-col gap-[9px]">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-[15px] text-text-bright">
                      {planetScale.toFixed(2)}×
                    </span>
                    <span className="font-mono text-[10.5px] text-[rgba(160,190,225,.6)]">
                      {scaleNote}
                    </span>
                    <span className="flex-1" />
                    <button
                      type="button"
                      onClick={() => setPlanetScale(1)}
                      className="rounded-full border border-[rgba(150,205,255,.14)] px-[9px] py-[3px] font-mono text-[10px] tracking-[0.1em] text-[rgba(178,203,230,.85)] transition-colors hover:border-[rgba(150,205,255,.26)] hover:bg-[rgba(150,205,255,.07)] hover:text-[#dce8f7]"
                    >
                      RESET
                    </button>
                  </div>
                  <input
                    type="range"
                    min={70}
                    max={160}
                    step={5}
                    value={Math.round(planetScale * 100)}
                    aria-label="Default planet size"
                    onChange={(e) => setPlanetScale(Number(e.target.value) / 100)}
                    onKeyDown={(e) => handleScaleKeys(e, planetScale)}
                    className="h-[18px] w-full cursor-grab accent-accent"
                  />
                  <div className="flex justify-between font-mono text-[10px] tracking-[0.06em] text-[rgba(160,190,225,.55)]">
                    <span>0.70×</span>
                    <span>1.00×</span>
                    <span>1.60×</span>
                  </div>
                </div>
              </Row>

              {/* Collapsible preview row (canvas 5a): full-width header
                  button, the tier strip animates shut instead of unmounting. */}
              <div className="flex flex-col gap-3 border-t border-[rgba(150,205,255,.08)] py-[13px]">
                <button
                  type="button"
                  aria-expanded={previewOpen}
                  onClick={() => setPreviewOpen((v) => !v)}
                  className="flex items-start gap-2.5 text-left"
                >
                  <span
                    aria-hidden
                    className="mt-[1px] grid h-4 w-4 flex-none place-items-center text-[9px] text-[rgba(160,190,225,.7)] transition-transform duration-[180ms]"
                    style={{ transform: previewOpen ? undefined : 'rotate(-90deg)' }}
                  >
                    ▾
                  </span>
                  <span className="flex-1">
                    <span className="flex items-center gap-2">
                      <span className="text-[13.5px] font-semibold text-text-bright">Preview</span>
                      {!previewOpen && (
                        <span className="font-mono text-[10px] tracking-[0.1em] text-[rgba(160,190,225,.55)]">
                          collapsed
                        </span>
                      )}
                    </span>
                    <span className="mt-1 block text-[12px] leading-[1.5] text-[rgba(160,190,225,.7)] [text-wrap:pretty]">
                      The three size tiers at the current scale: ended, live, live with subagents.
                      Labels keep their 10 px mono floor at every scale.
                    </span>
                  </span>
                </button>
                <div
                  className="box-border flex items-center justify-around gap-7 overflow-hidden rounded-[10px] border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.5)]"
                  style={{
                    height: previewOpen ? 300 : 0,
                    opacity: previewOpen ? 1 : 0,
                    padding: previewOpen ? '24px 28px' : '0px 28px',
                    borderStyle: 'solid',
                    borderWidth: previewOpen ? 1 : 0,
                    transition:
                      'height .22s cubic-bezier(.2,.9,.25,1), opacity .18s ease, padding .22s ease',
                  }}
                >
                  {PREVIEW_TIERS.map((tier) => (
                    <PreviewTier key={tier.base} tier={tier} scale={planetScale} />
                  ))}
                </div>
              </div>

              <Row
                title="Scale labels with bodies"
                desc="Off keeps session names at 11 px mono regardless of scale — better for dense maps at 1.40× and above."
              >
                <Toggle
                  aria-label="Scale labels with bodies"
                  checked={mapScaleLabels}
                  onChange={(checked) =>
                    void patchAndSet({ map_scale_labels: checked ? 'true' : 'false' })
                  }
                />
              </Row>
            </div>
          ) : (
          /* Content column: 8/32/20 padding per canvas 1h. Only Sessions can
             be selected besides Tags & rules and Appearance, so this column
             is the remaining branch outright. The project-dir draft lives in
             `Settings`, not here, so swapping the column away costs no state. */
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
            {/* Spec 2026-09-16-electron-wrapper-design § 3: empty autodetects,
                a value overrides. The server reads the key once, at boot, so
                this row must not imply the change reaches a running one. */}
            <Row
              title="Claude Code executable"
              desc="Leave empty to autodetect it from your PATH. A path here overrides the search for sessions started afterwards — the server reads it when it starts, so restart Orbital to apply a change."
            >
              <Input
                id="settings-claude-executable-path"
                aria-label="Claude Code executable"
                font="mono"
                size="sm"
                value={cliPathDraft}
                onChange={(e) => setCliPathDraft(e.target.value)}
                placeholder="autodetect"
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
            <Row
              title="Generate session titles from content"
              desc="Renames a running session when its subject moves. Each rename costs a small model call."
            >
              <Toggle
                aria-label="Generate session titles from content"
                checked={autoTitleSessions}
                onChange={(checked) =>
                  void patchAndSet({ auto_title_sessions: checked ? 'true' : 'false' })
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
            {/* Clusters (canvas 4b's "Settings → Sessions → Clusters"): the
                one control over the hole's timed absorption. Replaces both
                the old age cutoff and the ENDED map toggle. */}
            <Row
              title="Release ended sessions into history after"
              // The clause from 4d's string table: this is the one screen
              // where the timer looks absolute, so it is where the exemption
              // has to be named.
              desc="The bond is cut and the body falls into the corner hole. It stays in the sidebar and in search — it just leaves the map — pinned sessions are never released."
            >
              <Select
                id="settings-release-ended-after"
                aria-label="Release ended sessions into history after"
                font="sans"
                options={RELEASE_OPTIONS}
                value={releaseEndedAfter}
                onChange={(next) => void patchAndSet({ map_release_ended_after_minutes: next })}
                className="w-[200px]"
              />
            </Row>
            {/* canvas 4c/1h: MAP section. */}
            <SectionLabel>MAP</SectionLabel>
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
            {/* canvas 1h: master switch for the arc, its ticks and the
                /compact badge (spec context-fill-arc). Not itself in the
                canvas — 1h's "Planet size: Context/Fixed" radio is the
                control it replaces, per the scope cut agreed with the
                owner. */}
            <Row
              title="Context usage on planets"
              desc="A thin arc around each running web session showing how full its context window is. Terminal sessions have no usage data and never show one."
            >
              <Toggle
                aria-label="Context usage on planets"
                checked={mapShowContext}
                onChange={(checked) => void patchAndSet({ map_show_context: checked ? 'true' : 'false' })}
              />
            </Row>
            {/* canvas 1h "Context thresholds" row verbatim, minus the
                Planet-size radio above it (out of scope). Colour dashes use
                the same three OKLCH literals as the arc itself and the
                Appearance preview elsewhere in this file: ok-level blue
                (`PREVIEW_TIERS`'s live tier, oklch(80% .13 210)), the amber
                of its subagent tier (oklch(80% .13 60)), and the spec's
                critical red (oklch(72% .17 25)). */}
            <Row
              title="Context thresholds"
              desc="Arc turns amber above the first, red + pulse above the second. Sidebar rows and the /compact badge follow the same values."
            >
              <div className="flex items-center gap-3.5">
                <span aria-hidden className="h-[2px] w-[26px]" style={{ background: 'oklch(80% .13 210 / .6)' }} />
                <label className="flex items-center gap-1.5 font-mono text-xs text-[rgba(160,190,225,.7)]">
                  <Input
                    id="settings-context-threshold-warn"
                    aria-label="Warn threshold"
                    font="mono"
                    size="sm"
                    type="number"
                    min={CONTEXT_THRESHOLD_MIN}
                    max={CONTEXT_THRESHOLD_MAX}
                    value={warnDraft}
                    onChange={(e) => setWarnDraft(e.target.value)}
                    className="w-[52px] text-center"
                  />
                  %
                </label>
                <span aria-hidden className="h-[2px] w-[26px]" style={{ background: 'oklch(80% .13 60)' }} />
                <label className="flex items-center gap-1.5 font-mono text-xs text-[rgba(160,190,225,.7)]">
                  <Input
                    id="settings-context-threshold-critical"
                    aria-label="Critical threshold"
                    font="mono"
                    size="sm"
                    type="number"
                    min={CONTEXT_THRESHOLD_MIN}
                    max={CONTEXT_THRESHOLD_MAX}
                    value={criticalDraft}
                    onChange={(e) => setCriticalDraft(e.target.value)}
                    className="w-[52px] text-center"
                  />
                  %
                </label>
                {/* canvas 1h: no literal name for this critical dash — the
                    spec's own colour for fill > T2. */}
                <span aria-hidden className="h-[2px] w-[26px]" style={{ background: 'oklch(72% .17 25)' }} />
              </div>
              <Checkbox
                checked={mapShowCompactBadge}
                onChange={(checked) =>
                  void patchAndSet({ map_show_compact_badge: checked ? 'true' : 'false' })
                }
                label={'Show “/compact” badge above the second threshold'}
              />
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
