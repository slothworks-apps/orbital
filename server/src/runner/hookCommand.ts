import { statSync } from 'node:fs';
import { join } from 'node:path';
import { localSettingsPath, readObject } from '../mcp/mcpjson.js';

/**
 * The command a running hook runs, for its live row (canvas `Feature - Stop
 * hook` 1e "NAMING"). The SDK's hook events name the event and the tool it
 * runs for, never the command, so it is read from the settings the CLI reads
 * hooks from: `settings.json` in the session's Claude directory, and the
 * project's `.claude/settings.json` and `.claude/settings.local.json`.
 *
 * Named only when it cannot be wrong: every hook those files configure for
 * the event and the tool is a plain command, and the CLI started exactly as
 * many as they configure. Hooks the files do not show — a plugin's, a
 * managed policy's — would make the count differ, and the runner then names
 * none.
 */

/** The events whose hooks run per tool call, and whose `hook_name` carries the tool (`PreToolUse:Bash`). */
export const TOOL_HOOK_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied',
]);

/**
 * What the CLI matched the hook against, out of the SDK's `hook_name`: the
 * part after `<event>:` (the tool, a `SessionStart` source, a `PreCompact`
 * trigger), or null for an event that matches nothing (`Stop`).
 */
export function hookMatchQuery(hookName: unknown, event: string): string | null {
  if (typeof hookName !== 'string' || !hookName.startsWith(`${event}:`)) return null;
  const query = hookName.slice(event.length + 1);
  return query === '' ? null : query;
}

/**
 * The longest matcher compiled as a pattern. A hook's matcher is the user's
 * own setting, but the row reads it on every publish; a longer one is not
 * guessed at, and the command goes unnamed.
 */
export const MAX_MATCHER_PATTERN_LENGTH = 256;

/**
 * Whether a matcher group applies to `query`, as the CLI reads matchers: none
 * or `*` matches everything, a plain name or a list (`A|B`, `A, B`) matches
 * by name, and anything else is a regular expression. `undefined` for a
 * pattern that does not compile or is too long to try — the CLI skips such
 * a group, but it is not this one's to guess.
 */
function matcherApplies(matcher: unknown, query: string | null): boolean | undefined {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true;
  if (typeof matcher !== 'string') return undefined;
  // An event that matches nothing runs every group, whatever it says.
  if (query === null) return true;
  if (/^[a-zA-Z0-9_|, -]+$/.test(matcher)) {
    return matcher.split(/[|,]/).map((name) => name.trim()).includes(query);
  }
  if (matcher.length > MAX_MATCHER_PATTERN_LENGTH) return undefined;
  try {
    return new RegExp(matcher).test(query);
  } catch {
    return undefined;
  }
}

/**
 * The commands configured for `event` (and `query`, the tool or source it
 * ran for) across `sources`, in the order the CLI reads them, or null where
 * the settings cannot say for sure what runs: hooks turned off or limited to
 * managed ones, a hook that is no command or runs only under an `if`, or a
 * matcher this cannot read. The CLI runs one copy of a command configured in
 * two files, so a repeat counts once.
 */
export function configuredHookCommands(
  sources: readonly (Record<string, unknown> | null)[],
  event: string,
  query: string | null,
): string[] | null {
  const commands: string[] = [];
  for (const source of sources) {
    if (!source) continue;
    if (source.disableAllHooks === true || source.allowManagedHooksOnly === true) return null;
    const hooks = source.hooks;
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) continue;
    const groups = (hooks as Record<string, unknown>)[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== 'object') return null;
      const { matcher, hooks: entries } = group as { matcher?: unknown; hooks?: unknown };
      const applies = matcherApplies(matcher, query);
      if (applies === undefined) return null;
      if (!applies || !Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || 'if' in entry) return null;
        const { type, command } = entry as { type?: unknown; command?: unknown };
        if (type !== 'command' || typeof command !== 'string' || command.trim() === '') return null;
        if (!commands.includes(command.trim())) commands.push(command.trim());
      }
    }
  }
  return commands;
}

/** The settings files read last, by path: read again only once the file changed. */
const settingsCache = new Map<string, { stamp: string; value: Record<string, unknown> | null }>();

function readSettings(path: string): Record<string, unknown> | null {
  let stamp: string;
  try {
    const st = statSync(path);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    settingsCache.delete(path);
    return null;
  }
  const held = settingsCache.get(path);
  if (held?.stamp === stamp) return held.value;
  const value = readObject(path);
  settingsCache.set(path, { stamp, value });
  return value;
}

/** The settings a session's CLI reads its hooks from, user's first. */
export function hookSettingsSources(cwd: string, claudeDir: string): (Record<string, unknown> | null)[] {
  return [
    readSettings(join(claudeDir, 'settings.json')),
    readSettings(join(cwd, '.claude', 'settings.json')),
    readSettings(localSettingsPath(cwd)),
  ];
}
