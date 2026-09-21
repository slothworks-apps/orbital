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
import { api, type ServerHealth } from '../lib/api'
import { reportError } from '../lib/errors'
import { notifyDesktopSettingsChanged } from '../lib/desktop'
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
/**
 * Settings → General → "Delete sessions older than" (spec
 * 2026-09-21-settings-sections-design § 4). `never` is first and is the
 * default: this is the one row in the dialog that destroys anything, so the
 * off position is where it starts and where it can always be put back.
 */
const RETENTION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'never', label: 'Never — keep everything' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
]

const RELEASE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '30', label: '30 minutes' },
  { value: '120', label: '2 hours' },
  { value: '480', label: '8 hours' },
  { value: '1440', label: '1 day' },
  { value: 'never', label: 'Never — keep them bonded' },
]

/**
 * The nav, in canvas order plus "Notifications", which the canvas does not
 * have yet (spec 2026-09-21-settings-sections-design § 1). It is inserted
 * after Sessions because every event it governs is a session event, and
 * every other row keeps the position 1h gives it.
 *
 * Only "Permissions" and "Shortcuts" are still inert. General is missing its
 * STARTUP & WINDOW group, which waits on behaviour `desktop/` does not have
 * yet ([[desktop-startup-window-and-updates]]), and its retention row, which
 * waits on a design question the indexer raises — see the spec's § 4.
 */
const NAV_ITEMS = [
  { key: 'general', label: 'General', disabled: false },
  { key: 'sessions', label: 'Sessions', disabled: false },
  { key: 'notifications', label: 'Notifications', disabled: false },
  { key: 'permissions', label: 'Permissions', disabled: true },
  { key: 'tags', label: 'Tags & rules', disabled: false },
  { key: 'appearance', label: 'Appearance', disabled: false },
  { key: 'shortcuts', label: 'Shortcuts', disabled: true },
] as const

type SectionKey = (typeof NAV_ITEMS)[number]['key']

/**
 * Which section a visit opens on. The dialog used to hard-code "Sessions"
 * because it was the only live one; with seven nav rows that is no longer a
 * default, it is a guess, so the last section the user chose is remembered
 * instead — stored in the settings table alongside `sidebar_collapsed` and
 * `sidebar_width`, the panel states that already persist that way.
 *
 * Anything unrecognised falls back to the nav's first row. That covers a key
 * from a future build, a hand-edited database, and the case that will
 * actually happen: a section that was live when it was stored and has since
 * been disabled, which must not strand the user on an inert page.
 */
