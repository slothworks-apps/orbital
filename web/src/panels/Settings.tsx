import { swatch } from '../lib/palette'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  useOrbital,
  parsePlanetScale,
  PLANET_SCALE_MAX,
  PLANET_SCALE_MIN,
  parseContextThresholds,
  showContext,
  showCompactBadge,
  showTrash,
  endClosesPanel,
  reviewBeforeSend,
  headerSessionStats,
  headerLineChanges,
  headerPullRequest,
  mapStatePills,
  mapTheme,
  expandDiffOnPermission,
  guardGesture,
  type HeaderSessionStats,
  CONTEXT_THRESHOLD_MIN,
  CONTEXT_THRESHOLD_MAX,
} from '../store/store'
import {
  MAP_FPS_BACKGROUND_DEFAULT,
  MAP_FPS_BACKGROUND_MAX,
  MAP_FPS_BACKGROUND_MIN,
  MAP_FPS_BACKGROUND_STEP,
  MAP_FPS_FOCUSED_DEFAULT,
  MAP_FPS_FOCUSED_MAX,
  MAP_FPS_FOCUSED_MIN,
  MAP_FPS_FOCUSED_STEP,
  parseMapFps,
} from '../map/frameSchedule'
import { api, type ServerHealth, type SessionTip } from '../lib/api'
import { reportError } from '../lib/errors'
import { bindingCount, chordLabel, command, scopeCount } from '../lib/keymap'
import { notifyDesktopSettingsChanged } from '../lib/desktop'
import {
  NOTIFICATION_SETTING_KEYS,
  notificationsAllOff,
  parseNotificationSettings,
  type NotificationSettings,
} from '@orbital/shared/notifications'
import { notificationRowPatch } from '../lib/notificationsTip'
import {
  EXPERIMENTAL_UNLOCKED_KEY,
  NARRATE_COMMENTARY_KEY,
  NARRATE_MODEL_KEY,
  WALKTHROUGH_ENABLED_KEY,
  HARNESS_ENABLED_KEY,
  ARCHIPELAGO_ENABLED_KEY,
  archipelagoEnabled,
  experimentalUnlocked,
  isRevealChord,
  narrateCommentary,
  narrateModel,
  walkthroughEnabled,
  harnessEnabled,
  TERMINAL_ENABLED_KEY,
  TERMINAL_PLACEMENT_KEY,
  TERMINAL_CURSOR_KEY,
  TERMINAL_CURSOR_BLINK_KEY,
  LIMIT_SUNS_ENABLED_KEY,
  LIMIT_SUN_COLORS_KEY,
  LIMIT_SUN_POSITIONS_KEY,
  LIMIT_SUN_STYLE_KEY,
  terminalEnabled,
  terminalPlacement,
  terminalCursor,
  terminalCursorBlink,
  MOON_ORBITS_DEFAULT,
  MOON_ORBITS_KEY,
  MOON_ORBITS_MAX,
  MOON_ORBITS_MIN,
  moonOrbits,
  type TerminalCursor,
  type TerminalPlacement,
} from '../lib/experimental'
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
import { Input, TextArea } from '../ui/Input'
import { ModeCards } from '../ui/ModeCards'
import { ModelCards } from '../ui/ModelCards'
import { CustomModelField } from '../ui/CustomModelField'
import { Select } from '../ui/Select'
import { Checkbox, Toggle } from '../ui/Checkbox'
import { Segmented } from '../ui/Segmented'
import { modelByValue } from '../lib/models'
import type { GhAvailability, PermissionMode } from '../lib/types'
import { lineGroups, type LinesMode } from '../lib/branchStatus'
import { LineGroups } from './BranchSuffixes'
import type { MapStatePills } from '../lib/stateStyle'
import { TagsRulesSection } from './TagsRules'
import { ShortcutsSection } from './ShortcutsSection'
import { HarnessTemplatesSection } from './HarnessTemplates'
import { DevicesSection } from './DevicesSection'
import { UpdatesSection } from './UpdatesSection'
import { LimitSunsLabs } from './LimitSunsLabs'
import { useAppUpdate } from '../store/appUpdate'
import { ProfilesSection } from './ProfilesSection'
import { GhLine } from './GhLine'
import { SendFeedback, type FeedbackKind } from './SendFeedback'
import { isDemo } from '../lib/demo'
import {
  COLOUR_THEMES_ENABLED_KEY,
  COLOUR_THEME_FOLLOW_SYSTEM_KEY,
  COLOUR_THEME_KEY,
  colourThemesEnabled,
} from '../lib/colourTheme'
import { ColourThemeRows } from './ColourThemePicker'
import { ISSUE_CHECK_ENABLED_KEY } from './report/logic'
import { ReportDialog } from './report/ReportDialog'
import {
  DEBOUNCE_MS,
  GroupLine,
  Row,
  ScopeSection,
  SectionLabel,
  SharingProvider,
  type SettingsSharing,
} from './settingsRows'
import { groupSharing } from '../lib/settingsScope'
import {
  TEXT_SCALE_KEY,
  TEXT_SCALE_STEPS,
  TRANSCRIPT_FOLLOWS_APP,
  TRANSCRIPT_TEXT_SCALE_KEY,
  textScaleName,
  textScalePercent,
  textScaleSetting,
  textScales,
  transcriptBelowApp,
  transcriptTextScaleSetting,
} from '../lib/textScale'
import { broadcastSettings } from '../lib/settingsBroadcast'
import { useSyncedDraft } from '../lib/syncedDraft'
import {
  AUTO_CONTINUE_KEY,
  CONTINUE_TEXT_KEY,
  DEFAULT_CONTINUE_TEXT,
  limitSettings,
} from '../lib/limits'
// The desktop version names the DMG, and the DMG ships this frontend.
import { version as orbitalVersion } from '../../../desktop/package.json'

export interface SettingsProps {
  open: boolean
  onClose: () => void
}

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

/**
 * Settings → Appearance → "Session stats in the header" (canvas
 * `Feature - Header gauges` 11c). Two positions, the bar first because it is
 * the default and the one the panel is drawn around.
 */
const HEADER_STATS_OPTIONS: Array<{ value: HeaderSessionStats; label: string }> = [
  { value: 'bar', label: 'bar + numbers' },
  { value: 'button', label: 'button only' },
]

/**
 * Settings → Appearance → TEXT (canvas `Feature - Text size` 6a): each step
 * its name at 12/600 over its percentage in mono 9.5, the percentage lit on
 * the chosen one.
 */
const TEXT_SCALE_OPTIONS = TEXT_SCALE_STEPS.map((step) => ({
  value: step.value,
  ariaLabel: `${step.name}, ${textScalePercent(step.value)}`,
  label: (
    <>
      <span className="text-center font-sans fs-12 font-semibold leading-[1.2]">{step.name}</span>
      <span className="font-mono fs-9.5 tracking-[0.04em] text-ink-900/50 group-aria-pressed:text-ink-500/85">
        {textScalePercent(step.value)}
      </span>
    </>
  ),
}))

/**
 * 6a's SAMPLE under the two rows: a session line at the app's size and a
 * line of transcript at the transcript's, both following a pick at once.
 */
function TextSample({ app, transcript }: { app: string; transcript: string }) {
  return (
    <div className="mb-3.5 flex flex-col gap-2.5 rounded-[10px] border border-line/10 bg-shade/50 px-4 py-3.5">
      <div className="flex items-center gap-2.5 font-mono fs-10 tracking-[0.14em] text-ink-900/55">
        SAMPLE
        <span aria-hidden className="flex-1" />
        <span className="tracking-[0.08em]">
          APP {app} · TRANSCRIPT {transcript}
        </span>
      </div>
      <div className="flex items-center gap-2 border-b border-line/8 pb-[9px]">
        <span aria-hidden className="block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'oklch(80% .13 210)' }} />
        <span className="fs-13 font-bold">auth-refactor</span>
        <span className="min-w-0 truncate font-mono fs-11 text-ink-900/70">~/work/platform/auth</span>
        <span aria-hidden className="flex-1" />
        <span className="font-mono fs-10.5 tracking-[0.08em] text-accent">WORKING</span>
      </div>
      <div data-text-scope="transcript" className="text-pretty fs-13 leading-[1.55] text-ink-100/92">
        Adding a 30 s skew to the expiry check and persisting the rotated token before it's returned.
      </div>
    </div>
  )
}

/**
 * 6a's transcript list: "Same as the app" at the app's percentage, then the
 * steps; one below the app's step cannot be picked, since it would change
 * nothing (`textScales` never puts the transcript under the app).
 */
function transcriptTextScaleOptions(app: string) {
  return [
    { value: TRANSCRIPT_FOLLOWS_APP as string, label: 'Same as the app', trail: textScalePercent(app) },
    ...TEXT_SCALE_STEPS.map((step) => {
      const below = Number(step.value) < Number(app)
      return {
        value: step.value,
        label: step.name,
        trail: below ? `${textScalePercent(step.value)} · below app` : textScalePercent(step.value),
        triggerTrail: below ? textScalePercent(app) : undefined,
        inert: below,
      }
    }),
  ]
}

/** Settings → Appearance → "Line changes in the header" (canvas `Feature - Branch status` 1g). Off first: it is the default. */
const LINE_CHANGES_OPTIONS: Array<{ value: LinesMode; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'branch', label: 'Branch' },
  { value: 'split', label: 'Split' },
]

/**
 * 1g's preview under the line changes control: a feature branch with a little
 * uncommitted work, so split has a second group to show.
 */
const LINE_CHANGES_SAMPLE = {
  parent: 'main',
  committed: { added: 112, removed: 32 },
  uncommitted: { added: 8, removed: 2 },
}

/** Settings → Terminal → the terminal's placement. The dock first: it is the default (48a). */
const TERMINAL_PLACEMENT_OPTIONS: Array<{ value: TerminalPlacement; label: string }> = [
  { value: 'dock', label: 'Dock' },
  { value: 'side', label: 'Side panel' },
]

/** The terminal's cursor shape (48f). Block first: it is the default. */
const TERMINAL_CURSOR_OPTIONS: Array<{ value: TerminalCursor; label: string }> = [
  { value: 'block', label: 'Block' },
  { value: 'bar', label: 'Bar' },
  { value: 'underline', label: 'Underline' },
]

/** Settings → Appearance → MAP → "State on the map" (canvas 24e / 24a). Dot first: it is the default. */
const STATE_PILL_OPTIONS: Array<{ value: MapStatePills; label: string }> = [
  { value: 'dot', label: 'Dot' },
  { value: 'label', label: 'Label' },
]

/**
 * Settings → Appearance → MAP → "Theme". Planets first: it is the default.
 * Archipelago is offered only while its Experimental switch is on.
 */
