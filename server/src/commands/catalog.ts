import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The filesystem half of the command catalog
 * (spec: 2026-09-20-composer-design § Server).
 *
 * Nothing here asks the CLI anything: this is what the composer can offer for
 * a session with no live SDK query at all (an ended session, or the New
 * Session dialog, which has only a cwd). The SDK's own `supportedCommands()`
 * is the truth when there *is* a query — see `GET /api/commands`, where this
 * scan then only attributes `source`.
 *
 * Every read is best-effort. A missing `~/.claude/commands`, an absent
 * `installed_plugins.json`, a half-written skill directory — all of these are
 * the ordinary state of a machine, not a failure, so the scan returns what it
 * found rather than throwing.
 */

/**
 * Where a command came from, which is what the popup's badge names. A plugin
 * carries its own name in the value because the badge says `plugin: <name>`
 * and one string per row is cheaper than a second field only plugins use.
 */
export type CommandSource = 'user' | 'project' | 'built-in' | `plugin:${string}`;

export interface CatalogCommand {
  /** Without the leading slash, the spelling `SlashCommand.name` uses — the
   * two lists are merged by name, so they must agree on it. */
  name: string;
  description: string;
  source: CommandSource;
  /** The `argument-hint` frontmatter, which the composer ghosts after the
   * slug (spec: 2026-09-29-composer-rich-editor-design § 3). Absent when the
   * file has none. */
  argumentHint?: string;
}

/** How deep under a `skills/` root a `SKILL.md` may sit. Two is what the real
 * nesting needs (`skills/synced/<uuid>/<skill>`); the cap is there so a
 * symlink loop or a vendored `node_modules` cannot turn this into a full
 * filesystem walk. */
const SKILL_MAX_DEPTH = 3;

/**
 * Reads the leading `---` fenced block of a markdown file into flat key/value
 * pairs.
 *
 * Deliberately not a YAML parser. Only two shapes matter for a description —
 * a plain scalar and a `>`/`|` block, both of which real SKILL.md files use —
 * and only top-level keys are wanted, so an indented line either continues a
 * block scalar or belongs to a nested map (`metadata:`) nobody here reads.
 * Anything else is skipped rather than guessed at.
 */
export function parseFrontmatter(text: string): Record<string, string> {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return {};
  const out: Record<string, string> = {};
  let blockKey: string | null = null;
  let blockLines: string[] = [];
  const flushBlock = () => {
    if (blockKey) out[blockKey] = blockLines.join(' ').trim();
    blockKey = null;
    blockLines = [];
  };
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') break;
    const indented = /^\s/.test(line);
    if (blockKey && (indented || !line.trim())) {
      if (line.trim()) blockLines.push(line.trim());
      continue;
    }
    flushBlock();
    if (indented) continue; // a nested map's key, not a top-level one
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (rawValue === '>' || rawValue === '|' || rawValue === '>-' || rawValue === '|-') {
      blockKey = key;
      continue;
    }
    out[key] = unquote(rawValue.trim());
  }
  flushBlock();
  return out;
}

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted ? quoted[2] : value;
}

/** Directory entries, or nothing at all when the directory is not there. */
function entriesOf(dir: string): Array<{ name: string; isDir: boolean }> {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      // A symlinked skill directory is still a skill directory.
      isDir: e.isDirectory() || e.isSymbolicLink(),
    }));
  } catch {
    return [];
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * What a row says about itself, from its file's frontmatter: the description,
 * and the `argument-hint` when there is one. Both are optional in the file.
 */
function describe(frontmatter: Record<string, string>): Pick<CatalogCommand, 'description' | 'argumentHint'> {
  const hint = frontmatter['argument-hint'];
  return { description: frontmatter.description ?? '', ...(hint ? { argumentHint: hint } : {}) };
}

function frontmatterOf(path: string): Record<string, string> {
  const text = readText(path);
  return text ? parseFrontmatter(text) : {};
}

/**
 * `<root>/*.md`, flat. Frontmatter is optional — plenty of commands are a
 * prompt and nothing else, and those get an empty description rather than
 * being skipped for lacking one.
 */
function scanCommandsDir(dir: string, source: CommandSource, prefix: string): CatalogCommand[] {
  const out: CatalogCommand[] = [];
  for (const entry of entriesOf(dir)) {
    if (entry.isDir || !entry.name.endsWith('.md')) continue;
    out.push({
      name: prefix + entry.name.slice(0, -'.md'.length),
      source,
      ...describe(frontmatterOf(join(dir, entry.name))),
    });
  }
  return out;
}

/**
 * `<root>/<name>/SKILL.md`, where `<name>` is the command. A directory with no
 * `SKILL.md` is not a skill but may *hold* skills — which is exactly what
 * `skills/synced` is, and why it is never itself listed.
 */
function scanSkillsDir(
  dir: string,
  source: CommandSource,
  prefix: string,
  depth = 1,
): CatalogCommand[] {
  const out: CatalogCommand[] = [];
  for (const entry of entriesOf(dir)) {
    if (!entry.isDir) continue;
    const child = join(dir, entry.name);
    const manifest = readText(join(child, 'SKILL.md'));
    if (manifest !== null) {
      // The directory names the command, not the frontmatter's `name:` — the
      // directory is what the CLI resolves `/<name>` against.
      out.push({ name: prefix + entry.name, source, ...describe(parseFrontmatter(manifest)) });
    } else if (depth < SKILL_MAX_DEPTH) {
      out.push(...scanSkillsDir(child, source, prefix, depth + 1));
    }
  }
  return out;
}

function readJson(path: string): unknown {
  const text = readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    // A settings file someone is mid-edit on must not take the whole catalog
    // down with it.
    return null;
  }
}

