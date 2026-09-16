import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Version of the Claude Code CLI the Agent SDK will actually spawn, or `null`
 * when it cannot be determined.
 *
 * The SDK ships the CLI as a bundled binary and records its version in the
 * package's `manifest.json` (`{"version": "2.1.272", ...}`) — that file *is*
 * the claude-code version, which is what canvas 1h's `claude-code <v>` line
 * means. Deliberately NOT falling back to the SDK package's own `version`
 * (`@anthropic-ai/claude-agent-sdk@0.3.x`): that is a different, much lower
 * number, and printing it under a `claude-code` label would be a wrong answer
 * dressed as a right one. When the manifest can't be read the caller leaves
 * the setting absent and the UI row simply stays hidden.
 *
 * `manifest.json` is not listed in the package's `exports` map, so it is
 * reached via the resolved entry point's directory rather than by
 * `require.resolve('@anthropic-ai/claude-agent-sdk/manifest.json')`, which
 * exports enforcement would reject.
 */
export function resolveClaudeCodeVersion(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const sdkDir = dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
    const manifest = JSON.parse(readFileSync(join(sdkDir, 'manifest.json'), 'utf8')) as {
      version?: unknown;
    };
    const version = manifest.version;
    return typeof version === 'string' && version.trim() ? version.trim() : null;
  } catch {
    // SDK not installed, entry point not resolvable, manifest missing or not
    // JSON — all mean "unknown", never a placeholder.
    return null;
  }
}
