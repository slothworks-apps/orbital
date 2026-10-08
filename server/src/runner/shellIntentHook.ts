import type { HookCallbackMatcher, HookEvent, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { shellIntentOf } from '../transcript/backgroundTasks.js';

/**
 * Every background shell an Orbital session starts says what it is for
 * (spec 2026-10-08-kept-shells-design § 2): a `PreToolUse` hook on `Bash`,
 * passed to `query()` through the SDK's programmatic `hooks` option. It lives
 * in Orbital's process, applies only to the sessions Orbital runs — their
 * subagents' calls included, as they run in the same query — and writes
 * nothing to any settings file.
 */

/** What the agent reads when a background `Bash` comes without a marker. */
export const SHELL_INTENT_DENIAL =
  'Orbital needs every background shell to say what it is for. Repeat this Bash call with its ' +
  'description starting with [wait] if you will wait for the command to finish (a test suite, a build), ' +
  'or with [keep] if you are leaving it running (a dev server, a watcher, anything that does not end on ' +
  'its own). A [wait] shell keeps the session shown as working; a [keep] shell does not.';

/** The same rule, up front, in the session instructions — so a denial is the exception. */
export const SHELL_INTENT_INSTRUCTION =
  'Start the description of every Bash call you run in the background with [wait] when you will wait ' +
  'for it to finish, or [keep] when you leave it running (a dev server, a watcher). Orbital shows the ' +
  'session as working while a [wait] shell runs, and not for a [keep] one; a background call with ' +
  'neither is refused.';

/**
 * The hook. A pass is `{}`, never an `allow`: an allow from a hook would
 * skip `canUseTool`, and with it Orbital's permission cards.
 */
function checkBackgroundShell(input: HookInput): Promise<HookJSONOutput> {
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') return Promise.resolve({});
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? (input.tool_input as Record<string, unknown>) : {};
  if (toolInput.run_in_background !== true || shellIntentOf(toolInput.description) !== undefined) return Promise.resolve({});
  return Promise.resolve({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: SHELL_INTENT_DENIAL,
    },
  });
}

/** Orbital's hooks for `Options.hooks`. */
export function shellIntentHooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return { PreToolUse: [{ matcher: 'Bash', hooks: [checkBackgroundShell] }] };
}