/**
 * Install paths of the plugins that are both installed and switched on.
 *
 * Two files, and both have to agree: `installed_plugins.json` says where a
 * plugin's files are, `settings.json`'s `enabledPlugins` says whether its
 * commands are live. Only `true` counts — the map records an explicit `false`
 * for a plugin the user turned off, and offering its commands would be
 * offering something the CLI will not run.
 */
function enabledPluginPaths(claudeDir: string): Array<{ plugin: string; installPath: string }> {
  const installed = readJson(join(claudeDir, 'plugins', 'installed_plugins.json')) as
    | { plugins?: Record<string, Array<{ installPath?: unknown }>> }
    | null;
  const settings = readJson(join(claudeDir, 'settings.json')) as
    | { enabledPlugins?: Record<string, unknown> }
    | null;
  const enabled = settings?.enabledPlugins ?? {};
  const out: Array<{ plugin: string; installPath: string }> = [];
  for (const [key, installs] of Object.entries(installed?.plugins ?? {})) {
    if (enabled[key] !== true) continue;
    if (!Array.isArray(installs)) continue;
    // One key can carry several installs (user and project scope). The first
    // with a usable path is the one the CLI would resolve.
    const installPath = installs.find((i) => typeof i?.installPath === 'string')?.installPath;
    if (typeof installPath !== 'string') continue;
    // `<plugin>@<marketplace>` — the badge and the `plugin:entry` name both
    // want the plugin alone.
    out.push({ plugin: key.split('@')[0], installPath });
  }
  return out;
}

/**
 * Every command the filesystem can offer, sorted by name.
 *
 * Roots are arguments rather than read from `CONFIG`, so a test can build the
 * whole shape — synced nesting, a disabled plugin, a missing directory — on
 * disk and mean it.
 *
 * Precedence on a name collision is the CLI's own: a project command shadows a
 * user one, and both shadow a plugin's. `~/.claude/agents` is not scanned at
 * all — an agent is not something the composer's `/` offers.
 */
export function collectCommands(opts: { claudeDir: string; cwd: string }): CatalogCommand[] {
  const projectClaude = opts.cwd ? join(opts.cwd, '.claude') : null;
  const found: CatalogCommand[] = [
    ...(projectClaude
      ? [
          ...scanCommandsDir(join(projectClaude, 'commands'), 'project', ''),
          ...scanSkillsDir(join(projectClaude, 'skills'), 'project', ''),
        ]
      : []),
    ...scanCommandsDir(join(opts.claudeDir, 'commands'), 'user', ''),
    ...scanSkillsDir(join(opts.claudeDir, 'skills'), 'user', ''),
  ];
  for (const { plugin, installPath } of enabledPluginPaths(opts.claudeDir)) {
    const source: CommandSource = `plugin:${plugin}`;
    found.push(
      ...scanSkillsDir(join(installPath, 'skills'), source, `${plugin}:`),
      ...scanCommandsDir(join(installPath, 'commands'), source, `${plugin}:`),
    );
  }
  const byName = new Map<string, CatalogCommand>();
  for (const command of found) {
    if (!byName.has(command.name)) byName.set(command.name, command);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
