import type { McpServerRow } from '../types.js';
import { ORBITAL_MCP_SERVER } from '../runner/spawnTool.js';
import type { McpConfigSnapshot } from './claudeJson.js';

/**
 * The plugin and server of a `plugin:<plugin>:<server>` name, the form the
 * CLI gives a plugin's MCP server; `null` for any other name, including those
 * that only look like it (a missing or empty part).
 */
export function parsePluginName(name: string): { plugin: string; server: string } | null {
  const match = /^plugin:([^:]+):(.+)$/.exec(name);
  return match ? { plugin: match[1], server: match[2] } : null;
}

/** Where a definition lives by the SDK's word: the scopes a config file names, and `dynamic` for one added since the session started. */
const CONFIG_ORIGINS = new Set(['user', 'local', 'dynamic']);

/**
 * The SDK's `McpServerStatus` list as the dialog's rows. Entries without a
 * name are dropped: nothing could act on them.
 *
 * Editability comes from the config, not from `source`: a server added while
 * the session runs reports `dynamic` until the restart (spec § Verify first),
 * and one removed stays connected under its old scope. So a name the
 * snapshot finds in `user` or `local` — while the SDK does not attribute it
 * to some other origin — is editable and shows that scope.
 */
export function shapeMcpServers(raw: unknown, config?: McpConfigSnapshot): McpServerRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: McpServerRow[] = [];
  for (const entry of raw) {
    const s = entry as {
      name?: unknown; status?: unknown; error?: unknown; source?: unknown; scope?: unknown; tools?: unknown;
    };
    if (typeof s?.name !== 'string' || !s.name) continue;
    const name = s.name;
    const status = typeof s.status === 'string' ? s.status : 'unknown';
    const sdkOrigin =
      typeof s.source === 'string' && s.source ? s.source
      : typeof s.scope === 'string' && s.scope ? s.scope
      : undefined;
    const own = name === ORBITAL_MCP_SERVER;
    const configured = !own && (sdkOrigin === undefined || CONFIG_ORIGINS.has(sdkOrigin))
      ? config?.find(name)
      : undefined;
    const origin = own ? 'built-in' : (configured?.scope ?? sdkOrigin);
    const plugin = configured || own ? null : parsePluginName(name);
    rows.push({
      name,
      status,
      ...(typeof s.error === 'string' && s.error ? { error: s.error } : {}),
      ...(origin ? { origin } : {}),
      ...(plugin ? { plugin: plugin.plugin } : {}),
      ...(status === 'connected' && Array.isArray(s.tools) ? { toolCount: s.tools.length } : {}),
      toggleable: !own,
      editable: configured !== undefined,
    });
  }
  return rows;
}
