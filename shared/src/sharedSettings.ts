/**
 * The settings a group shares, and how members settle on one value (spec
 * 2026-10-24-group-shared-settings-design, ADR
 * group-settings-converge-by-last-change). Every device in a group belongs
 * to one person: a habit set on one Mac applies on every Mac and server in
 * it. Machine paths, layout and desktop notifications stay on each device.
 */

/**
 * The hello capability of a device that takes part: it answers
 * `GET`/`POST /api/settings/shared` (settings and tags), pushes its changes
 * and catches up.
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
  // The feature switches.
  'harness_enabled', 'walkthrough_enabled', 'archipelago_enabled', 'limit_suns_enabled',
  // Found after the first list (spec § Which settings are shared).
  'map_moon_orbits', 'stats_show_human_wait', 'narrate_model', 'narrate_commentary',
  'issue_check_enabled', 'issue_check_model', 'terminal_enabled', 'terminal_cursor', 'terminal_cursor_blink',
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
  // Text size: a laptop and a desk monitor want different sizes.
  'text_scale', 'transcript_text_scale',
  'map_fps_focused', 'map_fps_background', 'map_limit_sun_positions', 'settings_last_section',
  // Desktop notifications: each Mac sets its own.
  'notify_needs_input', 'notify_session_ended', 'notify_session_failed', 'notify_sound',
  'notify_only_when_background', 'notify_tip',
  // Bookkeeping.
  'whats_new_seen', 'models_catalog', 'model_context_windows', 'cli_built_in_commands',
  // Found after the first list: the terminal's place on this screen, and what this device has shown or unlocked.
  'terminal_placement', 'terminal_dock_height', 'gh_tip', 'experimental_unlocked',
  // The colour theme: a bright room and macOS's appearance belong to this Mac, as text size does.
  'colour_theme', 'colour_theme_follow_system', 'colour_theme_light', 'colour_theme_dark',
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
 * One tag of the list the group shares (spec § Tags), as the routes carry it:
 * its id across the group, the shared fields, and the stamp of their last
 * change. Never the clump's anchor on the map: that is each device's layout.
 * `deleted`: a tombstone, the tag deleted at `at`; its name lets a member
 * that knows the tag only by name delete it too, and a later tag of the same
 * name wins over it.
 */
export type StampedTag = {
  uuid: string;
  name: string;
  hue: number;
  isDefault: boolean;
  at: number;
  origin: string;
  deleted?: true;
};

/** The longest group id and tag name a member's body may carry; anything longer is dropped. */
const TAG_UUID_MAX = 64;
const TAG_NAME_MAX = 200;

/**
 * The `tags` of a pushed or listed body read leniently, as
 * `readStampedSettings` reads its settings: an entry without a usable group
 * id, name, hue or stamp is dropped, and a time past `maxAt` is clamped.
 */
export function readStampedTags(raw: unknown, maxAt: number): StampedTag[] {
  const tags = raw && typeof raw === 'object' ? (raw as { tags?: unknown }).tags : undefined;
  if (!Array.isArray(tags)) return [];
  const out: StampedTag[] = [];
  for (const entry of tags) {
    if (!entry || typeof entry !== 'object') continue;
    const { uuid, name, hue, isDefault, at, origin, deleted } = entry as Record<string, unknown>;
    if (typeof uuid !== 'string' || uuid === '' || uuid.length > TAG_UUID_MAX) continue;
    if (typeof name !== 'string' || name.trim() === '' || name.length > TAG_NAME_MAX) continue;
    if (typeof at !== 'number' || !Number.isFinite(at) || typeof origin !== 'string' || origin === '') continue;
    const stamp = { at: Math.min(at, maxAt), origin };
    if (deleted === true) {
      out.push({ uuid, name, hue: 0, isDefault: false, ...stamp, deleted: true });
      continue;
    }
    if (typeof hue !== 'number' || !Number.isFinite(hue) || typeof isDefault !== 'boolean') continue;
    out.push({ uuid, name, hue, isDefault, ...stamp });
  }
  return out;
}

/**
 * The hub topic that tells this device's own windows that shared values
 * changed under them, taken from another member: `{ event: 'changed',
 * settings: { key: value } }`, or `{ event: 'tags' }` when the tag list
 * did (read it again, and the sessions whose tags it moved). Local only: no
 * member or phone may watch it.
 */
export const SETTINGS_TOPIC = 'settings';

/** The route members read and push shared values on: `{ settings, tags }`, either part optional in a push. */
export const SHARED_SETTINGS_PATH = '/api/settings/shared';
