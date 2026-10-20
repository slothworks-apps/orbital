import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { delimiter, join } from 'node:path';
import { fallbackPathDirs } from '../env/loginPath.js';

/** How the CLI Orbital will spawn was arrived at; `missing` is a designed state. */
export type ClaudeCliSource = 'settings' | 'path' | 'bundled' | 'missing';
export type ClaudeCliResolution = { path: string | null; source: ClaudeCliSource };

/** How long `claude --version` may take before the version stays unknown. */
const VERSION_TIMEOUT_MS = 5000;

/**
 * The SDK's platform binary package for a platform and architecture, in the
 * SDK's own naming (its `optionalDependencies`). Glibc only: a musl Linux
 * gets the glibc name, misses, and finds the CLI on PATH instead.
 */
export function sdkPlatformPackage(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
}

/**
 * True when the SDK's platform binary package is resolvable (dev).
 *
 * That package is an `optionalDependencies` entry of the SDK and is excluded
 * from the packaged app (201 MB, and a second CLI version writing the
 * transcripts Orbital reads — spec § 2), so this is exactly the dev/packaged
 * distinction without asking anyone to declare it.
 */
export function sdkBundledCliAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve(`${sdkPlatformPackage()}/package.json`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The bundled binary's own path, for the one place Orbital runs the CLI
 * itself rather than through the SDK — `claude mcp` (spec
 * 2026-10-01-mcp-servers-in-the-session-design § Config). Null when the
 * package is not resolvable.
 */
export function sdkBundledCliPath(): string | null {
  try {
    return createRequire(import.meta.url).resolve(`${sdkPlatformPackage()}/claude`);
  } catch {
    return null;
  }
}

/** Search PATH dirs then fallbackPathDirs(home) for an executable `claude`. `isExecutable` injected for tests. */
export function findClaudeOnDisk(opts: {
  pathVar: string | undefined;
  home: string;
  isExecutable: (p: string) => boolean;
}): string | null {
  const pathDirs = (opts.pathVar ?? '').split(delimiter).filter(Boolean);
  for (const dir of [...pathDirs, ...fallbackPathDirs(opts.home)]) {
    const candidate = join(dir, 'claude');
    if (opts.isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolution order (spec § 3): a non-empty settings override wins (anything
 * but an executable file there → 'missing', never silently ignored); otherwise the bundled
 * SDK binary when available (path stays null — the SDK uses its default);
 * otherwise disk search; otherwise 'missing'.
 */
export function resolveClaudeCli(opts: {
  override: string;            // settings value, '' = autodetect
  bundled: boolean;
  pathVar: string | undefined;
  home: string;
  isExecutable: (p: string) => boolean;
}): ClaudeCliResolution {
  const override = opts.override.trim();
  if (override) {
    // An override that points at nothing runnable is a mistake worth showing,
    // not a reason to quietly run a different CLI than the user asked for.
    return opts.isExecutable(override)
      ? { path: override, source: 'settings' }
      : { path: null, source: 'missing' };
  }
  if (opts.bundled) return { path: null, source: 'bundled' };
  const found = findClaudeOnDisk(opts);
  return found ? { path: found, source: 'path' } : { path: null, source: 'missing' };
}

/** '2.1.236 (Claude Code)' → '2.1.236'; anything without a semver-ish token → null. */
export function parseClaudeVersionOutput(stdout: string): string | null {
  return /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(stdout)?.[0] ?? null;
}

/** execFile(cliPath, ['--version'], { timeout: 5000 }) → parsed, null on any failure. */
export function claudeCliVersion(cliPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      cliPath,
      ['--version'],
      { timeout: VERSION_TIMEOUT_MS, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return resolve(null);
        resolve(parseClaudeVersionOutput(stdout));
      },
    );
  });
}