export function initialSection(settings: Record<string, string | undefined>): SectionKey {
  const stored = settings.settings_last_section
  const match = NAV_ITEMS.find((item) => item.key === stored)
  return match && !match.disabled ? match.key : NAV_ITEMS[0].key
}

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
  const [claudeDirDraft, setClaudeDirDraft] = useState(settings.claude_directory ?? '')
  /**
   * Facts about how the server was started, for General's read-only rows.
   * Null until the fetch lands and after a failure — those rows simply do not
   * draw rather than showing a placeholder that could be mistaken for a real
   * path or a real billing mode.
   */
  const [health, setHealth] = useState<ServerHealth | null>(null)
  const [copiedPath, setCopiedPath] = useState(false)
  /**
   * The retention confirmation. Held as the pending value plus the count the
   * server says it would take, so the prompt can name a real number rather
   * than "some sessions" — and so nothing is saved until it is answered.
   */
  const [retentionPrompt, setRetentionPrompt] = useState<{ value: string; count: number } | null>(
    null,
  )
  const [saved, setSaved] = useState(false)
  const [section, setSection] = useState<SectionKey>(() => initialSection(settings))
  // Appearance preview (canvas 5a): open by default, collapse state lives
  // only for the dialog's visit — deliberately not persisted (spec).
  const [previewOpen, setPreviewOpen] = useState(true)

  useEffect(() => {
    if (!open) return
    // Every visit resumes where the last one left off, and starts with no
    // stale "saved · just now" — the dialog is held mounted across `open`.
    setSection(initialSection(useOrbital.getState().settings))
    setSaved(false)
    setPreviewOpen(true)
    // `settings` deliberately absent: this reseeds per visit, and reading it
    // through `getState` keeps a PATCH landing mid-visit from yanking the
    // user out of the section they are looking at.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    setProjectDirDraft(settings.default_project_dir ?? '')
    setCliPathDraft(settings.claude_executable_path ?? '')
    setClaudeDirDraft(settings.claude_directory ?? '')
    // Only reseed on open — an in-flight PATCH from a prior keystroke resolving
    // must not fight the user's current typing while the panel stays open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  async function patchAndSet(patch: Record<string, string>) {
    try {
      await api.patchSettings(patch)
      useOrbital.setState((state) => ({ settings: { ...state.settings, ...patch } }))
      setSaved(true)
      // Only this dialog can change the notification rows, and the main
      // process cannot see a PATCH — the settings table is not a WebSocket
      // topic. Told here rather than inside `api.patchSettings` so the
      // sidebar's own writes do not make it re-read for nothing.
      notifyDesktopSettingsChanged()
    } catch (err) {
      reportError(err, 'Failed to save settings')
    }
  }

  /**
   * Picking a retention policy. Turning it OFF, or picking one that would
   * take nothing, saves straight away — there is nothing to warn about. Any
   * other choice asks first, naming the count the server just worked out.
   *
   * If the preview cannot be fetched we still ask, with the count unknown:
   * failing open on a destructive setting would be the wrong way round, and
   * failing closed would make the row unusable whenever the server is busy.
   */
  async function chooseRetention(value: string) {
    if (value === 'never') {
      await patchAndSet({ delete_sessions_older_than_days: value })
      return
    }
    const count = await api
      .previewRetention(value)
      .then((r) => r?.count ?? -1)
      .catch(() => -1)
    if (count === 0) {
      await patchAndSet({ delete_sessions_older_than_days: value })
      return
    }
    setRetentionPrompt({ value, count })
  }

  /**
   * Nav clicks. Deliberately NOT `patchAndSet`: moving between sections is
   * navigation, and flashing "saved · just now" for it would claim the user
   * changed a preference they did not touch. The section is shown
   * immediately and the write is fire-and-forget — a failed one costs the
   * next visit its starting section and nothing else, which is not worth an
   * error toast.
   */
  function selectSection(key: SectionKey) {
    setSection(key)
    useOrbital.setState((state) => ({
      settings: { ...state.settings, settings_last_section: key },
    }))
    void api.patchSettings({ settings_last_section: key }).catch(() => {})
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

  // And the third: General's Claude directory.
  useEffect(() => {
    if (!open) return
    if (claudeDirDraft === (settings.claude_directory ?? '')) return
    const timer = setTimeout(() => {
      void patchAndSet({ claude_directory: claudeDirDraft })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claudeDirDraft, open])

  // General's read-only rows. Fetched per visit rather than kept in the store:
  // nothing else reads them, and a value from before a server restart would
  // be worse than no value at all. A failure leaves `health` null and the
  // rows unrendered — see the state's comment.
  useEffect(() => {
    if (!open) return
    let live = true
    api
      .getHealth()
      .then((info) => {
        // Only a real answer touches state. Setting null on an empty or
        // failed read would be a state update that changes nothing — the
        // rows are already unrendered — and React would rightly complain
        // about it landing after the component went away.
        if (live && info) setHealth(info)
      })
      .catch(() => {
        /* rows stay unrendered; see the state's comment */
      })
    return () => {
      live = false
    }
  }, [open])

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
  // Off unless the stored value is one of the offered policies: an absent or
  // unreadable row must show as "Never", the same way the server parses it.
  const storedRetention = settings.delete_sessions_older_than_days ?? 'never'
  const deleteOlderThan = RETENTION_OPTIONS.some((o) => o.value === storedRetention)
    ? storedRetention
    : 'never'
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
  /**
   * Notifications (spec 2026-09-21-settings-sections-design § 5). Every one
   * of these reads default-on, because that is what the desktop app does
   * today with no settings at all: the three events fire unconditionally,
   * the focus check in `main.ts` is unconditional, and `silent` is never
   * set. An absent key must therefore mean "as before", not "off".
   */
  const notifyNeedsInput = settings.notify_needs_input !== 'false'
  const notifySessionEnded = settings.notify_session_ended !== 'false'
  const notifySessionFailed = settings.notify_session_failed !== 'false'
  const notifyOnlyWhenBackground = settings.notify_only_when_background !== 'false'
  const notifySound = settings.notify_sound !== 'false'
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
                onClick={item.disabled ? undefined : () => selectSection(item.key)}
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

          {/* Tags & rules brings its own two columns; every other section is
              a list of rows in the one content column below (8/32/20 padding,
              canvas 1h). Flat `&&` blocks rather than a ternary chain: with
              five sections a nested conditional stops being readable, and
              only one of them is ever mounted, so their order here is not the
              nav's. */}
          {section === 'tags' ? (
            <TagsRulesSection active onSaved={() => setSaved(true)} />
          ) : (
          <div className="flex min-h-0 flex-col overflow-y-auto px-8 pb-5 pt-2">
            {section === 'general' && (
              <>
                <SectionLabel first>RUNTIME</SectionLabel>
                {/* Spec 2026-09-16-electron-wrapper-design § 3: empty
                    autodetects, a value overrides. Moved here out of NEW
                    SESSIONS, where it never belonged — it is an install path
                    the server reads once at boot, not a session default
                    (adr settings-sections-split-by-kind). The row must not
                    imply the change reaches a running session. */}
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
                {/* `ORBITAL_CLAUDE_DIR` already overrode this; the row is what
                    makes it reachable without a shell. Same restart caveat as
                    the executable — `resolveClaudeDir` runs once, at boot. */}
                <Row
                  title="Claude directory"
                  desc="Where Orbital watches for the CLI's sessions. Leave empty for ~/.claude. The server reads it when it starts, so restart Orbital to apply a change — and ORBITAL_CLAUDE_DIR, if set, wins over this."
                >
                  <Input
                    id="settings-claude-directory"
                    aria-label="Claude directory"
                    font="mono"
                    size="sm"
                    value={claudeDirDraft}
                    onChange={(e) => setClaudeDirDraft(e.target.value)}
                    placeholder="~/.claude"
                    className="w-full"
                  />
                  {/* What is actually being watched, which is not always what
                      this field holds: the env var outranks it, and an empty
                      field means the default. */}
                  {health?.paths?.claudeDir && (
                    <span
                      data-testid="claude-dir-effective"
                      className="font-mono text-[10px] leading-[1.5] text-[rgba(160,190,225,.55)]"
                    >
                      watching {health.paths.claudeDir}
                    </span>
                  )}
                </Row>
                {/* Read-only on purpose: this is an environment decision made
                    when the server started, and a toggle for "start charging
                    my card" is not a toggle. */}
                {health?.billing && (
                  <Row
                    title="Billing"
                    desc="How the sessions Orbital spawns are paid for. Set by the environment the server starts in, not from here."
                  >
                    <span
                      data-testid="billing-mode"
                      className="font-mono text-[11.5px] text-text-bright"
                    >
                      {health.billing === 'api-key' ? 'API key' : 'Claude subscription'}
                    </span>
                    <span className="text-[12px] leading-[1.5] text-[rgba(160,190,225,.7)] [text-wrap:pretty]">
                      {health.billing === 'api-key'
                        ? 'ORBITAL_USE_API_KEY=1 is set, so ANTHROPIC_API_KEY is left in the server’s environment and usage is billed to that key.'
                        : 'ANTHROPIC_API_KEY is removed from the server’s environment at startup, so sessions bill your subscription the way the CLI does.'}
                    </span>
                  </Row>
                )}

                {/* The kicker is unconditional — the retention row below it
                    needs no server facts — but the Database row only draws
                    once a real path has arrived. */}
                <SectionLabel>DATA</SectionLabel>
                {health?.paths?.dbPath && (
                  <>
                    <Row
                      title="Database"
                      desc="Orbital's own index of your sessions. Your transcripts are not in here — they stay in the Claude directory above, which Orbital only ever reads."
                    >
                      <span className="break-all font-mono text-[11px] leading-[1.6] text-[rgba(200,220,245,.8)]">
                        {health.paths.dbPath}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          const path = health.paths?.dbPath
                          if (!path) return
                          // Best-effort: `navigator.clipboard` needs a secure
                          // context, which 127.0.0.1 is, but the desktop
                          // shell is the likelier home for a real reveal.
                          void navigator.clipboard
                            ?.writeText(path)
                            .then(() => setCopiedPath(true))
                            .catch(() => {})
                        }}
                        className="rounded-full border border-[rgba(150,205,255,.14)] px-[9px] py-[3px] font-mono text-[10px] tracking-[0.1em] text-[rgba(178,203,230,.85)] transition-colors hover:border-[rgba(150,205,255,.26)] hover:bg-[rgba(150,205,255,.07)] hover:text-[#dce8f7]"
                      >
                        {copiedPath ? 'COPIED' : 'COPY PATH'}
                      </button>
                    </Row>
                  </>
                )}

                {/* The one row in this dialog that destroys anything. The
                    description has to carry the distinction the whole design
                    rests on: index rows go, transcripts do not. */}
                <Row
                  title="Delete sessions older than"
                  desc="Removes them from Orbital's index. Your transcripts stay in the Claude directory — Orbital only ever reads it — but a deleted session leaves the map, the sidebar and search. Pinned sessions are never deleted."
                >
                  <Select
                    id="settings-delete-older-than"
                    aria-label="Delete sessions older than"
                    font="sans"
                    options={RETENTION_OPTIONS}
                    value={deleteOlderThan}
                    onChange={(next) => void chooseRetention(next)}
                    className="w-[220px]"
                  />
                  {retentionPrompt && (
                    <div
                      data-testid="retention-confirm"
                      className="flex w-full flex-col gap-2.5 rounded-[10px] border border-[oklch(72%_.17_25_/_.35)] bg-[oklch(72%_.17_25_/_.07)] p-3"
                    >
                      <span className="text-[12px] leading-[1.5] text-[rgba(220,235,255,.9)] [text-wrap:pretty]">
                        {retentionPrompt.count < 0
                          ? 'Orbital could not count how many sessions this would delete. Saving it runs the sweep anyway.'
                          : `This deletes ${retentionPrompt.count} session${retentionPrompt.count === 1 ? '' : 's'} from the index now, and keeps deleting as others age past ${RETENTION_OPTIONS.find((o) => o.value === retentionPrompt.value)?.label.toLowerCase()}.`}
                      </span>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            const { value } = retentionPrompt
                            setRetentionPrompt(null)
                            void patchAndSet({ delete_sessions_older_than_days: value })
                          }}
                          className="rounded-full border border-[oklch(72%_.17_25_/_.5)] bg-[oklch(72%_.17_25_/_.15)] px-3 py-[4px] font-mono text-[10px] tracking-[0.1em] text-[#f3dcdc] transition-colors hover:bg-[oklch(72%_.17_25_/_.25)]"
                        >
                          DELETE
                        </button>
                        <button
                          type="button"
                          onClick={() => setRetentionPrompt(null)}
                          className="rounded-full border border-[rgba(150,205,255,.14)] px-3 py-[4px] font-mono text-[10px] tracking-[0.1em] text-[rgba(178,203,230,.85)] transition-colors hover:bg-[rgba(150,205,255,.07)]"
                        >
                          CANCEL
                        </button>
                      </div>
                    </div>
                  )}
                </Row>
              </>
            )}

            {section === 'notifications' && (
              <>
                {/* Spec 2026-09-21-settings-sections-design § 5. The three
                    WHEN rows are the three transitions `SessionNotifier`
                    already folds for; HOW is what `main.ts` does with what it
                    gets back. All five default on, which is today's
                    behaviour — see the derived flags above. */}
                <SectionLabel first>WHEN</SectionLabel>
                <Row
                  title="A session needs your input"
                  desc="A turn finished, a permission prompt is waiting, or the session asked a question."
                >
                  <Toggle
                    aria-label="A session needs your input"
                    checked={notifyNeedsInput}
                    onChange={(checked) =>
                      void patchAndSet({ notify_needs_input: checked ? 'true' : 'false' })
                    }
                  />
                </Row>
                <Row
                  title="A session ends"
                  desc="Only when it was working — a terminal session ageing out on the idle timer is the clock talking, not the session, and never notifies."
                >
                  <Toggle
                    aria-label="A session ends"
                    checked={notifySessionEnded}
                    onChange={(checked) =>
                      void patchAndSet({ notify_session_ended: checked ? 'true' : 'false' })
                    }
                  />
                </Row>
                <Row
                  title="A session fails"
                  desc="The process died or never started. The body stays on the map and the error is kept in the log either way."
                >
                  <Toggle
                    aria-label="A session fails"
                    checked={notifySessionFailed}
                    onChange={(checked) =>
                      void patchAndSet({ notify_session_failed: checked ? 'true' : 'false' })
                    }
                  />
                </Row>

                <SectionLabel>HOW</SectionLabel>
                <Row
                  title="Only when Orbital is in the background"
                  desc="A focused map already shows every one of these states, so interrupting over it is noise. Turn this off to be notified even with the window in front of you."
                >
                  <Toggle
                    aria-label="Only when Orbital is in the background"
                    checked={notifyOnlyWhenBackground}
                    onChange={(checked) =>
                      void patchAndSet({ notify_only_when_background: checked ? 'true' : 'false' })
                    }
                  />
                </Row>
                <Row
                  title="Play a sound"
                  desc="Off delivers them silently — they still appear in Notification Centre."
                >
                  <Toggle
                    aria-label="Play a sound"
                    checked={notifySound}
                    onChange={(checked) =>
                      void patchAndSet({ notify_sound: checked ? 'true' : 'false' })
                    }
                  />
                </Row>
                {/* The toggles are stored settings either way, so a browser
                    visit can set them and the desktop app honours them the
                    next time it reads them. Saying so beats rows that look
                    broken. */}
                <p className="pt-3.5 text-[12px] leading-[1.5] text-[rgba(160,190,225,.55)] [text-wrap:pretty]">
                  Notifications are delivered by the desktop app. These settings are saved from the
                  browser too — Orbital picks them up when it next runs.
                </p>
              </>
            )}

            {section === 'appearance' && (
              <>
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
              {/* canvas 4c, moved out of Sessions: what is drawn under a
                  planet's name is a drawing question. */}
              <Row title="Model name under planet label" desc="Family only (no version).">
                <div className="flex items-center gap-3">
                  <Toggle
                    aria-label="Model name under planet label"
                    checked={mapShowModel}
                    onChange={(checked) => void patchAndSet({ map_show_model: checked ? 'true' : 'false' })}
                  />
                  {/* canvas 4c: sample chip beside the toggle, JetBrains Mono
                      9.5px/.1em tracking, rgba(160,190,225,.7). The "e.g."
                      is a deviation from the artboard, added because the bare
                      upper-cased family reads as a status badge rather than as
                      a preview of the string the map will draw. It carries no
                      tracking and a dimmer ink so the sample still leads. */}
                  {mapModelSample && (
                    <span
                      data-testid="map-model-sample"
                      className="font-mono text-[9.5px] text-[rgba(160,190,225,.7)]"
                    >
                      <span className="text-[rgba(160,190,225,.45)]">e.g. </span>
                      <span className="tracking-[0.1em]">{mapModelSample}</span>
                    </span>
                  )}
                </div>
              </Row>
              {/* Also moved out of Sessions. It governs how much of a chain
                  stays drawn and nothing else — the sidebar's history is
                  unlimited whatever this says. */}
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

              {/* Its own kicker rather than three more rows under MAP: the
                  thresholds colour sidebar rows and gate the /compact badge
                  too, so filing them under a heading that says "map" would
                  misdescribe them (adr settings-sections-split-by-kind). */}
              <SectionLabel>CONTEXT USAGE</SectionLabel>
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
                  preview above: ok-level blue (`PREVIEW_TIERS`'s live tier,
                  oklch(80% .13 210)), the amber of its subagent tier
                  (oklch(80% .13 60)), and the spec's critical red
                  (oklch(72% .17 25)). */}
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
              </>
            )}

            {section === 'sessions' && (
              <>
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
            <SectionLabel>CLEAR &amp; LIFECYCLE</SectionLabel>
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
              </>
            )}
          </div>
          )}
        </div>
      </Panel>
      </div>
    </div>
    </EscapeBoundary>
  )
}
