import { tool } from '@anthropic-ai/claude-agent-sdk';
import * as z from 'zod/v4';
import { CONTROL_OPERATIONS, type ControlOperation } from '../control/catalog.js';

/**
 * The `orbital` server's tools for driving Orbital itself (spec
 * 2026-10-13-orbital-controls-itself-design): one catalog of operations, each
 * one of Orbital's own routes, called in-process with the API token — the
 * path a phone's request takes, without the phone's allowlist.
 *
 * Three tools, not one per operation: the catalog is long, and a tool per
 * route would fill every session's context with it (ADR
 * an-orbital-session-drives-orbital-through-a-catalog).
 */

/** One request into Orbital's own routes; answered with what the route answered. */
export type ControlCall = (req: { method: string; url: string; payload?: unknown }) =>
  Promise<{ statusCode: number; body: string }>;

/** `orbital_operations` and `orbital_read` only read, so they need no permission card. */
export const CONTROL_READ_TOOLS = ['mcp__orbital__orbital_operations', 'mcp__orbital__orbital_read'];

export type ControlRequest =
  | { ok: true; method: string; url: string; payload?: unknown }
  | { ok: false; error: string };

/**
 * The request an operation makes with these params. Path params are taken by
 * name and must be a plain segment; for GET and DELETE the rest is the query
 * string, otherwise the JSON body. Refused: an unknown operation, one of the
 * wrong kind for the tool, a missing path param, a body key the operation
 * keeps for the user, and one that would stop or reset the calling session
 * while its turn waits on the call.
 */
export function controlRequest(
  callerId: string,
  name: string,
  params: Record<string, unknown> | undefined,
  kind: 'read' | 'act',
  catalog: readonly ControlOperation[] = CONTROL_OPERATIONS,
): ControlRequest {
  const op = catalog.find((o) => o.name === name);
  if (!op) return { ok: false, error: `unknown operation ${name}; orbital_operations lists them` };
  if ((op.method === 'GET') !== (kind === 'read')) {
    return { ok: false, error: `${name} ${kind === 'read' ? 'changes Orbital; call it with orbital_act' : 'only reads; call it with orbital_read'}` };
  }
  const rest: Record<string, unknown> = { ...(params ?? {}) };
  const segments: string[] = [];
  for (const part of op.path.split('/')) {
    if (!part.startsWith(':')) {
      segments.push(part);
      continue;
    }
    const key = part.slice(1);
    const value = rest[key];
    delete rest[key];
    if (typeof value !== 'string' && typeof value !== 'number') return { ok: false, error: `${name} needs ${key}` };
    const text = String(value);
    if (text === '' || text === '.' || text === '..') return { ok: false, error: `${key} is not a valid value` };
    segments.push(encodeURIComponent(text));
  }
  if (op.notOnCaller && params?.id === callerId) {
    return { ok: false, error: `${name} would stop this session's own turn; it cannot be called on the calling session` };
  }
  let url = segments.join('/');
  if (op.method === 'GET' || op.method === 'DELETE') {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(rest)) {
      if (value === undefined || value === null) continue;
      query.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
    const search = query.toString();
    if (search) url += `?${search}`;
    return { ok: true, method: op.method, url };
  }
  const denied = op.deniedKeys ? Object.keys(rest).filter(op.deniedKeys) : [];
  if (denied.length > 0) return { ok: false, error: `${name} cannot change ${denied.join(', ')}; only the user can` };
  return { ok: true, method: op.method, url, payload: rest };
}

/**
 * The request aimed at another Mac (spec 2026-10-06-peer-macs-design § 9):
 * `machine` in the query of a read or a delete, in the body of the rest,
 * which is where the server's routing to a paired Mac looks.
 */
export function onMachine(req: ControlRequest, machine: string | undefined): ControlRequest {
  if (!req.ok || !machine) return req;
  if (req.method === 'GET' || req.method === 'DELETE') {
    return { ...req, url: `${req.url}${req.url.includes('?') ? '&' : '?'}${new URLSearchParams({ machine })}` };
  }
  const body = req.payload && typeof req.payload === 'object' ? req.payload : {};
  return { ...req, payload: { ...body, machine } };
}

const OPERATIONS_DESCRIPTION = [
  'List the operations Orbital offers for controlling itself: sessions and their conversations, decisions, models and permission modes, tags and tag rules, settings, harnesses, MCP servers, Claude directories, files, stats, limits and errors.',
  'Each has a name, whether it reads or acts, its params and what it does. Call it before orbital_read or orbital_act, optionally narrowed by area or a search word.',
].join(' ');

const READ_DESCRIPTION = [
  'Run one of Orbital\'s read operations (from orbital_operations) and get its JSON answer. Nothing changes.',
].join(' ');

const ACT_DESCRIPTION = [
  'Run one of Orbital\'s acting operations (from orbital_operations): it changes Orbital the way the user\'s own click would — starts or ends sessions, sends messages, answers decisions, edits tags, settings and harnesses.',
  'Use it only for what the user asked for. Operations that would stop this session\'s own turn are refused on the calling session.',
].join(' ');

function text(value: string, isError = false) {
  return { content: [{ type: 'text' as const, text: value }], ...(isError ? { isError: true } : {}) };
}

function listed(op: ControlOperation) {
  return {
    name: op.name, area: op.area, kind: op.method === 'GET' ? 'read' : 'act',
    does: op.does, ...(op.params ? { params: op.params } : {}),
  };
}

export function operationsTool() {
  return tool(
    'orbital_operations',
    OPERATIONS_DESCRIPTION,
    {
      area: z.string().optional().describe('Only operations of this area, for example sessions, tags, settings, harness, mcp.'),
      search: z.string().optional().describe('Only operations whose name or description contains this word.'),
    },
    (args) => {
      const word = args.search?.toLowerCase();
      const ops = CONTROL_OPERATIONS
        .filter((o) => !args.area || o.area === args.area)
        .filter((o) => !word || o.name.includes(word) || o.does.toLowerCase().includes(word));
      return Promise.resolve(text(JSON.stringify(ops.map(listed), null, 2)));
    },
  );
}

function runTool(name: 'orbital_read' | 'orbital_act', description: string, callerId: string, call: ControlCall) {
  const kind = name === 'orbital_read' ? 'read' : 'act';
  return tool(
    name,
    description,
    {
      operation: z.string().min(1).describe('The operation\'s name, from orbital_operations.'),
      params: z.record(z.string(), z.unknown()).optional().describe('Its params, by name, as orbital_operations lists them.'),
      machine: z.string().optional().describe('Another paired Mac\'s id, from list_macs, to run the operation there. Not needed for an operation on a session: it runs on that session\'s Mac.'),
    },
    async (args) => {
      const req = onMachine(controlRequest(callerId, args.operation, args.params, kind), args.machine);
      if (!req.ok) return text(req.error, true);
      try {
        const res = await call(req);
        const failed = res.statusCode >= 400;
        return text(`${failed ? `HTTP ${res.statusCode}: ` : ''}${res.body || '{}'}`, failed);
      } catch (err) {
        return text(`Failed: ${(err as Error).message}`, true);
      }
    },
  );
}

export function controlTools(callerId: string, call: ControlCall) {
  return [
    operationsTool(),
    runTool('orbital_read', READ_DESCRIPTION, callerId, call),
    runTool('orbital_act', ACT_DESCRIPTION, callerId, call),
  ];
}
