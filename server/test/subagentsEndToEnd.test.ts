import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/index.js';

/**
 * The whole chain against a real `buildServer`, the one place the pieces meet:
 * SDK stream -> Runner.onTaskEvent -> SubagentStore -> toApiSession ->
 * GET /api/sessions. The unit tests each prove one link; only this proves
 * index.ts wires them to each other.
 *
 * Orbital's own sessions are the only ones that can have subagents at all —
 * see `docs/domains/subagents-in-transcripts.md` for why a terminal session's
 * transcript cannot answer the question.
 */

/**
 * Fake SDK that starts one subagent, parks, and finishes it when released —
 * in the order the real CLI uses it. The `Agent` tool_result comes back
 * immediately with nothing but a launch acknowledgement, because the agent
 * runs in the background; the agent's real end is the task notification
 * minutes later. Anything reading the tool blocks retires the agent at the
 * `result` below, which is the bug this arrangement guards against.
 */
function fakeQueryFnWithSubagent() {
  let release!: () => void;
  const finished = new Promise<void>((resolve) => { release = resolve; });
  const fn = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
    const sid = options?.sessionId ?? options?.resume;
    async function* gen() {
      for await (const _ of prompt) {
        yield { type: 'system', subtype: 'init', session_id: sid };
        yield {
          type: 'system', subtype: 'task_started', session_id: sid,
          task_id: 'k1', tool_use_id: 'ag1', description: 'reviewer',
          subagent_type: 'code-reviewer', task_type: 'local_agent',
          is_backgrounded: true, spawn_depth: 1,
        };
        yield {
          type: 'assistant', session_id: sid,
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'ag1', name: 'Agent', input: { description: 'reviewer' } },
            ],
          },
        };
        yield {
          type: 'user', session_id: sid,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'ag1',
                content: 'Async agent launched successfully. (This tool result is internal metadata …)',
              },
            ],
          },
        };
        // Ends the turn while the agent keeps working. The session going
        // `awaitingSubagents` is the test's proof that the launch tool_result
        // above has already been through the store.
        yield { type: 'result', subtype: 'success', session_id: sid, usage: {} };
        await finished;
        yield {
          type: 'system', subtype: 'task_notification', session_id: sid,
          task_id: 'k1', tool_use_id: 'ag1', status: 'completed',
          summary: 'Agent "reviewer" finished',
        };
        yield { type: 'result', subtype: 'success', session_id: sid, usage: {} };
      }
    }
    return gen() as any;
  };
  return { fn, release };
}

function tempClaudeDir() {
  const claudeDir = mkdtempSync(join(tmpdir(), 'orbital-e2e-'));
  mkdirSync(join(claudeDir, 'projects'), { recursive: true });
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
  return { claudeDir, dbPath: join(claudeDir, 'index.db') };
}

async function sessionOf(app: any, id: string) {
  const res = await app.inject({ method: 'GET', url: '/api/sessions' });
  return res.json().sessions.find((s: { id: string }) => s.id === id);
}

describe("a subagent in one of orbital's own sessions, end to end", () => {
  it('survives its own launch tool_result and is gone once its notification arrives', async () => {
    const { claudeDir, dbPath } = tempClaudeDir();
    const sdk = fakeQueryFnWithSubagent();
    const app = await buildServer({ claudeDir, dbPath, queryFn: sdk.fn as any });
    try {
      const created = await app.inject({
        method: 'POST', url: '/api/sessions',
        payload: { cwd: '/w', prompt: 'go', permissionMode: 'acceptEdits' },
      });
      const { sessionId } = created.json();

      // The turn is over, so the launch tool_result has been consumed, and
      // the agent is still on the planet. Nothing has been selected, nothing
      // tailed.
      await vi.waitFor(async () => {
        expect((await sessionOf(app, sessionId))?.awaitingSubagents).toBe(true);
      }, { timeout: 3000 });
      const waiting = await sessionOf(app, sessionId);
      expect(waiting?.subagents).toEqual([
        { id: 'k1', name: 'reviewer', state: 'working', toolUseId: 'ag1' },
      ]);
      // NOT `needs_input`: the turn ended, but the agent it launched will
      // wake the session back up on its own, so nothing here wants the human
      // (fix: `a-turn-that-launched-an-agent-reads-as-needs-input`).
      expect(waiting?.status).toBe('working');

      sdk.release();

      await vi.waitFor(async () => {
        expect((await sessionOf(app, sessionId))?.subagents).toEqual([]);
      }, { timeout: 3000 });
      // And only now, with nothing of its own left running, does it ask.
      await vi.waitFor(async () => {
        expect((await sessionOf(app, sessionId))?.status).toBe('needs_input');
      }, { timeout: 3000 });
      expect((await sessionOf(app, sessionId))?.awaitingSubagents).toBe(false);
    } finally {
      await app.close();
    }
  });
});