function mapThemeOptions(settings: Record<string, string | undefined>): Array<{ value: string; label: string }> {
  return [
    { value: 'planets', label: 'Planets' },
    ...(archipelagoEnabled(settings) ? [{ value: 'archipelago', label: 'Archipelago' }] : []),
    { value: 'desk', label: 'Desk' },
  ]
}

/**
 * The nav, in canvas order plus "Notifications", which the canvas does not
 * have yet (spec 2026-09-21-settings-sections-design § 1). It is inserted
 * after Sessions because every event it governs is a session event, and
 * every other row keeps the position 1h gives it.
 *
 * Every row is live; `disabled` stays so a section can be switched off again
 * without `initialSection` stranding a stored visit on it. General is missing its
 * STARTUP & WINDOW group, which waits on behaviour `desktop/` does not have
 * yet ([[desktop-startup-window-and-updates]]), and its retention row, which
 * waits on a design question the indexer raises — see the spec's § 4.
 */
const NAV_ITEMS = [
  { key: 'general', label: 'General', disabled: false },
  // Second, after General (canvas 62c): the profiles moved out of General's
  // CLAUDE CODE group (spec 2026-10-21-log-in-from-orbital-design § 4).
  { key: 'profiles', label: 'Profiles', disabled: false },
  { key: 'sessions', label: 'Sessions', disabled: false },
  { key: 'notifications', label: 'Notifications', disabled: false },
  { key: 'permissions', label: 'Permissions', disabled: false },
  { key: 'tags', label: 'Tags & rules', disabled: false },
  { key: 'harness', label: 'Harness templates', disabled: false },
  // Listed only while Labs → Terminal is on, as Harness is.
  { key: 'terminal', label: 'Terminal', disabled: false },
  { key: 'appearance', label: 'Appearance', disabled: false },
  // Always listed, not behind Experimental: the section is inert until its
  // switch is on (spec 2026-10-01-settings-mobile-design). Mobile's place
  // since the device group (canvas 50a REPLACES MOBILE).
  { key: 'devices', label: 'Devices', disabled: false },
  { key: 'shortcuts', label: 'Shortcuts', disabled: false },
  // The desktop app's own updates (canvas `Feature - App update`): listed
  // only where the update bridge is, so never in a browser or on the phone.
  { key: 'updates', label: 'Updates', disabled: false },
  // Finished features to try, each off until turned on (docs/why-orbital.md
  // → Experimental, Labs, and out). Always listed.
  { key: 'labs', label: 'Labs', disabled: false },
  // Work in progress, listed only once the reveal chord has unlocked it
  // (`lib/experimental`).
  { key: 'experimental', label: 'Experimental', disabled: false },
] as const

type SectionKey = (typeof NAV_ITEMS)[number]['key']

/**
 * The settings keys each section's rows edit. A heading's scope label is
 * read from them (`scopeOfKeys`), so it follows the classification in
 * `shared/sharedSettings.ts` rather than restating it (spec
 * 2026-10-24-group-shared-settings-design § What the user sees in Settings).
 * Each row names its own keys too (`Row`'s `setting`), for its pill.
 */
const SECTION_KEYS = {
  claudeCode: ['claude_executable_path'],
  data: ['delete_sessions_older_than_days'],
  notifyWhen: [
    NOTIFICATION_SETTING_KEYS.needsInput,
    NOTIFICATION_SETTING_KEYS.sessionEnded,
    NOTIFICATION_SETTING_KEYS.sessionFailed,
  ],
  delivery: [NOTIFICATION_SETTING_KEYS.sound, NOTIFICATION_SETTING_KEYS.onlyWhenBackground],
  approving: ['permission_guard_gesture', 'questions_review_before_send'],
  labs: [
    HARNESS_ENABLED_KEY,
    TERMINAL_ENABLED_KEY,
    COLOUR_THEMES_ENABLED_KEY,
    ISSUE_CHECK_ENABLED_KEY,
    LIMIT_SUNS_ENABLED_KEY,
    LIMIT_SUN_STYLE_KEY,
    LIMIT_SUN_COLORS_KEY,
    LIMIT_SUN_POSITIONS_KEY,
  ],
  experimental: [
    ARCHIPELAGO_ENABLED_KEY,
    WALKTHROUGH_ENABLED_KEY,
    NARRATE_MODEL_KEY,
    NARRATE_COMMENTARY_KEY,
    MOON_ORBITS_KEY,
  ],
  terminal: [TERMINAL_PLACEMENT_KEY, TERMINAL_CURSOR_KEY, TERMINAL_CURSOR_BLINK_KEY],
  colours: [COLOUR_THEME_KEY, COLOUR_THEME_FOLLOW_SYSTEM_KEY],
  text: [TEXT_SCALE_KEY, TRANSCRIPT_TEXT_SCALE_KEY],
  detailPanel: ['header_session_stats', 'header_pull_request', 'header_line_changes', 'end_closes_panel'],
  map: [
    'map_theme',
    'planet_scale',
    'map_scale_labels',
    'map_show_model',
    'map_state_pills',
    'map_fps_focused',
    'map_fps_background',
    'map_show_trash',
  ],
  contextUsage: [
    'map_show_context',
    'context_threshold_warn',
    'context_threshold_critical',
    'map_show_compact_badge',
  ],
  transcript: ['transcript_edit_diffs', 'transcript_expand_diff_on_permission'],
  newSessions: [
    'default_model',
    'remember_model_per_project',
    'default_permission_mode',
    'default_project_dir',
    'name_sessions_automatically',
  ],
  clear: ['confirm_before_clear'],
  instructions: ['session_instructions_tips', 'session_instructions_custom', 'session_instructions_custom_text'],
  limits: [AUTO_CONTINUE_KEY, CONTINUE_TEXT_KEY],
} satisfies Record<string, readonly string[]>

/** Sections stored under a key that has since been renamed, by their new key. */
const RENAMED_SECTIONS: Record<string, SectionKey> = { mobile: 'devices' }

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
export function initialSection(
  settings: Record<string, string | undefined>,
  hasUpdates: boolean = useAppUpdate.getState().source !== null,
): SectionKey {
  const stored = RENAMED_SECTIONS[settings.settings_last_section ?? ''] ?? settings.settings_last_section
  const match = visibleNavItems(settings, hasUpdates).find((item) => item.key === stored)
  return match && !match.disabled ? match.key : NAV_ITEMS[0].key
}

/**
 * The nav as drawn: Experimental stays out until unlocked, Harness and
 * Terminal until enabled, Updates outside the desktop app.
 */
function visibleNavItems(settings: Record<string, string | undefined>, hasUpdates: boolean) {
  return NAV_ITEMS.filter(
    (item) =>
      (item.key !== 'experimental' || experimentalUnlocked(settings)) &&
      (item.key !== 'harness' || harnessEnabled(settings)) &&
      (item.key !== 'terminal' || terminalEnabled(settings)) &&
      (item.key !== 'updates' || hasUpdates),
  )
}

/** Nav row geometry from canvas 1h: 9px/12px padding, 8px radius, 13px. */
const NAV_ROW = 'flex items-center gap-2.5 rounded-lg border px-3 py-[9px] text-left fs-13'

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
    ring: 'repeating-conic-gradient(color-mix(in oklab, var(--color-ink-600) 40%, transparent) 0 2deg, transparent 2deg 12deg)',
    mask: [3, 2],
    body: 'oklch(16% .01 230)',
    border: '1px solid color-mix(in oklab, var(--color-ink-600) 35%, transparent)',
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
    shadow: '0 0 22px oklch(80% .13 60 / .25), inset 0 0 0 5px color-mix(in oklab, var(--color-shadow) 25%, transparent)',
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
          style={{
            inset: tier.inset,
            background: tier.ring,
            maskImage: maskCss,
            WebkitMaskImage: maskCss,
          }}
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
        className="font-mono fs-10 tracking-[0.06em] text-ink-900/60"
        style={{ marginTop: Math.round(tier.base * scale * tier.capK + 8) }}
      >
        {size}px
      </div>
    </div>
  )
}

/**
 * A whole-number setting in the "Default planet size" slider's shape
 * (readout, RESET, range, and ticks at the minimum, the default and the
 * maximum): the map frame-rate caps, in frames a second (the background
 * cap's 0 reads "paused"), and the moon orbits.
 */
function ValueSlider({
  label,
  value,
  min,
  max,
  step,
  fallback,
  onChange,
  format = (fps: number) => (fps === 0 ? 'paused' : `${fps} fps`),
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  fallback: number
  onChange: (next: number) => void
  /** How a value reads in the readout and under the ticks; frames a second unless given. */
  format?: (value: number) => string
}) {
  return (
    <div className="flex w-full flex-col gap-[9px]">
      <div className="flex items-baseline gap-2">
        <span className="font-mono fs-15 text-ink-100">{format(value)}</span>
        <span className="flex-1" />
        <button
          type="button"
          aria-label={`Reset ${label.toLowerCase()}`}
          onClick={() => onChange(fallback)}
          className="rounded-full border border-line/14 px-[9px] py-[3px] font-mono fs-10 tracking-[0.1em] text-ink-800/85 transition-colors hover:border-line/26 hover:bg-line/7 hover:text-ink-400"
        >
          RESET
        </button>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-[18px] w-full cursor-grab accent-accent"
      />
      <div className="flex justify-between font-mono fs-10 tracking-[0.06em] text-ink-900/55">
        <span>{format(min)}</span>
        <span>{format(fallback)}</span>
        <span>{format(max)}</span>
      </div>
    </div>
  )
}

/**
 * The debounce of the free-text fields. `schedule(save)` runs `save` after
 * `DEBOUNCE_MS` and returns the effect's cleanup. A cleanup that runs because
 * the draft changed again cancels the save; one that runs because the dialog
 * closed or unmounted runs it at once, so the last keystrokes before a quick
 * close are kept. `open` is read from the render the cleanup belongs to, so
 * the order the effects are declared in does not matter.
 */
