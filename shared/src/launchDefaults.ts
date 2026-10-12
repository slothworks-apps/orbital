/**
 * What a new session launches with when its tag carries defaults (spec
 * 2026-10-13-tag-defaults-design). One rule for the server's launch route,
 * `spawn_session`, the Mac's New session dialog and the phone's screen, so
 * what a client preselects is what the server would have chosen.
 */

/**
 * A tag's launch defaults, as `GET /api/tags` carries them. Null: the tag
 * has none, the global default applies. Absent: a Mac from before the
 * feature, which reads the same as null.
 */
export interface TagLaunchDefaults {
  claude_dir_id?: number | null;
  model?: string | null;
  permission_mode?: string | null;
}

/** The three values a launch is configured with. */
export interface LaunchConfig<Mode extends string = string> {
  claudeDirId: number | null;
  model: string | null;
  permissionMode: Mode;
}

/** A configured Claude directory, as far as a launch needs to know it. */
export interface LaunchClaudeDir {
  id: number;
  /** False when it is missing on disk; absent counts as present. */
  exists?: boolean;
  /** Its usage limit is used up (`claudeDirExhausted`); absent counts as not. */
  exhausted?: boolean;
}

/**
 * Where the directory came from: the tag's own, the main default because
 * the tag's was used up, or the caller's global default (the tag names none,
 * or names one that is no longer configured or is missing on disk).
 */
export type LaunchClaudeDirSource = 'tag' | 'tag_exhausted' | 'global';

/**
 * The effective launch defaults for a tag: per value, the tag's when it has
 * one, else `global`. A tag's directory whose limit is used up gives way to
 * `defaultClaudeDirId`, the main default directory. The request's own
 * values are not this function's business: a value the request names wins
 * over everything here.
 */
export function effectiveLaunchDefaults<Mode extends string>(input: {
  tag: TagLaunchDefaults | null | undefined;
  global: LaunchConfig<Mode>;
  /** The main default directory (`default_claude_dir`). */
  defaultClaudeDirId: number | null;
  claudeDirs: readonly LaunchClaudeDir[];
}): LaunchConfig<Mode> & { claudeDirFrom: LaunchClaudeDirSource } {
  const { tag, global, defaultClaudeDirId, claudeDirs } = input;
  let claudeDirId = global.claudeDirId;
  let claudeDirFrom: LaunchClaudeDirSource = 'global';
  const own = tag?.claude_dir_id;
  const dir = own == null ? undefined : claudeDirs.find((d) => d.id === own);
  if (dir && dir.exists !== false) {
    if (dir.exhausted === true) {
      claudeDirId = defaultClaudeDirId ?? global.claudeDirId;
      claudeDirFrom = 'tag_exhausted';
    } else {
      claudeDirId = dir.id;
      claudeDirFrom = 'tag';
    }
  }
  return {
    claudeDirId,
    claudeDirFrom,
    model: tag?.model || global.model,
    permissionMode: (tag?.permission_mode || global.permissionMode) as Mode,
  };
}

/** One directory's cached limits, in the shape `GET /api/limits` lists them. */
export interface ClaudeDirLimitsReading {
  tracked: boolean;
  windows: ReadonlyArray<{ percent: number; resetsAt: string | null }>;
  waits: ReadonlyArray<unknown>;
}

/**
 * Whether a directory's usage limit is used up: a window at 100 % that has
 * not reset yet, or a session of it waiting for a reset. Reads the cached
 * snapshot only; an untracked directory (an API key, a plan without
 * windows) is never used up.
 */
export function claudeDirExhausted(reading: ClaudeDirLimitsReading, now: number): boolean {
  if (!reading.tracked) return false;
  if (reading.waits.length > 0) return true;
  return reading.windows.some((w) => {
    if (w.percent < 100) return false;
    const resets = w.resetsAt === null ? NaN : Date.parse(w.resetsAt);
    return Number.isNaN(resets) || resets > now;
  });
}
