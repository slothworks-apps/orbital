import { join } from 'node:path';
import { localSettingsPath, readObject } from '../mcp/mcpjson.js';

/**
 * The command a running hook runs, for its live row (canvas `Feature - Stop
 * hook` 1e "NAMING"). The SDK's hook events name the event and the tool it
 * runs for, never the command, so it is read from the settings the CLI reads
 * hooks from: `settings.json` in the session's Claude directory, and the
 * project's `.claude/settings.json` and `.claude/settings.local.json`.
 *
 * Named only when it cannot be wrong: exactly one command for the event and
 * the tool across those files. Hooks the files do not show — a plugin's, a
 * managed policy's — can run beside it, which is why the runner asks only
 * while one hook of the kind runs.
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
 * Whether a matcher group applies to `query`, as the CLI reads matchers: none
 * or `*` matches everything, a plain name or `A|B` list matches by name, and
 * anything else is a regular expression. `undefined` for a pattern that does
 * not compile — the CLI skips such a group, but it is not this one's to guess.
 */
function matcherApplies(matcher: unknown, query: string | null, toolEvent: boolean): boolean | undefined {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true;
  if (typeof matcher !== 'string') return undefined;
  // An event that matches nothing runs every group, whatever it says.
  if (query === null) return true;
  const plain = toolEvent ? /^[a-zA-Z0-9_|, -]+$/ : /^[a-zA-Z0-9_|]+$/;
  if (plain.test(matcher)) {
    return matcher.split(toolEvent ? /[|,]/ : '|').map((name) => name.trim()).includes(query);
  }
  try {
    return new RegExp(matcher).test(query);
  } catch {
    return undefined;
  }
}

/**
 * The one command configured for `event` (and `query`, the tool or source it
 * ran for) across `sources`, or null when there is none, several, a hook that
 * is no command, or a matcher this cannot read. The CLI runs one copy of a
 * command configured in two files, so a repeat counts once.
 */
export function configuredHookCommand(
  sources: readonly (Record<string, unknown> | null)[],
  event: string,
  query: string | null,
): string | null {
  const commands = new Set<string>();
  const toolEvent = TOOL_HOOK_EVENTS.has(event);
  for (const source of sources) {
    if (!source) continue;
    if (source.disableAllHooks === true) return null;
    const hooks = source.hooks;
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) continue;
    const groups = (hooks as Record<string, unknown>)[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== 'object') return null;
      const { matcher, hooks: entries } = group as { matcher?: unknown; hooks?: unknown };
      const applies = matcherApplies(matcher, query, toolEvent);
      if (applies === undefined) return null;
      if (!applies || !Array.isArray(entries)) continue;
      for (const entry of entries) {
        const { type, command } = (entry ?? {}) as { type?: unknown; command?: unknown };
        if (type !== 'command' || typeof command !== 'string' || command.trim() === '') return null;
        commands.add(command.trim());
      }
    }
  }
  return commands.size === 1 ? [...commands][0] : null;
}

/** The settings a session's CLI reads its hooks from, user's first. */
export function hookSettingsSources(cwd: string, claudeDir: string): (Record<string, unknown> | null)[] {
  return [
    readObject(join(claudeDir, 'settings.json')),
    readObject(join(cwd, '.claude', 'settings.json')),
    readObject(localSettingsPath(cwd)),
  ];
}
