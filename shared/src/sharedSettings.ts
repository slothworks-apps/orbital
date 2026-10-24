/**
 * The settings a group shares, and how members settle on one value (spec
 * 2026-10-24-group-shared-settings-design, ADR
 * group-settings-converge-by-last-change). Every device in a group belongs
 * to one person: a habit set on one Mac applies on every Mac and server in
 * it. Machine paths, layout and desktop notifications stay on each device.
 */

/**
 * The hello capability of a device that takes part: it answers
 * `GET`/`POST /api/settings/shared`, pushes its changes and catches up.
 * A member whose hello lacks it neither sends nor receives.
 */
export const SETTINGS_SYNC_CAPABILITY = 'settings-sync';

/** Shared across the group: the person's habits. */
export const SHARED_SETTING_KEYS: readonly string[] = [
  'default_permission_mode', 'default_model', 'remember_model_per_project',
  'confirm_before_clear', 'end_closes_panel', 'name_sessions_automatically',
  'transcript_edit_diffs', 'transcript_expand_diff_on_permission',
  'permission_guard_gesture', 'questions_review_before_send',
  'context_threshold_warn', 'context_threshold_critical',
  'session_instructions_tips', 'session_instructions_custom', 'session_instructions_custom_text',
  'limits_auto_continue', 'limits_continue_text',
  // What the map and header show.
  'map_show_model', 'map_show_trash', 'map_show_context', 'map_show_compact_badge', 'map_state_pills',
  'map_scale_labels', 'header_session_stats', 'header_pull_request', 'header_line_changes',
  // The look.
  'map_theme', 'map_limit_sun_style', 'map_limit_sun_colors',
  // The Labs switches.
  'harness_enabled', 'walkthrough_enabled', 'archipelago_enabled', 'limit_suns_enabled',
];

/**
 * Kept on each device, said out loud so that a new setting has to be
 * placed in one class or the other (a test fails on one in neither). Every
 * `remote_` key and every `new_session_last_` key is per device by its
 * prefix (`isPerDeviceSetting`), whether listed here or not.
 */
export const PER_DEVICE_SETTING_KEYS: readonly string[] = [
  // The machine.
  'claude_executable_path', 'default_project_dir', 'default_claude_dir', 'update_auto_download',
  // History: a shared value would delete another Mac's sessions without the confirmation the local dialog asks for.
  'delete_sessions_older_than_days',
  // The layout.
  'sidebar_collapsed', 'sidebar_width', 'detail_panel_width', 'planet_scale',
  'map_fps_focused', 'map_fps_background', 'map_limit_sun_positions', 'settings_last_section',
  // Desktop notifications: each Mac sets its own.
  'notify_needs_input', 'notify_session_ended', 'notify_session_failed', 'notify_sound',
  'notify_only_when_background', 'notify_tip',
  // Bookkeeping.
  'whats_new_seen', 'models_catalog', 'model_context_windows', 'cli_built_in_commands',
];

const PER_DEVICE_PREFIXES = ['remote_', 'new_session_last_'];

const SHARED: ReadonlySet<string> = new Set(SHARED_SETTING_KEYS);

/** Whether `key` is one the group shares; any key not listed stays on its device. */
export function isSharedSetting(key: string): boolean {
  return SHARED.has(key);
}

/** Whether `key` is explicitly classified as this device's own. */
export function isPerDeviceSetting(key: string): boolean {
  return PER_DEVICE_SETTING_KEYS.includes(key) || PER_DEVICE_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * How far ahead of the receiver's clock a stamp may be: a later one is
 * clamped to this bound, so one member's wrong clock cannot pin a value
 * forever.
 */
export const SETTINGS_STAMP_SKEW_MS = 5 * 60_000;

/**
 * When a shared value was set and on which device. `at`: wall-clock ms; 0
 * for a seeded default or a value from before sync, -1 after this device
 * joined a group (every value already in it beats it). `origin`: the
 * device the value was set on, kept unchanged by every member that takes
 * it.
 */
export type SettingStamp = { at: number; origin: string };

/** A shared value with its stamp, as the routes carry it. */
export type StampedSetting = { value: string; at: number; origin: string };

/**
 * Whether `a` beats `b`: the later time wins; on equal times the group's
 * primary as origin, then the higher origin id. Pure, so every member
 * settles on the same value whichever side compares. Two equal stamps:
 * neither beats the other.
 */
export function stampBeats(a: SettingStamp, b: SettingStamp, primary: string | null): boolean {
  if (a.at !== b.at) return a.at > b.at;
  if (a.origin === b.origin) return false;
  if (primary !== null) {
    if (a.origin === primary) return true;
    if (b.origin === primary) return false;
  }
  return a.origin > b.origin;
}

/**
 * A pushed or listed body read leniently: only shared keys, each with a
 * string value, a finite time and a non-empty origin; anything else is
 * dropped. A time past `maxAt` is clamped to it.
 */
export function readStampedSettings(raw: unknown, maxAt: number): Record<string, StampedSetting> {
  const out: Record<string, StampedSetting> = {};
  const settings = raw && typeof raw === 'object' ? (raw as { settings?: unknown }).settings : undefined;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return out;
  for (const [key, entry] of Object.entries(settings as Record<string, unknown>)) {
    if (!isSharedSetting(key) || !entry || typeof entry !== 'object') continue;
    const { value, at, origin } = entry as Record<string, unknown>;
    if (typeof value !== 'string' || typeof at !== 'number' || !Number.isFinite(at) || typeof origin !== 'string' || origin === '') continue;
    out[key] = { value, at: Math.min(at, maxAt), origin };
  }
  return out;
}

/**
 * The hub topic that tells this device's own windows that shared values
 * changed under them, taken from another member: `{ event: 'changed',
 * settings: { key: value } }`. Local only: no member or phone may watch it.
 */
export const SETTINGS_TOPIC = 'settings';

/** The route members read and push shared values on. */
export const SHARED_SETTINGS_PATH = '/api/settings/shared';
