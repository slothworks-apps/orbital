import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import * as z from 'zod/v4';

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

export function orbitalMcpServer(parentId: string, spawn: Spawner) {
  return createSdkMcpServer({
    name: ORBITAL_MCP_SERVER,
    tools: [spawnSessionTool(parentId, spawn)],
  });
}
