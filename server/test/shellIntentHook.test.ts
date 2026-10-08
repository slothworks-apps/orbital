import { describe, it, expect } from 'vitest';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { SHELL_INTENT_DENIAL, shellIntentHooks } from '../src/runner/shellIntentHook.js';

// Spec 2026-10-08-kept-shells-design § Behaviour 2.
async function decide(toolName: string, toolInput: Record<string, unknown>) {
  const [matcher] = shellIntentHooks().PreToolUse!;
  const input = {
    hook_event_name: 'PreToolUse', session_id: 's', transcript_path: '/t', cwd: '/w',
    tool_name: toolName, tool_input: toolInput, tool_use_id: 'tu1',
  } as HookInput;
  expect(matcher.matcher).toBe('Bash');
  return matcher.hooks[0](input, 'tu1', { signal: new AbortController().signal });
}

describe('the background shell intent hook', () => {
  it('denies a background Bash without a marker, telling the agent how to repeat it', async () => {
    expect(await decide('Bash', { command: 'npm run dev', description: 'Start the dev server', run_in_background: true }))
      .toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: SHELL_INTENT_DENIAL,
        },
      });
    expect((await decide('Bash', { command: 'npm run dev', run_in_background: true })))
      .toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    // A marker elsewhere in the description is not the marker.
    expect((await decide('Bash', { command: 'make', description: 'Build [wait]', run_in_background: true })))
      .toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  it('lets a marked background Bash, a foreground Bash and any other tool through without a decision', async () => {
    // No `permissionDecision` at all: an `allow` here would skip Orbital's
    // own permission flow (`canUseTool`).
    for (const [tool, input] of [
      ['Bash', { command: 'npm test', description: '[wait] Run the tests', run_in_background: true }],
      ['Bash', { command: 'npm run dev', description: '[KEEP] Start the dev server', run_in_background: true }],
      ['Bash', { command: 'ls', description: 'List files' }],
      ['Bash', { command: 'ls', run_in_background: false }],
      ['Monitor', { command: 'tail -f log', run_in_background: true }],
    ] as const) {
      expect(await decide(tool, input)).toEqual({});
    }
  });
});
