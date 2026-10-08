import type { FastifyInstance, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import type { OrbitalDb } from '../db/database.js';
import { sessionColumns, sessions } from '../db/schema.js';
import { McpStatusTimeoutError, type Runner } from '../runner/runner.js';
import { ORBITAL_MCP_SERVER } from '../runner/spawnTool.js';
import {
  McpCliMissingError,
  McpCliRefusedError,
  McpDefinitionError,
  parseDefinition,
  type McpConfig,
} from '../mcp/config.js';
import { McpLoginUnsupportedError } from '../mcp/login.js';
import type { PermissionMode, SessionRow } from '../types.js';
import type { LiveSessions } from '../watcher/registry.js';

/** What the `/mcp` routes need of the route context. */
export interface McpRouteContext {
  db: OrbitalDb;
  registry: Pick<LiveSessions, 'get'>;
  runner: Pick<
    Runner,
    | 'status' | 'pendingDecision' | 'stopAndWait' | 'start'
    | 'mcpServers' | 'reconnectMcpServer' | 'toggleMcpServer' | 'reloadMcpConfig' | 'mcpLogin'
  >;
  /** MCP config of one Claude directory: its `.claude.json`, written by `claude mcp` under its environment. */
  mcpFor(claudeDirId: number): McpConfig;
  settings: { get(key: string): string };
  rewindStopTimeoutMs?: number;
}

/**
 * The `/mcp` dialog's routes (spec 2026-10-01-mcp-servers-in-the-session-design
 * § Routes). Every one acts on a session Orbital runs: the list and the
 * switches go through its live query, config changes through `claude mcp` in
 * its cwd.
 *
 * 404 for an unknown session or server, 409 for a session with no process
 * here, 400 for a body or a server the dialog should not have offered, 503
 * when there is no CLI to write with, 502 when the CLI or the session
 * refuses, 504 when the session does not answer in time.
 */
export function registerMcpRoutes(app: FastifyInstance, ctx: McpRouteContext): void {
  const { db, runner } = ctx;

  /** The session's row when it is running here; otherwise the reply has been sent. */
  function runningRow(id: string, reply: FastifyReply): SessionRow | null {
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as SessionRow | undefined;
    if (!row) {
      void reply.code(404).send({ error: 'not_found' });
      return null;
    }
    if (!runner.status(id)) {
      void reply.code(409).send({ error: 'not_running', message: 'the list needs a running session' });
      return null;
    }
    return row;
  }

  /** One failure as its status code. Anything unnamed is the session or the CLI saying no. */
  function failure(reply: FastifyReply, err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof McpDefinitionError) return reply.code(400).send({ error: err.code, message });
    if (err instanceof McpCliMissingError) return reply.code(503).send({ error: 'cli_missing', message });
    if (err instanceof McpCliRefusedError) {
      return reply.code(502).send({ error: 'cli_refused', message: err.output, command: err.command });
    }
    if (err instanceof McpStatusTimeoutError) return reply.code(504).send({ error: 'timeout', message });
    if (err instanceof McpLoginUnsupportedError) return reply.code(502).send({ error: 'login_unsupported', message });
    // The session stopped between the check and the call.
    if (/is not active/.test(message)) return reply.code(409).send({ error: 'not_running', message });
    return reply.code(502).send({ error: 'session_error', message });
  }

  /**
   * The server the CLI would run under `name` in this project's `user` or
   * `local` config. Not there: 400 when the session runs it anyway (a
   * project, plugin or managed server — or one removed and still
   * connected), 404 when nobody has heard of it.
   */
  async function configured(id: string, row: SessionRow, name: string, reply: FastifyReply) {
    const found = ctx.mcpFor(row.claude_dir_id).read(row.cwd).find(name);
    if (found) return found;
    const live = await runner.mcpServers(id);
    if (live.some((s) => s.name === name)) {
      void reply.code(400).send({ error: 'not_editable', message: `${name} is not in the user or local config` });
    } else {
      void reply.code(404).send({ error: 'unknown_server' });
    }
    return null;
  }

  app.get('/api/sessions/:id/mcp', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!runningRow(id, reply)) return reply;
    try {
      return { servers: await runner.mcpServers(id) };
    } catch (err) {
      return failure(reply, err);
    }
  });

  app.post('/api/sessions/:id/mcp/:name/reconnect', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    if (!runningRow(id, reply)) return reply;
    try {
      if (!(await runner.mcpServers(id)).some((s) => s.name === name)) {
        return reply.code(404).send({ error: 'unknown_server' });
      }
      await runner.reconnectMcpServer(id, name);
      return { servers: await runner.mcpServers(id) };
    } catch (err) {
      return failure(reply, err);
    }
  });

  /**
   * Starts a server's login and answers `{ authUrl }` for the browser. Only a
   * server that says it needs one, and not a claude.ai connector — those are
   * logged in on claude.ai, never through the CLI.
   */
  app.post('/api/sessions/:id/mcp/:name/login', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    if (!runningRow(id, reply)) return reply;
    try {
      const row = (await runner.mcpServers(id)).find((s) => s.name === name);
      if (!row) return reply.code(404).send({ error: 'unknown_server' });
      if (row.status !== 'needs-auth' || row.origin === 'claudeai') {
        return reply.code(400).send({ error: 'not_loginable', message: `${name} has no login to start here` });
      }
      return await runner.mcpLogin(id, name);
    } catch (err) {
      return failure(reply, err);
    }
  });

  app.post('/api/sessions/:id/mcp/:name/enabled', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    const { enabled } = (req.body ?? {}) as { enabled?: unknown };
    if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'invalid', message: 'enabled must be a boolean' });
    if (!runningRow(id, reply)) return reply;
    if (name === ORBITAL_MCP_SERVER) {
      return reply.code(400).send({ error: 'not_toggleable', message: `${ORBITAL_MCP_SERVER} is Orbital's own server` });
    }
    try {
      if (!(await runner.mcpServers(id)).some((s) => s.name === name)) {
        return reply.code(404).send({ error: 'unknown_server' });
      }
      await runner.toggleMcpServer(id, name, enabled);
      return { servers: await runner.mcpServers(id) };
    } catch (err) {
      return failure(reply, err);
    }
  });

  app.get('/api/sessions/:id/mcp/:name/config', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    const row = runningRow(id, reply);
    if (!row) return reply;
    try {
      const found = await configured(id, row, name, reply);
      if (!found) return reply;
      if (!found.definition) {
        return reply.code(400).send({ error: 'not_editable', message: `${name} cannot be edited here` });
      }
      return found.definition;
    } catch (err) {
      return failure(reply, err);
    }
  });

  app.post('/api/sessions/:id/mcp', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = runningRow(id, reply);
    if (!row) return reply;
    try {
      const definition = parseDefinition(req.body);
      await ctx.mcpFor(row.claude_dir_id).add(row.cwd, definition);
      // A reload connects the new server in place (spec § Verify first, 2);
      // a CLI that cannot do it gets it at the next start instead.
      let restartNeeded = false;
      try {
        await runner.reloadMcpConfig(id);
      } catch {
        restartNeeded = true;
      }
      return { servers: await runner.mcpServers(id), restartNeeded };
    } catch (err) {
      return failure(reply, err);
    }
  });

  app.put('/api/sessions/:id/mcp/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    const row = runningRow(id, reply);
    if (!row) return reply;
    try {
      const next = parseDefinition(req.body);
      const found = await configured(id, row, name, reply);
      if (!found) return reply;
      if (!found.definition) {
        return reply.code(400).send({ error: 'not_editable', message: `${name} cannot be edited here` });
      }
      await ctx.mcpFor(row.claude_dir_id).edit(row.cwd, found.definition, next);
      // Neither a changed nor a removed definition reaches the running
      // session on its own (spec § Verify first, 2).
      return { servers: await runner.mcpServers(id), restartNeeded: true };
    } catch (err) {
      return failure(reply, err);
    }
  });

  app.delete('/api/sessions/:id/mcp/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    const row = runningRow(id, reply);
    if (!row) return reply;
    try {
      const found = await configured(id, row, name, reply);
      if (!found) return reply;
      await ctx.mcpFor(row.claude_dir_id).remove(row.cwd, name, found.scope);
      return { servers: await runner.mcpServers(id), restartNeeded: true };
    } catch (err) {
      return failure(reply, err);
    }
  });

  /**
   * The banner's Restart: the process is stopped and resumed on the same
   * transcript, parked on an empty prompt until the next send, with the
   * row's model and permission mode as `revive` would. Refused while a turn
   * runs or a decision waits — the restart would cut either off.
   */
  app.post('/api/sessions/:id/mcp/restart', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = runningRow(id, reply);
    if (!row) return reply;
    if (ctx.registry.get(id)) return reply.code(409).send({ error: 'terminal_session' });
    if (runner.status(id) === 'working' || runner.pendingDecision(id)) {
      return reply.code(409).send({ error: 'busy', message: 'the session is in the middle of a turn' });
    }
    try {
      await runner.stopAndWait(id, ctx.rewindStopTimeoutMs);
    } catch (err) {
      return reply.code(504).send({ error: 'stop_timeout', message: err instanceof Error ? err.message : String(err) });
    }
    const permissionMode = (row.permission_mode ?? ctx.settings.get('default_permission_mode')) as PermissionMode;
    try {
      await runner.start({
        cwd: row.cwd, prompt: '', permissionMode, resume: id, model: row.model ?? undefined,
        claudeDirId: row.claude_dir_id,
      });
      return { servers: await runner.mcpServers(id) };
    } catch (err) {
      return failure(reply, err);
    }
  });
}