function useDraftSave(open: boolean): (save: () => void) => () => void {
  const openRef = useRef(open)
  openRef.current = open
  const unmounted = useRef(false)
  // A layout cleanup runs before the passive ones on unmount.
  useLayoutEffect(() => {
    unmounted.current = false
    return () => {
      unmounted.current = true
    }
  }, [])
  return useCallback((save: () => void) => {
    let pending = true
    const timer = setTimeout(() => {
      pending = false
      save()
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      if (pending && (!openRef.current || unmounted.current)) save()
    }
  }, [])
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
  const appTextScale = textScaleSetting(settings)
  const transcriptTextScale = transcriptTextScaleSetting(settings)
  const resolvedTextScales = textScales(settings)
  const models = useOrbital(useShallow((s) => s.models))
  const claudeDirCount = useOrbital((s) => s.claudeDirs.length)
  const hasUpdates = useAppUpdate((s) => s.source !== null)
  const members = useOrbital((s) => s.remote?.group.members)
  const [projectDirDraft, setProjectDirDraft] = useState(settings.default_project_dir ?? '')
  const [cliPathDraft, setCliPathDraft] = useState(settings.claude_executable_path ?? '')
  // Shared across the group: a value another member sets while this is open
  // reaches the field unless it holds an unsaved edit (`useSyncedDraft`).
  const [instructionsDraft, setInstructionsDraft] = useSyncedDraft(
    settings.session_instructions_custom_text ?? '',
    open,
  )
  const [continueDraft, setContinueDraft] = useSyncedDraft(limitSettings(settings).text, open)
  /**
   * Orbital's tips, from the server. Null until the fetch lands and after a
   * failure: the list then simply does not draw, for the same reason
   * General's read-only rows wait for `/api/health` — a placeholder list
   * could be read as the real one.
   */
  const [tips, setTips] = useState<SessionTip[] | null>(null)
  const [tipsOpen, setTipsOpen] = useState(false)
  /**
   * Facts about how the server was started, for General's read-only rows.
   * Null until the fetch lands and after a failure — those rows simply do not
   * draw rather than showing a placeholder that could be mistaken for a real
   * path or a real billing mode.
   */
  const [health, setHealth] = useState<ServerHealth | null>(null)
  /**
   * Whether `gh` can answer for the PR switch (canvas `Feature - Branch
   * status` 1g), asked when the dialog opens and whenever the app regains
   * focus while it is open. Null until an answer lands, or after a failed
   * ask: the switch then works as any other, since only the server can say
   * `gh` is missing.
   */
  const [gh, setGh] = useState<GhAvailability | null>(null)
  /** Whether Homebrew is there to install `gh` with; absent from an older Mac (`GhLine`). */
  const [ghBrew, setGhBrew] = useState<boolean | undefined>(undefined)
  /**
   * Send feedback's pick and whether its review dialog is open over Settings
   * (canvas `Feature - Feedback` 61c). The kind outlives the close, so the
   * dialog keeps its fields while it fades out.
   */
  const [feedback, setFeedback] = useState<{ kind: FeedbackKind; open: boolean }>({ kind: 'broke', open: false })
  // Settings stays mounted while closed: closing it closes the review too, so
  // it does not come back unasked the next time Settings opens.
  if (!open && feedback.open) setFeedback({ ...feedback, open: false })
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
  // Harness templates' editor takes the whole panel, header and nav included (canvas 30k).
  const [harnessEditing, setHarnessEditing] = useState(false)
  const editorTakesPanel = section === 'harness' && harnessEditing
  // Appearance preview (canvas 5a): open by default, collapse state lives
  // only for the dialog's visit — deliberately not persisted (spec).
  const [previewOpen, setPreviewOpen] = useState(true)
  /** Other picked for the default model, before any id has validated. */
  const [otherModelPicked, setOtherModelPicked] = useState(false)

  useEffect(() => {
    if (!open) return
    // Every visit resumes where the last one left off, and starts with no
    // stale "saved · just now" — the dialog is held mounted across `open`.
    setSection(initialSection(useOrbital.getState().settings))
    setSaved(false)
    setPreviewOpen(true)
    // Collapsed on every visit, like the planet-size preview above starts open.
    setTipsOpen(false)
    setOtherModelPicked(false)
    // `settings` deliberately absent: this reseeds per visit, and reading it
    // through `getState` keeps a PATCH landing mid-visit from yanking the
    // user out of the section they are looking at.
  }, [open])

  // The reveal chord, only while the dialog is open. Locking again while the
  // section is on screen moves to the first row rather than leaving a page
  // whose nav row just vanished.
  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (!isRevealChord(e)) return
      e.preventDefault()
      const unlocked = !experimentalUnlocked(useOrbital.getState().settings)
      void patchAndSet({ [EXPERIMENTAL_UNLOCKED_KEY]: unlocked ? 'true' : 'false' })
      if (!unlocked)
        setSection((current) => (current === 'experimental' ? NAV_ITEMS[0].key : current))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  useEffect(() => {
    if (!open) return
    setProjectDirDraft(settings.default_project_dir ?? '')
    setCliPathDraft(settings.claude_executable_path ?? '')
    // Only reseed on open — an in-flight PATCH from a prior keystroke resolving
    // must not fight the user's current typing while the panel stays open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /** Saves `patch`; false when the save failed, which it has already reported. */
  async function patchAndSet(patch: Record<string, string>): Promise<boolean> {
    try {
      await api.patchSettings(patch)
      useOrbital.setState((state) => ({ settings: { ...state.settings, ...patch } }))
      setSaved(true)
      // Only this dialog can change the notification rows, and the main
      // process cannot see a PATCH — the settings table is not a WebSocket
      // topic. Told here rather than inside `api.patchSettings` so the
      // sidebar's own writes do not make it re-read for nothing.
      notifyDesktopSettingsChanged()
      // The other windows (a detached session's) see no topic either.
      broadcastSettings(patch)
      return true
    } catch (err) {
      reportError(err, 'Failed to save settings')
      return false
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
    [],
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

  /**
   * The two frame-rate caps follow the planet-size slider's rule: the store
   * first, so the map behind the dialog picks the cap up live, and a
   * debounced PATCH per key.
   */
  const fpsTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  useEffect(
    () => () => {
      for (const timer of Object.values(fpsTimersRef.current)) clearTimeout(timer)
    },
    [],
  )

  function setMapFps(key: 'map_fps_focused' | 'map_fps_background', next: number) {
    const value = String(next)
    useOrbital.setState((state) => ({ settings: { ...state.settings, [key]: value } }))
    clearTimeout(fpsTimersRef.current[key])
    fpsTimersRef.current[key] = setTimeout(() => {
      void patchAndSet({ [key]: value })
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

  const scheduleSave = useDraftSave(open)

  // Debounced PATCH for the free-text project-dir field.
  useEffect(() => {
    if (!open) return
    if (projectDirDraft === (settings.default_project_dir ?? '')) return
    return scheduleSave(() => void patchAndSet({ default_project_dir: projectDirDraft }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDirDraft, open])

  // Same draft-then-debounce treatment for the CLI override (spec
  // 2026-09-16-electron-wrapper-design § 3), the panel's other free-text field.
  useEffect(() => {
    if (!open) return
    if (cliPathDraft === (settings.claude_executable_path ?? '')) return
    return scheduleSave(() => void patchAndSet({ claude_executable_path: cliPathDraft }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cliPathDraft, open])

  // And the third: Sessions' own instructions. Stored as typed — the
  // composer trims at compose time, so the field keeps showing what was
  // written (spec 2026-09-30-session-instructions-design § 3).
  useEffect(() => {
    if (!open) return
    if (instructionsDraft === (settings.session_instructions_custom_text ?? '')) return
    return scheduleSave(() => void patchAndSet({ session_instructions_custom_text: instructionsDraft }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instructionsDraft, open])

  // And the fourth: the text a limit wait sends at the reset (31c). An emptied
  // field is not saved — the server would fall back to the default anyway,
  // and the field would then disagree with what goes out.
  useEffect(() => {
    if (!open) return
    if (!continueDraft.trim() || continueDraft === limitSettings(settings).text) return
    return scheduleSave(() => void patchAndSet({ [CONTINUE_TEXT_KEY]: continueDraft }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [continueDraft, open])

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

  // Sessions' tips list, fetched per visit the same way: it shows what the
  // running server appends, so a copy from before a restart would be wrong.
  // Cleared first so a fetch that fails this visit shows no list rather than
  // the previous visit's.
  useEffect(() => {
    if (!open) return
    setTips(null)
    let live = true
    api
      .getSessionInstructionTips()
      .then((answer) => {
        if (live && answer) setTips(answer.tips)
      })
      .catch(() => {
        /* the list stays unrendered; see the state's comment */
      })
    return () => {
      live = false
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    let live = true
    const ask = () => {
      api
        .ghStatus()
        .then((answer) => {
          if (live && answer) {
            setGh(answer.status)
            setGhBrew(answer.brew)
          }
        })
        .catch(() => {
          /* the switch stays as it was; the next focus asks again */
        })
    }
    ask()
    window.addEventListener('focus', ask)
    return () => {
      live = false
      window.removeEventListener('focus', ask)
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
  const thresholds = parseContextThresholds(settings)
  // Shared across the group, as the instructions draft above.
  const [warnDraft, setWarnDraft] = useSyncedDraft(String(thresholds.warn), open)
  const [criticalDraft, setCriticalDraft] = useSyncedDraft(String(thresholds.critical), open)

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
    return scheduleSave(
      () =>
        void patchAndSet({
          context_threshold_warn: String(warn),
          context_threshold_critical: String(critical),
        }),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warnDraft, criticalDraft, open])

  // Closes the dialog. A rule row open inside Tags & rules registers a deeper
  // layer and is peeled first (see `TagsRulesSection`).
  useEscapeLayer(open, onClose)
  // Held mounted through the close transition (see `ui/usePresence`).
  const { mounted, state: presence } = usePresence(open, MODAL_ENTER_MS, MODAL_EXIT_MS)

  /**
   * Whether this group shares settings with another Mac or server, and with
   * which: the scope labels, pills and the group line show only then (spec
   * 2026-10-24-group-shared-settings-design). "update it" opens Devices,
   * except on Devices itself.
   */
  const sharing = useMemo<SettingsSharing>(() => groupSharing(members), [members])
  const marks = useMemo<SettingsSharing>(
    () => (section === 'devices' ? sharing : { ...sharing, openDevices: () => selectSection('devices') }),
    // `selectSection` is a fresh closure each render but only sets state.
    [sharing, section],
  )

  const sectionTitle = NAV_ITEMS.find((item) => item.key === section)?.label ?? 'Sessions'

  const defaultPermissionMode =
    (settings.default_permission_mode as PermissionMode) || 'acceptEdits'
  const confirmBeforeClear = settings.confirm_before_clear !== 'false'
  const reviewAnswers = reviewBeforeSend(settings)
  const nameSessions = settings.name_sessions_automatically !== 'false'
  const instructionTips = settings.session_instructions_tips !== 'false'
  const instructionCustom = settings.session_instructions_custom !== 'false'
  const autoContinue = limitSettings(settings).autoContinue
  const continueIsDefault = continueDraft === DEFAULT_CONTINUE_TEXT
  // Off unless the stored value is one of the offered policies: an absent or
  // unreadable row must show as "Never", the same way the server parses it.
  const storedRetention = settings.delete_sessions_older_than_days ?? 'never'
  const deleteOlderThan = RETENTION_OPTIONS.some((o) => o.value === storedRetention)
    ? storedRetention
    : 'never'
  // `default_model` is a value, not a flag — a missing key means "no
  // preference yet", not "off", so it reads as `null` rather than a default.
  const defaultModel = settings.default_model ?? ''
  // A stored default no catalog row carries was set through Other (or is a
  // model this install no longer lists): show Other with it, already trusted.
  const defaultIsCustom =
    defaultModel !== '' && models.length > 0 && !modelByValue(defaultModel, models)
  const defaultModelOtherActive = otherModelPicked || defaultIsCustom
  const rememberModelPerProject = settings.remember_model_per_project !== 'false'
  const mapShowModel = settings.map_show_model !== 'false'
  const mapShowTrash = showTrash(settings)
  const endClosesPanelOn = endClosesPanel(settings)
  // Context-fill arc (canvas 1h, spec context-fill-arc): master switch and
  // the /compact badge sub-toggle, both default-on.
  const mapShowContext = showContext(settings)
  const mapShowCompactBadge = showCompactBadge(settings)
  /**
   * Notifications (spec 2026-09-21-settings-sections-design § 5), read the way
   * the desktop's notifier reads them: silent by default (spec
   * 2026-10-08-notifications-off-by-default-design § 1).
   */
  const notify = parseNotificationSettings(settings)
  // 1c: the one line saying the silence is on purpose, while nothing notifies.
  const notifyAllOff = notificationsAllOff(notify)
  // 1c: background-only filters the events above it; with none on, it has nothing to filter.
  const notifyAnyEvent = notify.needsInput || notify.sessionEnded || notify.sessionFailed
  const saveNotifyRow = (key: keyof NotificationSettings) => (checked: boolean) =>
    void patchAndSet(notificationRowPatch(key, checked))
  // Appearance (canvas 5a).
  const headerStats = headerSessionStats(settings)
  // 1g: gh unusable draws the switch off and disabled — the stored choice is
  // left alone, so it comes back as it was once gh works again.
  const ghBlocked = gh !== null && gh !== 'ready'
  const prInHeader = headerPullRequest(settings) && !ghBlocked
  // 61c's Open the session ›: Settings makes way for the session it started.
  const openSession = (id: string) => {
    onClose()
    void useOrbital.getState().select(id)
  }
  const lineChanges = headerLineChanges(settings)
  const lineChangesPreview = lineGroups(LINE_CHANGES_SAMPLE, lineChanges)
  const statePills = mapStatePills(settings)
  const theme = mapTheme(settings)
  // Appearance → COLOURS (1f): only while its Labs switch is on, and never in the website's demo.
  const coloursShown = colourThemesEnabled(settings) && !isDemo()
  const editDiffs = settings.transcript_edit_diffs === 'expanded' ? 'expanded' : 'collapsed'
  const expandDiffOnPermissionRow = expandDiffOnPermission(settings)
  const guard = guardGesture(settings)
  const planetScale = parsePlanetScale(settings)
  const mapScaleLabels = settings.map_scale_labels === 'true'
  const mapFps = parseMapFps(settings)
  const scaleNote =
    planetScale === 1
      ? 'default'
      : planetScale > 1
        ? 'larger bodies · fewer per screen'
        : 'denser map'
  // canvas 4c: the sample chip beside the toggle above shows what it will
  // actually draw — the selected default's family, upper-cased — rather than
  // a placeholder, so it renders nothing when there is no catalog or no
  // matching row instead of showing something that could look real.
  const mapModelSample = modelByValue(defaultModel || null, models)?.family.toUpperCase()
  // Canvas 1h prints a second version line. The server resolves the bundled
  // Claude Code CLI version at boot into `claude_code_version`; when it can't
  // (no SDK/manifest) the key stays absent and this row stays hidden.
  const claudeCodeVersion = settings.claude_code_version

  if (!mounted) return null

  const entered = presence === 'entered'
  const duration = presence === 'exiting' ? MODAL_EXIT_DURATION : MODAL_ENTER_DURATION

  return (
    <EscapeBoundary>
      <div
        data-state={presence}
        // Still painted on the way out, but no longer a live surface.
        inert={presence === 'exiting' || undefined}
        className={[
          'orbital-no-drag fixed inset-0 z-50 flex items-center justify-center bg-space/50 p-6 backdrop-blur-[3px]',
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
            <SharingProvider value={marks}>
            {/* Header: 22/28/18 padding per canvas 1h. */}
            <div
              className={`${editorTakesPanel ? 'hidden' : 'flex'} items-center gap-3.5 border-b border-line/10 px-7 pb-[18px] pt-[22px]`}
            >
              <button
                type="button"
                aria-label="Close"
                onClick={onClose}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-[7px] border border-line/14 fs-14 leading-(--text-sm--line-height) text-ink-500/70 transition-colors hover:bg-white/5 hover:text-ink-100"
              >
                ‹
              </button>
              <div className="min-w-0 flex-1">
                <div className="font-mono fs-10 tracking-[0.2em] text-accent/80">
                  SETTINGS
                </div>
                {/* The title is the section's, not the dialog's: 1e and 1h are the
                same screen under two nav rows. */}
                <h2 className="mt-1 fs-20 leading-(--text-xl--line-height) font-bold tracking-[-0.01em] text-ink-100">
                  {sectionTitle}
                </h2>
              </div>
              {saved && (
                <span
                  data-testid="save-status"
                  className="shrink-0 font-mono fs-10.5 tracking-[0.06em] text-ink-900/55"
                >
                  saved · just now
                </span>
              )}
              {/* Shortcuts saves nothing, so its slot on the right is the
              keymap's size instead (canvas Feature - Shortcuts, artboard A). */}
              {section === 'shortcuts' && (
                <span className="shrink-0 font-mono fs-10.5 tracking-[0.06em] text-ink-900/55">
                  {bindingCount()} bindings · {scopeCount()} scopes
                </span>
              )}
            </div>

            {/* Tags & rules brings a second fixed column with it (1e: nav 240 ·
            tags 330 · rules), so the body's tracks are the section's too.
            The row is pinned to the body's height: an `auto` row grows to the
            nav's full height, and in a short window that pushed the bottom of
            the content column past the panel's clipped edge. */}
            <div
              className={[
                'grid min-h-0 flex-1',
                // The group line over both of Tags & rules' columns takes a
                // row of its own, so the nav spans two. Either way the last
                // row is pinned to the body's height.
                section === 'tags' && sharing.shown ? 'grid-rows-[auto_minmax(0,1fr)]' : 'grid-rows-[minmax(0,1fr)]',
                section === 'tags'
                  ? 'grid-cols-[240px_minmax(0,330px)_minmax(0,1fr)]'
                  : editorTakesPanel
                    ? 'grid-cols-[minmax(0,1fr)]'
                    : 'grid-cols-[240px_minmax(0,1fr)]',
              ].join(' ')}
            >
              {/* Nav column: 240px, 16px/12px padding, 2px row gap (canvas 1h).
              Only the section list scrolls when it does not fit; feedback and
              the versions stay pinned to the bottom. */}
              <nav
                className={`${editorTakesPanel ? 'hidden' : 'flex'} min-h-0 flex-col border-r border-line/10 px-3 py-4 ${section === 'tags' && sharing.shown ? 'row-span-2' : ''}`}
                aria-label="Settings sections"
              >
                <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
                  {visibleNavItems(settings, hasUpdates).map((item) => (
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
                          ? 'border-line/14 bg-line/8 font-semibold text-ink-100'
                          : 'border-transparent font-medium text-ink-200/80',
                        item.disabled ? 'cursor-default' : 'hover:bg-white/5',
                      ].join(' ')}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                {/* Not in the website's demo, where it would file a real issue. */}
                {!isDemo() && <SendFeedback onPick={(kind) => setFeedback({ kind, open: true })} />}
                <div className="px-3 py-2.5 font-mono fs-10 leading-[1.6] text-ink-900/60">
                  <div>orbital {orbitalVersion}</div>
                  {claudeCodeVersion && <div>claude-code {claudeCodeVersion}</div>}
                </div>
              </nav>

              {/* Tags & rules brings its own two columns, and Shortcuts pins a
              filter bar above a list that scrolls on its own, so both own
              their frame; every other section is a list of rows in the one
              content column below (8/32/20 padding, canvas 1h). Flat `&&`
              blocks rather than a ternary chain there: with five sections a
              nested conditional stops being readable, and only one of them
              is ever mounted, so their order here is not the nav's. */}
              {section === 'tags' ? (
                <>
                  <GroupLine className="col-span-2 px-5" />
                  <TagsRulesSection active onSaved={() => setSaved(true)} />
                </>
              ) : section === 'harness' ? (
                // Its own frame, in a row that fills the column as the
                // body's grid did: the group line goes over it (an empty
                // row while there is none), and not over the editor, which
                // takes the whole panel.
                <div className="grid min-h-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)]">
                  <div>{!harnessEditing && <GroupLine className="px-8" scope="device" />}</div>
                  <HarnessTemplatesSection
                    active
                    onSaved={() => setSaved(true)}
                    onEditingChange={setHarnessEditing}
                  />
                </div>
              ) : section === 'devices' ? (
                <ScopeSection scope="device">
                  <DevicesSection
                    patchAndSet={patchAndSet}
                    onSaved={() => setSaved(true)}
                    onOpenUpdates={hasUpdates ? () => selectSection('updates') : undefined}
                  />
                </ScopeSection>
              ) : section === 'shortcuts' ? (
                <ShortcutsSection />
              ) : section === 'updates' ? (
                <ScopeSection scope="device">
                  <UpdatesSection patchAndSet={patchAndSet} />
                </ScopeSection>
              ) : (
                <div className="flex min-h-0 flex-col overflow-y-auto px-8 pb-5 pt-2">
                  {/* Profiles has no heading to carry its scope, so its group line does. */}
                  <GroupLine scope={section === 'profiles' ? 'device' : undefined} />
                  {section === 'general' && (
                    <>
                      <ScopeSection keys={SECTION_KEYS.claudeCode}>
                      <SectionLabel first>CLAUDE CODE</SectionLabel>
                      {/* Spec 2026-09-16-electron-wrapper-design § 3: empty
                    autodetects, a value overrides. Moved here out of NEW
                    SESSIONS, where it never belonged — it is an install path
                    the server reads once at boot, not a session default
                    (adr settings-sections-split-by-kind). The row must not
                    imply the change reaches a running session. */}
                      <Row
                        title="Claude Code executable"
                        setting="claude_executable_path"
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
                            className="font-mono fs-11.5 text-ink-100"
                          >
                            {health.billing === 'api-key'
                              ? 'API key'
                              : claudeDirCount >= 2
                                ? // 44a: with several logins, each bills its own account.
                                  'Claude account · per profile'
                                : 'Claude subscription'}
                          </span>
                          {health.billing !== 'api-key' && claudeDirCount >= 2 ? (
                            <span className="font-mono fs-10.5 text-ink-900/55">
                              each profile bills to the account it is signed in to
                            </span>
                          ) : (
                            <span className="fs-12 leading-[1.5] text-ink-900/70 [text-wrap:pretty]">
                              {health.billing === 'api-key'
                                ? 'ORBITAL_USE_API_KEY=1 is set, so ANTHROPIC_API_KEY is left in the server’s environment and usage is billed to that key.'
                                : 'ANTHROPIC_API_KEY is removed from the server’s environment at startup, so sessions bill your subscription the way the CLI does.'}
                            </span>
                          )}
                          {/* The key outranks every directory's own login,
                          enterprise included (spec § 3 Billing; 44a) — said
                          only when there is more than one login to outrank. */}
                          {health.billing === 'api-key' && claudeDirCount >= 2 && (
                            <span
                              data-testid="billing-overrides-dirs"
                              className="fs-12 leading-[1.5] text-ink-600/85 [text-wrap:pretty]"
                            >
                              The API key overrides each profile’s own login. All profiles bill to this key.
                            </span>
                          )}
                        </Row>
                      )}

                      </ScopeSection>
                      {/* The kicker is unconditional — the retention row below it
                    needs no server facts — but the Database row only draws
                    once a real path has arrived. */}
                      <ScopeSection keys={SECTION_KEYS.data}>
                      <SectionLabel>DATA</SectionLabel>
                      {health?.paths?.dbPath && (
                        <>
                          <Row
                            title="Database"
                            desc="Orbital's own index of your sessions. Your transcripts are not in here — they stay in the Claude directory, which Orbital only ever reads."
                          >
                            <span className="break-all font-mono fs-11 leading-[1.6] text-ink-500/80">
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
                              className="rounded-full border border-line/14 px-[9px] py-[3px] font-mono fs-10 tracking-[0.1em] text-ink-800/85 transition-colors hover:border-line/26 hover:bg-line/7 hover:text-ink-400"
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
                        setting="delete_sessions_older_than_days"
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
                            <span className="fs-12 leading-[1.5] text-ink-200/90 [text-wrap:pretty]">
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
                                className="rounded-full border border-[oklch(72%_.17_25_/_.5)] bg-[oklch(72%_.17_25_/_.15)] px-3 py-[4px] font-mono fs-10 tracking-[0.1em] text-[#f3dcdc] transition-colors hover:bg-[oklch(72%_.17_25_/_.25)]"
                              >
                                DELETE
                              </button>
                              <button
                                type="button"
                                onClick={() => setRetentionPrompt(null)}
                                className="rounded-full border border-line/14 px-3 py-[4px] font-mono fs-10 tracking-[0.1em] text-ink-800/85 transition-colors hover:bg-line/7"
                              >
                                CANCEL
                              </button>
                            </div>
                          </div>
                        )}
                      </Row>
                      </ScopeSection>
                    </>
                  )}

                  {section === 'profiles' && (
                    // Every profile Orbital watches and launches under; a
                    // change applies at once, no restart (spec
                    // 2026-10-04-multiple-claude-directories-design § 1), and
                    // each one's logins (spec 2026-10-21-log-in-from-orbital-design § 4).
                    <ProfilesSection active={open} makeDefault={patchAndSet} onSaved={() => setSaved(true)} />
                  )}
                  {section === 'notifications' && (
                    <>
                      {/* Spec 2026-09-21-settings-sections-design § 5. The three
                    NOTIFY ME WHEN rows are the three transitions `SessionNotifier`
                    already folds for; DELIVERY is what `main.ts` does with what it
                    reports. Everything but background-only starts off
                    (spec 2026-10-08-notifications-off-by-default-design). */}
                      {notifyAllOff && (
                        // Canvas `Feature - Notifications off` 1c: a page of
                        // switches all off looks broken without it.
                        <p className="pb-2.5 pt-3.5 fs-13 leading-[1.5] text-ink-900/80">
                          Everything here starts off. Orbital stays silent until you turn something on.
                        </p>
                      )}
                      <ScopeSection keys={SECTION_KEYS.notifyWhen}>
                      <SectionLabel first>NOTIFY ME WHEN</SectionLabel>
                      <Row
                        title="Needs input"
                        setting={NOTIFICATION_SETTING_KEYS.needsInput}
                        desc="A session is waiting on a permission or a question, or has finished its turn."
                      >
                        <Toggle
                          aria-label="Needs input"
                          checked={notify.needsInput}
                          onChange={saveNotifyRow('needsInput')}
                        />
                      </Row>
                      <Row
                        title="Session ended"
                        setting={NOTIFICATION_SETTING_KEYS.sessionEnded}
                        desc="A session ended while it was still working."
                      >
                        <Toggle
                          aria-label="Session ended"
                          checked={notify.sessionEnded}
                          onChange={saveNotifyRow('sessionEnded')}
                        />
                      </Row>
                      <Row
                        title="Session failed"
                        setting={NOTIFICATION_SETTING_KEYS.sessionFailed}
                        desc="A session stopped on an error."
                      >
                        <Toggle
                          aria-label="Session failed"
                          checked={notify.sessionFailed}
                          onChange={saveNotifyRow('sessionFailed')}
                        />
                      </Row>

                      </ScopeSection>
                      <ScopeSection keys={SECTION_KEYS.delivery}>
                      {/* Canvas 1c DELIVERY: Sound first, then the background-only row. */}
                      <SectionLabel>DELIVERY</SectionLabel>
                      <Row title="Sound" setting={NOTIFICATION_SETTING_KEYS.sound} desc="A soft tone with each notification.">
                        <Toggle aria-label="Sound" checked={notify.sound} onChange={saveNotifyRow('sound')} />
                      </Row>
                      <Row
                        title="Only when Orbital is in the background"
                        setting={NOTIFICATION_SETTING_KEYS.onlyWhenBackground}
                        desc={
                          notifyAnyEvent
                            ? 'A focused map already shows every one of these states, so interrupting over it is noise. Turn this off to be notified even with the window in front of you.'
                            : 'Keeps its default. Applies once a notification above is on.'
                        }
                        dimmed={!notifyAnyEvent}
                      >
                        <Toggle
                          aria-label="Only when Orbital is in the background"
                          checked={notify.onlyWhenBackground}
                          disabled={!notifyAnyEvent}
                          onChange={saveNotifyRow('onlyWhenBackground')}
                        />
                      </Row>
                      {/* The toggles are stored settings either way, so a browser
                    visit can set them and the desktop app honours them the
                    next time it reads them. Saying so beats rows that look
                    broken. */}
                      <p className="pt-3.5 fs-12 leading-[1.5] text-ink-900/55 [text-wrap:pretty]">
                        Notifications are delivered by the desktop app. These settings are saved
                        from the browser too — Orbital picks them up when it next runs.
                      </p>
                      </ScopeSection>
                    </>
                  )}

                  {/* The section's first live row, and the reason its nav item
                stopped being disabled. Its sentence in adr
                settings-sections-split-by-kind is "what a session is allowed
                to touch" — and how consent is given is the gate on exactly
                that, so it belongs here rather than in Appearance, which only
                owns what is drawn. */}
                  {section === 'permissions' && (
                    <>
                      <ScopeSection keys={SECTION_KEYS.approving}>
                      <SectionLabel first>APPROVING</SectionLabel>
                      <Row
                        title="Guarded requests"
                        setting="permission_guard_gesture"
                        desc="Some requests arrive flagged as ones no stray keystroke should approve. This is how much deliberate effort saying yes to those takes. Every other request approves on one click regardless."
                      >
                        <Segmented
                          label="Guarded requests"
                          size="row"
                          options={[
                            { value: 'hold', label: 'Hold' },
                            { value: 'confirm', label: 'Confirm twice' },
                            { value: 'single', label: 'One click' },
                          ]}
                          value={guard}
                          onChange={(value) =>
                            void patchAndSet({ permission_guard_gesture: value })
                          }
                        />
                        <span className="font-mono fs-10 leading-[1.6] text-ink-900/50">
                          {guard === 'hold'
                            ? 'press and hold Approve · from the keyboard, confirms twice instead'
                            : guard === 'confirm'
                              ? 'Approve arms, a second press sends it'
                              : 'no brake — guarded requests approve like any other'}
                        </span>
                      </Row>
                      {/* `Feature - Question Card` 9h drew it as a section of its
                          own at the end of Sessions (spec
                          2026-10-21-question-card-go-back-design § Setting);
                          beside the guard gesture since `Feature - Shared
                          settings` 63a. */}
                      <Row
                        title="Review answers before sending"
                        setting="questions_review_before_send"
                        desc="When every question on a card has an answer, show them all with a Send button instead of sending with the last one. Any answer can be changed until you send. Your phone follows this setting."
                      >
                        <Toggle
                          aria-label="Review answers before sending"
                          checked={reviewAnswers}
                          onChange={(checked) =>
                            void patchAndSet({ questions_review_before_send: checked ? 'true' : 'false' })
                          }
                        />
                      </Row>
                      </ScopeSection>
                    </>
                  )}

                  {section === 'labs' && (
                    <>
                      {/* The lead note of Notifications (canvas `Feature - Notifications off` 1c). */}
                      <p className="pb-2.5 pt-3.5 fs-13 leading-[1.5] text-ink-900/80">
                        Finished features you can try. Each stays off until you turn it on, and any of
                        them may still change, move into the regular settings, or be removed.
                      </p>
                      <ScopeSection keys={SECTION_KEYS.labs}>
                      <SectionLabel first>FEATURES</SectionLabel>
                      <Row
                        title="Harness"
                        setting={HARNESS_ENABLED_KEY}
                        desc="Automated checklists that guide a session through a multi-step task. The session runs steps automatically until it needs your approval or answer."
                      >
                        <Toggle
                          aria-label="Harness"
                          checked={harnessEnabled(settings)}
                          onChange={(checked) =>
                            void patchAndSet({ [HARNESS_ENABLED_KEY]: checked ? 'true' : 'false' })
                          }
                        />
                      </Row>
                      {/* Spec 2026-10-05-embedded-terminal-design § Behind an
                          experimental switch: the switch only; while it is on,
                          the terminal's own settings have their own section. */}
                      <Row
                        title="Terminal"
                        setting={TERMINAL_ENABLED_KEY}
                        desc="Your own shell in the session's folder, as tabs beside the session. What you run in it is not sent to the agent. Its settings are in Terminal. Turning this off leaves running shells running."
                      >
                        <Toggle
                          aria-label="Terminal"
                          checked={terminalEnabled(settings)}
                          onChange={(checked) =>
                            void patchAndSet({ [TERMINAL_ENABLED_KEY]: checked ? 'true' : 'false' })
                          }
                        />
                      </Row>
                      {/* Canvas `Feature - Colour themes`: the switch only; while
                          it is on, the picker is Appearance's COLOURS group (1f). */}
                      <Row
                        title="Colour themes"
                        setting={COLOUR_THEMES_ENABLED_KEY}
                        desc="Offers colour themes in Appearance: Infrared for a bright room, Event Horizon for more contrast, and palettes after Solarized, Monokai, Dracula, Nord, Gruvbox and One Dark."
                      >
                        <Toggle
                          aria-label="Colour themes"
                          checked={colourThemesEnabled(settings)}
                          onChange={(checked) =>
                            void patchAndSet({ [COLOUR_THEMES_ENABLED_KEY]: checked ? 'true' : 'false' })
                          }
                        />
                      </Row>
                      <Row
                        title="Check reports with Claude"
                        setting={ISSUE_CHECK_ENABLED_KEY}
                        desc="In the review before a report goes to Orbital's GitHub, Claude reads it next to the newest issues and says which look like the same thing. One model call on your plan, only when you press Check with Claude."
                      >
                        <Toggle
                          aria-label="Check reports with Claude"
                          checked={settings[ISSUE_CHECK_ENABLED_KEY] === 'true'}
                          onChange={(checked) =>
                            void patchAndSet({ [ISSUE_CHECK_ENABLED_KEY]: checked ? 'true' : 'false' })
                          }
                        />
                      </Row>
                      <LimitSunsLabs
                        settings={settings}
                        apiKey={health?.billing === 'api-key'}
                        patchAndSet={patchAndSet}
                      />
                      </ScopeSection>
                    </>
                  )}

                  {section === 'experimental' && (
                    <>
                      <ScopeSection keys={SECTION_KEYS.experimental}>
                      <SectionLabel first>FEATURES</SectionLabel>
                      <Row
                        title="Archipelago map"
                        setting={ARCHIPELAGO_ENABLED_KEY}
                        desc="Offers Archipelago as a map theme in Appearance. It is not maintained: newer features may be missing from it, and it may break."
                      >
                        <Toggle
                          aria-label="Archipelago map"
                          checked={archipelagoEnabled(settings)}
                          onChange={(checked) =>
                            void patchAndSet({
                              [ARCHIPELAGO_ENABLED_KEY]: checked ? 'true' : 'false',
                            })
                          }
                        />
                      </Row>
                      <Row
                        title="Walkthrough"
                        setting={WALKTHROUGH_ENABLED_KEY}
                        desc="The step-by-step review of what a session changed. Narrate reads the session's record separately and groups the steps under titles; the session itself is never touched."
                      >
                        <Toggle
                          aria-label="Walkthrough"
                          checked={walkthroughEnabled(settings)}
                          onChange={(checked) =>
                            void patchAndSet({
                              [WALKTHROUGH_ENABLED_KEY]: checked ? 'true' : 'false',
                            })
                          }
                        />
                      </Row>
                      <Row
                        title="Narrate model"
                        setting={NARRATE_MODEL_KEY}
                        desc="The model that reads a session's record and writes its narration. Takes effect on the next Narrate."
                      >
                        <ModelCards
                          compact
                          models={models}
                          value={narrateModel(settings)}
                          onChange={(value) => void patchAndSet({ [NARRATE_MODEL_KEY]: value })}
                        />
                      </Row>
                      <Row
                        title="Comment for Narrate"
                        setting={NARRATE_COMMENTARY_KEY}
                        desc="Asks Orbital's sessions to say what they change and why before each change, so Narrate has more to go on. Applies to sessions started or resumed while it is on, and makes them a little chattier."
                      >
                        <Toggle
                          aria-label="Comment for Narrate"
                          checked={narrateCommentary(settings)}
                          onChange={(checked) =>
                            void patchAndSet({
                              [NARRATE_COMMENTARY_KEY]: checked ? 'true' : 'false',
                            })
                          }
                        />
                      </Row>
                      {/* spec 2026-10-21-moon-orbit-limit-design: the limit is on for
                  everyone; only its number is tuned here. No canvas row — it
                  follows the frame-rate sliders' pattern. */}
                      <Row
                        title="Moon orbits"
                        setting={MOON_ORBITS_KEY}
                        desc="The most orbits a planet's subagents share. More moons than fit spread across them, never touching."
                      >
                        <ValueSlider
                          label="Moon orbits"
                          value={moonOrbits(settings)}
                          min={MOON_ORBITS_MIN}
                          max={MOON_ORBITS_MAX}
                          step={1}
                          fallback={MOON_ORBITS_DEFAULT}
                          format={(orbits) => `${orbits} ${orbits === 1 ? 'orbit' : 'orbits'}`}
                          onChange={(next) => void patchAndSet({ [MOON_ORBITS_KEY]: String(next) })}
                        />
                      </Row>
                      </ScopeSection>
                    </>
                  )}

                  {section === 'terminal' && (
                    <>
                      <ScopeSection keys={SECTION_KEYS.terminal}>
                      <SectionLabel first>TERMINAL</SectionLabel>
                      <Row
                        title="Terminal placement"
                        setting={TERMINAL_PLACEMENT_KEY}
                        desc="A dock under the map, or a panel in the side slot the subagent and harness panels use."
                      >
                        <Segmented<TerminalPlacement>
                          label="Terminal placement"
                          size="row"
                          options={TERMINAL_PLACEMENT_OPTIONS}
                          value={terminalPlacement(settings)}
                          onChange={(value) => void patchAndSet({ [TERMINAL_PLACEMENT_KEY]: value })}
                        />
                      </Row>
                      <Row title="Terminal cursor" setting={TERMINAL_CURSOR_KEY} desc="An unfocused cursor is always hollow and never blinks.">
                        <Segmented<TerminalCursor>
                          label="Terminal cursor"
                          size="row"
                          options={TERMINAL_CURSOR_OPTIONS}
                          value={terminalCursor(settings)}
                          onChange={(value) => void patchAndSet({ [TERMINAL_CURSOR_KEY]: value })}
                        />
                      </Row>
                      <Row
                        title="Blinking cursor"
                        setting={TERMINAL_CURSOR_BLINK_KEY}
                        desc="The standard caret blink, only while the terminal has focus. Off, the cursor stays steady."
                      >
                        <Toggle
                          aria-label="Blinking cursor"
                          checked={terminalCursorBlink(settings)}
                          onChange={(checked) =>
                            void patchAndSet({ [TERMINAL_CURSOR_BLINK_KEY]: checked ? 'true' : 'false' })
                          }
                        />
                      </Row>
                      </ScopeSection>
                    </>
                  )}

                  {section === 'appearance' && (
                    <>
                      {/* Canvas `Feature - Colour themes` 1f, above TEXT, while
                          Labs → Colour themes is on. Not in the website's demo,
                          which does not repaint the root either. */}
                      {coloursShown && (
                        <ScopeSection keys={SECTION_KEYS.colours}>
                          <SectionLabel first>COLOURS</SectionLabel>
                          <ColourThemeRows settings={settings} patchAndSet={patchAndSet} />
                        </ScopeSection>
                      )}
                      {/* Not in the website's demo: it does not run the root's scales. */}
                      {!isDemo() && (
                      <ScopeSection keys={SECTION_KEYS.text}>
                      <SectionLabel first={!coloursShown}>TEXT</SectionLabel>
                      {/* canvas `Feature - Text size` 6a */}
                      <Row
                        title="Text size"
                        setting={TEXT_SCALE_KEY}
                        desc="Larger letters across the app; spacing stays as it is. Labels on the map's planets keep their size."
                      >
                        <Segmented
                          label="Text size"
                          size="steps"
                          options={TEXT_SCALE_OPTIONS}
                          value={appTextScale}
                          onChange={(next) => void patchAndSet({ [TEXT_SCALE_KEY]: next })}
                          className="w-full"
                        />
                      </Row>
                      <Row
                        title="Transcript text"
                        setting={TRANSCRIPT_TEXT_SCALE_KEY}
                        desc="The session transcript and its composer can be larger than the panels around them."
                      >
                        <div className="flex w-full flex-col gap-1.5">
                          <Select
                            aria-label="Transcript text"
                            font="sans"
                            options={transcriptTextScaleOptions(appTextScale)}
                            value={transcriptTextScale}
                            onChange={(next) => void patchAndSet({ [TRANSCRIPT_TEXT_SCALE_KEY]: next })}
                            className="w-full"
                          />
                          {transcriptBelowApp(settings) && (
                            <span className="font-mono fs-10 leading-[1.5] tracking-[0.04em] text-ink-900/60">
                              {textScaleName(transcriptTextScale)} is below the app text, so it follows the app at{' '}
                              {textScalePercent(appTextScale)}
                            </span>
                          )}
                        </div>
                      </Row>
                      <TextSample
                        app={textScalePercent(String(resolvedTextScales.app))}
                        transcript={textScalePercent(String(resolvedTextScales.transcript))}
                      />
                      </ScopeSection>
                      )}
                      <ScopeSection keys={SECTION_KEYS.detailPanel}>
                      <SectionLabel first={isDemo()}>DETAIL PANEL</SectionLabel>
                      {/* canvas `Feature - Header gauges` 11c. Per install, not per
                  session: it is a density preference about how a header is
                  drawn, and both modes keep the same click target and the
                  same dialog behind it. */}
                      <Row
                        title="Session stats in the header"
                        setting="header_session_stats"
                        desc="The bar shows busy time, cost and the four-way split without opening anything. Button only keeps the header quiet — the numbers are one click away."
                      >
                        {/* 11c draws the two positions stacked, each its own pill
                    with a ✓ on the selected one. They ship side by side as a
                    segmented control instead, at Tomin's call: it is one
                    choice out of two, and the row reads better without the
                    stack. */}
                        <Segmented
                          label="Session stats in the header"
                          options={HEADER_STATS_OPTIONS}
                          value={headerStats}
                          onChange={(next) => void patchAndSet({ header_session_stats: next })}
                        />
                        <span className="font-mono fs-10 leading-[1.6] text-ink-900/50">
                          applies to every panel · no reload
                        </span>
                      </Row>
                      {/* canvas `Feature - Branch status` 1g: the branch's pull
                  request and line changes, both opt-in, right under the
                  header's other density choice. */}
                      <Row
                        title="Pull request in the header"
                        setting="header_pull_request"
                        desc="Shows the branch's pull request number after the branch. Hover it for state, review and checks; click it to open the PR on GitHub. Uses the gh CLI."
                      >
                        {/* No gap: the line under the switch carries its own 8,
                        inside its fold (`Feature - Feedback` 61c). */}
                        <div className="flex flex-col items-start">
                          <Toggle
                            aria-label="Pull request in the header"
                            checked={prInHeader}
                            disabled={ghBlocked}
                            onChange={(checked) =>
                              void patchAndSet({ header_pull_request: checked ? 'true' : 'false' })
                            }
                          />
                          <GhLine status={gh} brew={ghBrew} onOpenSession={openSession} />
                        </div>
                      </Row>
                      <Row
                        title="Line changes in the header"
                        setting="header_line_changes"
                        desc="What the branch changes against its parent branch, uncommitted work included. Split also shows the uncommitted part on its own."
                      >
                        <Segmented
                          label="Line changes in the header"
                          options={LINE_CHANGES_OPTIONS}
                          value={lineChanges}
                          onChange={(next) => void patchAndSet({ header_line_changes: next })}
                        />
                        {/* 1g: what the choice draws, on a sample branch. */}
                        <span className="flex h-fit min-h-4 items-center gap-2 font-mono fs-11">
                          <span className="fs-10 text-ink-900/50">
                            {lineChangesPreview.length > 0 ? 'e.g.' : 'nothing drawn'}
                          </span>
                          {lineChangesPreview.length > 0 && (
                            <LineGroups groups={lineChangesPreview} />
                          )}
                        </span>
                      </Row>
                      {/* No canvas row; it follows the toggle rows around it. */}
                      <Row
                        title="Close the panel after End session"
                        setting="end_closes_panel"
                        desc="Ending a session with the header's End button also closes its panel. Off keeps the ended session open, its transcript readable."
                      >
                        <Toggle
                          aria-label="Close the panel after End session"
                          checked={endClosesPanelOn}
                          onChange={(checked) =>
                            void patchAndSet({ end_closes_panel: checked ? 'true' : 'false' })
                          }
                        />
                      </Row>

                      </ScopeSection>
                      <ScopeSection keys={SECTION_KEYS.map}>
                      <SectionLabel>MAP</SectionLabel>
                      <Row
                        title="Theme"
                        setting="map_theme"
                        desc="How the map is drawn. Planets is the familiar space view; Desk is an alternative renderer with the same functionality."
                      >
                        <Segmented
                          label="Map theme"
                          options={mapThemeOptions(settings)}
                          value={theme}
                          onChange={(next) => void patchAndSet({ map_theme: next })}
                        />
                      </Row>
                      {theme === 'planets' && (
                        <>
                          <Row
                            title="Default planet size"
                            setting="planet_scale"
                            desc="Baseline scale for every body on the map. Tier differences are preserved — this multiplies the whole family. Orbit radii and zoom are unaffected."
                          >
                            <div className="flex w-full flex-col gap-[9px]">
                              <div className="flex items-baseline gap-2">
                                <span className="font-mono fs-15 text-ink-100">
                                  {planetScale.toFixed(2)}×
                                </span>
                                <span className="font-mono fs-10.5 text-ink-900/60">
                                  {scaleNote}
                                </span>
                                <span className="flex-1" />
                                <button
                                  type="button"
                                  onClick={() => setPlanetScale(1)}
                                  className="rounded-full border border-line/14 px-[9px] py-[3px] font-mono fs-10 tracking-[0.1em] text-ink-800/85 transition-colors hover:border-line/26 hover:bg-line/7 hover:text-ink-400"
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
                              <div className="flex justify-between font-mono fs-10 tracking-[0.06em] text-ink-900/55">
                                <span>0.70×</span>
                                <span>1.00×</span>
                                <span>1.60×</span>
                              </div>
                            </div>
                          </Row>

                          {/* Collapsible preview row (canvas 5a): full-width header
                  button, the tier strip animates shut instead of unmounting. */}
                          <div className="flex flex-col gap-3 border-t border-line/8 py-[13px]">
                            <button
                              type="button"
                              aria-expanded={previewOpen}
                              onClick={() => setPreviewOpen((v) => !v)}
                              className="flex items-start gap-2.5 text-left"
                            >
                              <span
                                aria-hidden
                                className="mt-[1px] grid h-4 w-4 flex-none place-items-center fs-9 text-ink-900/70 transition-transform duration-[180ms]"
                                style={{ transform: previewOpen ? undefined : 'rotate(-90deg)' }}
                              >
                                ▾
                              </span>
                              <span className="flex-1">
                                <span className="flex items-center gap-2">
                                  <span className="fs-13.5 font-semibold text-ink-100">
                                    Preview
                                  </span>
                                  {!previewOpen && (
                                    <span className="font-mono fs-10 tracking-[0.1em] text-ink-900/55">
                                      collapsed
                                    </span>
                                  )}
                                </span>
                                <span className="mt-1 block fs-12 leading-[1.5] text-ink-900/70 [text-wrap:pretty]">
                                  The three size tiers at the current scale: ended, live, live with
                                  subagents. Labels keep their 10 px mono floor at every scale.
                                </span>
                              </span>
                            </button>
                            <div
                              className="box-border flex items-center justify-around gap-7 overflow-hidden rounded-[10px] border-line/10 bg-shade/50"
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
                        </>
                      )}

                      <Row
                        title="Scale labels with bodies"
                        setting="map_scale_labels"
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
                      <Row title="Model name under planet label" setting="map_show_model" desc="Family only (no version).">
                        <div className="flex items-center gap-3">
                          <Toggle
                            aria-label="Model name under planet label"
                            checked={mapShowModel}
                            onChange={(checked) =>
                              void patchAndSet({ map_show_model: checked ? 'true' : 'false' })
                            }
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
                              className="font-mono fs-9.5 text-ink-900/70"
                            >
                              <span className="text-ink-900/60">e.g. </span>
                              <span className="tracking-[0.1em]">{mapModelSample}</span>
                            </span>
                          )}
                        </div>
                      </Row>
                      {/* ADR state-labels-are-dots-first-on-the-map: dot-first
                  (24e) is the default, the always-spelled-out pills (24a)
                  are the alternative. The sidebar, the detail chip and the
                  summary line spell the word out either way. */}
                      <Row
                        title="State on the map"
                        setting="map_state_pills"
                        desc="Dot keeps the map calm: each planet's state is a small coloured dot, spelled out when you point at the planet. Label always spells it out."
                      >
                        <Segmented
                          label="State on the map"
                          size="row"
                          options={STATE_PILL_OPTIONS}
                          value={statePills}
                          onChange={(next) => void patchAndSet({ map_state_pills: next })}
                        />
                        <span className="font-mono fs-10 leading-[1.6] text-ink-900/50">
                          {statePills === 'dot'
                            ? 'the word slides out on hover'
                            : 'every state pill spells its word'}
                        </span>
                      </Row>

                      {/* Frame budget (spec 2026-09-24-map-frame-budget-design):
                  in the planet-size pattern until Claude Design gives these
                  rows an artboard of their own. */}
                      <Row
                        title="Frame rate while focused"
                        setting="map_fps_focused"
                        desc="Most frames a second the map draws while something on it moves and the window has focus. A still map draws nothing."
                      >
                        <ValueSlider
                          label="Frame rate while focused"
                          value={mapFps.focused}
                          min={MAP_FPS_FOCUSED_MIN}
                          max={MAP_FPS_FOCUSED_MAX}
                          step={MAP_FPS_FOCUSED_STEP}
                          fallback={MAP_FPS_FOCUSED_DEFAULT}
                          onChange={(next) => setMapFps('map_fps_focused', next)}
                        />
                      </Row>
                      <Row
                        title="Frame rate in the background"
                        setting="map_fps_background"
                        desc="The same cap while another window has focus. At 0 the map pauses until you come back. A hidden window never draws."
                      >
                        <ValueSlider
                          label="Frame rate in the background"
                          value={mapFps.background}
                          min={MAP_FPS_BACKGROUND_MIN}
                          max={MAP_FPS_BACKGROUND_MAX}
                          step={MAP_FPS_BACKGROUND_STEP}
                          fallback={MAP_FPS_BACKGROUND_DEFAULT}
                          onChange={(next) => setMapFps('map_fps_background', next)}
                        />
                      </Row>
                      {/* spec 2026-09-24-sessions-end-only-by-hand-design § 3. No
                  canvas row yet — the Claude Design brief asks for one; until
                  then it follows the rows around it. */}
                      <Row
                        title="Show trash"
                        setting="map_show_trash"
                        desc="The corner of the map where dropping an Orbital session ends it. Off hides it and the gesture; the End button in a session's header works either way."
                      >
                        <Toggle
                          aria-label="Show trash"
                          checked={mapShowTrash}
                          onChange={(checked) =>
                            void patchAndSet({ map_show_trash: checked ? 'true' : 'false' })
                          }
                        />
                      </Row>

                      </ScopeSection>

                      {/* Its own kicker rather than three more rows under MAP: the
                  thresholds colour sidebar rows and gate the /compact badge
                  too, so filing them under a heading that says "map" would
                  misdescribe them (adr settings-sections-split-by-kind). */}
                      <ScopeSection keys={SECTION_KEYS.contextUsage}>
                      <SectionLabel>CONTEXT USAGE</SectionLabel>
                      {/* canvas 1h: master switch for the arc, its ticks and the
                  /compact badge (spec context-fill-arc). Not itself in the
                  canvas — 1h's "Planet size: Context/Fixed" radio is the
                  control it replaces, per the scope cut agreed with the
                  owner. */}
                      <Row
                        title="Context usage on planets"
                        setting="map_show_context"
                        desc="A thin arc around each running web session showing how full its context window is. Terminal sessions have no usage data and never show one."
                      >
                        <Toggle
                          aria-label="Context usage on planets"
                          checked={mapShowContext}
                          onChange={(checked) =>
                            void patchAndSet({ map_show_context: checked ? 'true' : 'false' })
                          }
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
                        setting={['context_threshold_warn', 'context_threshold_critical', 'map_show_compact_badge']}
                        desc="Arc turns amber above the first, red + pulse above the second. Sidebar rows and the /compact badge follow the same values."
                      >
                        <div className="flex items-center gap-3.5">
                          <span
                            aria-hidden
                            className="h-[2px] w-[26px]"
                            style={{ background: 'oklch(80% .13 210 / .6)' }}
                          />
                          <label className="flex items-center gap-1.5 font-mono fs-12 leading-(--text-xs--line-height) text-ink-900/70">
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
                          <span
                            aria-hidden
                            className="h-[2px] w-[26px]"
                            style={{ background: 'oklch(80% .13 60)' }}
                          />
                          <label className="flex items-center gap-1.5 font-mono fs-12 leading-(--text-xs--line-height) text-ink-900/70">
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
                          <span
                            aria-hidden
                            className="h-[2px] w-[26px]"
                            style={{ background: 'oklch(72% .17 25)' }}
                          />
                        </div>
                        <Checkbox
                          checked={mapShowCompactBadge}
                          onChange={(checked) =>
                            void patchAndSet({ map_show_compact_badge: checked ? 'true' : 'false' })
                          }
                          label={'Show “/compact” badge above the second threshold'}
                        />
                      </Row>

                      {/* Its own kicker rather than a row under MAP or CONTEXT USAGE:
                  the transcript is neither, and per adr
                  settings-sections-split-by-kind a kicker that misdescribes
                  its rows is the thing that split this dialog in the first
                  place. In Appearance rather than Sessions because it changes
                  only what is drawn (canvas `Feature - Transcript blocks`
                  20f, which drew it under Sessions). */}
                      </ScopeSection>
                      <ScopeSection keys={SECTION_KEYS.transcript}>
                      <SectionLabel>TRANSCRIPT</SectionLabel>
                      <Row
                        title="Edit diffs"
                        setting={['transcript_edit_diffs', 'transcript_expand_diff_on_permission']}
                        desc="How Edit and Write rows arrive in the transcript. Expanded shows a preview — the first hunk, at most a few lines — and opening a row by hand still shows all of it. Rows you have toggled keep your choice."
                      >
                        <Segmented
                          label="Edit diffs"
                          size="row"
                          options={[
                            { value: 'collapsed', label: 'Collapsed' },
                            { value: 'expanded', label: 'Expanded' },
                          ]}
                          value={editDiffs}
                          onChange={(value) => void patchAndSet({ transcript_edit_diffs: value })}
                        />
                        <Checkbox
                          checked={expandDiffOnPermissionRow}
                          onChange={(checked) =>
                            void patchAndSet({
                              transcript_expand_diff_on_permission: checked ? 'true' : 'false',
                            })
                          }
                          label="Always expand an edit waiting for your permission"
                        />
                      </Row>
                      </ScopeSection>
                    </>
                  )}

                  {section === 'sessions' && (
                    <>
                      <ScopeSection keys={SECTION_KEYS.newSessions}>
                      <SectionLabel first>NEW SESSIONS</SectionLabel>
                      <Row
                        title="Default model"
                        setting={['default_model', 'remember_model_per_project']}
                        desc="Pre-selected in the New session dialog. Never changes a running session."
                      >
                        <ModelCards
                          compact
                          models={models}
                          value={defaultModel || null}
                          onChange={(value) => {
                            setOtherModelPicked(false)
                            void patchAndSet({ default_model: value })
                          }}
                          other={{
                            active: defaultModelOtherActive,
                            onSelect: () => setOtherModelPicked(true),
                          }}
                        />
                        {defaultModelOtherActive && models.length > 0 && (
                          // Written only once the id validates; typing over it or a
                          // rejected id leaves the stored default as it was.
                          <CustomModelField
                            size="sm"
                            initial={
                              defaultIsCustom ? { id: defaultModel, trusted: true } : undefined
                            }
                            onValidated={(id) => void patchAndSet({ default_model: id })}
                            onCleared={() => {}}
                          />
                        )}
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
                        setting="default_permission_mode"
                        desc="Applied to every new session. Can be changed per session."
                      >
                        <ModeCards
                          compact
                          value={defaultPermissionMode}
                          onChange={(mode) => void patchAndSet({ default_permission_mode: mode })}
                        />
                      </Row>
                      <Row
                        title="Default project directory"
                        setting="default_project_dir"
                        desc="Pre-filled in the New session dialog."
                      >
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
                      <Row
                        title="Name sessions automatically"
                        setting="name_sessions_automatically"
                        desc="Asks a model (Haiku, billed like your sessions) to name each session Orbital starts from its first message, once. Off, a session is named after its first sentence; ⟳ beside a title names any session."
                      >
                        <Toggle
                          aria-label="Name sessions automatically"
                          checked={nameSessions}
                          onChange={(checked) =>
                            void patchAndSet({ name_sessions_automatically: checked ? 'true' : 'false' })
                          }
                        />
                      </Row>
                      </ScopeSection>
                      <ScopeSection keys={SECTION_KEYS.clear}>
                      <SectionLabel>CLEAR &amp; LIFECYCLE</SectionLabel>
                      <Row
                        title="Confirm before Clear"
                        setting="confirm_before_clear"
                        desc={`Show the confirmation dialog when running /clear or ${chordLabel(command('session.clear').chords[0])}.`}
                      >
                        <Toggle
                          aria-label="Confirm before clear"
                          checked={confirmBeforeClear}
                          onChange={(checked) =>
                            void patchAndSet({ confirm_before_clear: checked ? 'true' : 'false' })
                          }
                        />
                      </Row>
                      </ScopeSection>
                      <ScopeSection keys={SECTION_KEYS.instructions}>
                      <SectionLabel>INSTRUCTIONS</SectionLabel>
                      <Row
                        title="Orbital's tips"
                        setting="session_instructions_tips"
                        desc="Short instructions every session Orbital starts receives, so the model uses what Orbital can show: choices as cards, clickable file paths, background tasks. Applies from the next start."
                      >
                        <Toggle
                          aria-label="Orbital's tips"
                          checked={instructionTips}
                          onChange={(checked) =>
                            void patchAndSet({
                              session_instructions_tips: checked ? 'true' : 'false',
                            })
                          }
                        />
                      </Row>
                      {tips && (
                        <div className="flex flex-col gap-3 border-t border-line/8 py-[13px]">
                          <button
                            type="button"
                            aria-expanded={tipsOpen}
                            onClick={() => setTipsOpen((v) => !v)}
                            className="flex items-start gap-2.5 text-left"
                          >
                            <span
                              aria-hidden
                              className="mt-[1px] grid h-4 w-4 flex-none place-items-center fs-9 text-ink-900/70 transition-transform duration-[180ms]"
                              style={{ transform: tipsOpen ? undefined : 'rotate(-90deg)' }}
                            >
                              ▾
                            </span>
                            <span className="flex-1">
                              <span className="flex items-center gap-2">
                                <span className="fs-13.5 font-semibold text-ink-100">
                                  Show the tips
                                </span>
                                {!tipsOpen && (
                                  <span className="font-mono fs-10 tracking-[0.1em] text-ink-900/55">
                                    collapsed
                                  </span>
                                )}
                              </span>
                              <span className="mt-1 block fs-12 leading-[1.5] text-ink-900/70 [text-wrap:pretty]">
                                The exact text the server appends. Read-only: to change a tip, turn
                                the layer off and write your own version below.
                              </span>
                            </span>
                          </button>
                          {tipsOpen && (
                            <ul
                              className="flex flex-col gap-3 rounded-[10px] border border-line/10 bg-shade/50 px-5 py-4"
                              style={{ opacity: instructionTips ? 1 : 0.5 }}
                            >
                              {tips.map((tip) => (
                                <li key={tip.id}>
                                  <div className="fs-12.5 font-semibold text-ink-100">
                                    {tip.title}
                                  </div>
                                  <div className="mt-1 fs-12 leading-[1.5] text-ink-900/70 [text-wrap:pretty]">
                                    {tip.text}
                                  </div>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                      <Row
                        title="Your instructions"
                        setting={['session_instructions_custom', 'session_instructions_custom_text']}
                        desc="Your own text, appended to every session Orbital starts, after the tips. Applies from the next start. For one project, use that project's CLAUDE.md instead."
                      >
                        <Toggle
                          aria-label="Your instructions"
                          checked={instructionCustom}
                          onChange={(checked) =>
                            void patchAndSet({
                              session_instructions_custom: checked ? 'true' : 'false',
                            })
                          }
                        />
                      </Row>
                      <div className="border-t border-line/8 py-[13px]">
                        <TextArea
                          aria-label="Your instructions text"
                          size="sm"
                          rows={5}
                          value={instructionsDraft}
                          onChange={(e) => setInstructionsDraft(e.target.value)}
                          placeholder="For example: answer in Czech, keep replies short…"
                          className="resize-y"
                        />
                      </div>
                      </ScopeSection>
                      {/* `Feature - Plan limits` 31c (spec
                          2026-10-03-usage-limits-design § 1 "Settings"). */}
                      <ScopeSection keys={SECTION_KEYS.limits}>
                      <SectionLabel>LIMITS</SectionLabel>
                      <Row
                        title="Continue automatically after a limit reset"
                        setting={AUTO_CONTINUE_KEY}
                        desc="When a session hits a plan limit, it waits. With this on, it sends the message below as soon as the window resets. With it off, the session stays idle until you write."
                      >
                        <Toggle
                          aria-label="Continue automatically after a limit reset"
                          checked={autoContinue}
                          onChange={(checked) =>
                            void patchAndSet({ [AUTO_CONTINUE_KEY]: checked ? 'true' : 'false' })
                          }
                        />
                      </Row>
                      <div
                        className="transition-opacity duration-200 ease-[ease]"
                        style={{ opacity: autoContinue ? 1 : 0.45 }}
                      >
                        <Row
                          title="Message sent on continue"
                          setting={CONTINUE_TEXT_KEY}
                          desc="Sent as an ordinary user message, so it shows in the transcript like anything you type."
                        >
                          <TextArea
                            aria-label="Message sent on continue"
                            size="sm"
                            rows={4}
                            value={continueDraft}
                            disabled={!autoContinue}
                            onChange={(e) => setContinueDraft(e.target.value)}
                            className="resize-y"
                          />
                          <div className="flex w-full items-center gap-2.5 font-mono fs-10 text-ink-900/50">
                            <span>{continueIsDefault ? 'default text' : 'edited'}</span>
                            <span className="flex-1" />
                            <button
                              type="button"
                              disabled={continueIsDefault || !autoContinue}
                              onClick={() => setContinueDraft(DEFAULT_CONTINUE_TEXT)}
                              className="cursor-pointer border-0 bg-transparent p-0 font-mono fs-10 tracking-[0.12em] disabled:cursor-default"
                              style={{
                                color: continueIsDefault ? swatch('ink-900', 0.3) : swatch('sky'),
                              }}
                            >
                              RESET TO DEFAULT
                            </button>
                          </div>
                        </Row>
                      </div>
                      </ScopeSection>
                    </>
                  )}
                </div>
              )}
            </div>
            </SharingProvider>
          </Panel>
        </div>
        {/* 61c: the review dialog stacks over Settings; Escape peels it first. */}
        <ReportDialog
          open={feedback.open}
          kind={feedback.kind}
          onClose={() => setFeedback((current) => ({ ...current, open: false }))}
        />
      </div>
    </EscapeBoundary>
  )
}
