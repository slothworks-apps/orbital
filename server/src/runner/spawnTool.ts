import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import * as z from 'zod/v4';
import { archiveSessionTool, listSessionsTool, type SessionKeeper } from './sessionsTools.js';
import { controlTools, type ControlCall } from './controlTools.js';

/**
 * The in-process MCP server every Orbital session gets, holding the one tool
 * that lets it start another Orbital session (spec
 * 2026-09-30-a-session-spawns-sessions-design). The CLI sees the tool as
 * `mcp__orbital__spawn_session`, so a call goes through the same permission
 * path as any other tool.
 */
export const ORBITAL_MCP_SERVER = 'orbital';

export interface SpawnInput {
  prompt: string;
  cwd?: string;
  model?: string;
  /** Another group member's id: the session starts there (spec 2026-10-19-member-grants-design § 3). */
  machine?: string;
}

export interface SpawnResult {
  sessionId: string;
  cwd: string;
}

/** Starts a session on behalf of `parentId`; rejects with a message the model can relay. */
export type Spawner = (parentId: string, input: SpawnInput) => Promise<SpawnResult>;

/**
 * The model is told this is not delegation, because the tool is otherwise an
 * attractive way to parallelise its own work — and nothing but these words
 * stands between it and a chain of sessions (spec § Chains).
 */
const DESCRIPTION = [
  'Start a new, separate Orbital session: its own conversation, its own planet on the map, running independently of this one.',
  'Use it ONLY when the user explicitly asks for a new or separate session (for example "start a new session for…", "open another session that…").',
  'It is not a way to delegate or parallelise your own work — use subagents for that. Never call it on your own initiative.',
  'The new session inherits this session\'s permission mode. You do not wait for it and never receive its output; the call returns its id as soon as it has started.',
].join(' ');

export function spawnSessionTool(parentId: string, spawn: Spawner) {
  return tool(
    'spawn_session',
    DESCRIPTION,
    {
      prompt: z.string().min(1).describe('The new session\'s first message — the full task, since it shares no context with this session.'),
      cwd: z.string().optional().describe('Working directory for the new session. Defaults to this session\'s directory.'),
      model: z.string().optional().describe('Model for the new session. Defaults to this session\'s model; pass one only if the user asked for it.'),
      machine: z.string().optional().describe('Start it on another group member (its id, from orbital_read list_devices) when the user asked for that device. Its cwd is a path on that device and is required.'),
    },
    async (args) => {
      try {
        const { sessionId, cwd } = await spawn(parentId, args);
        return {
          content: [{
            type: 'text' as const,
            text: `Started session ${sessionId} in ${cwd}. It runs on its own; you will not receive its output.`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Could not start the session: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}

/**
 * The session's `orbital` server: `spawn_session` when the Runner can spawn,
 * `list_sessions` and `archive_session` when it can look after sessions,
 * `orbital_operations`, `orbital_read` and `orbital_act` when it can call
 * Orbital's own routes, and whatever else Orbital adds (the harness's tools, spec
 * 2026-09-30-session-harness-design § The agent's tools).
 */
export function orbitalMcpServer(
  parentId: string,
  backs: { spawn?: Spawner; keeper?: SessionKeeper; control?: ControlCall },
  extra?: { tools?: SdkMcpToolDefinition<any>[]; instructions?: string; getDeviceName?: (id: string) => string | null },
) {
  const { spawn, keeper, control } = backs;
  return createSdkMcpServer({
    name: ORBITAL_MCP_SERVER,
    ...(extra?.instructions ? { instructions: extra.instructions } : {}),
    tools: [
      ...(spawn ? [spawnSessionTool(parentId, spawn)] : []),
      ...(keeper ? [listSessionsTool(parentId, keeper), archiveSessionTool(parentId, keeper)] : []),
      ...(control ? controlTools(parentId, control, extra?.getDeviceName) : []),
      ...(extra?.tools ?? []),
    ],
  });
}
