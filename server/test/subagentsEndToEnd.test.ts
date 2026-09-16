import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/index.js';

/**
 * The whole chain against a real `buildServer`, the one place the pieces meet:
 * SDK stream -> Runner.onEntries -> SubagentStore -> toApiSession ->
 * GET /api/sessions. The unit tests each prove one link; only this proves
 * index.ts wires them to each other.
 *
 * Orbital's own sessions are the only ones that can have subagents at all —
 * see `docs/domains/subagents-in-transcripts.md` for why a terminal session's
 * transcript cannot answer the question.
 */

/** Fake SDK that starts one subagent, parks, and finishes it when released. */
function fakeQueryFnWithSubagent() {
  let release!: () => void;
  const finished = new Promise<void>((resolve) => { release = resolve; });
  const fn = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
    const sid = options?.sessionId ?? options?.resume;
    async function* gen() {
      for await (const _ of prompt) {
        yield { type: 'system', subtype: 'init', session_id: sid };
        yield {
          type: 'assistant', session_id: sid,
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'ag1', name: 'Agent', input: { description: 'reviewer' } },
            ],
          },
        };
        await finished;
        yield {
          type: 'user', session_id: sid,
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'ag1', content: 'reviewed' }],
          },
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

async function subagentsOf(app: any, id: string) {
  const res = await app.inject({ method: 'GET', url: '/api/sessions' });
  return res.json().sessions.find((s: { id: string }) => s.id === id)?.subagents;
}

describe("a subagent in one of orbital's own sessions, end to end", () => {
  it('appears while it runs and is gone once it reports back', async () => {
    const { claudeDir, dbPath } = tempClaudeDir();
    const sdk = fakeQueryFnWithSubagent();
    const app = await buildServer({ claudeDir, dbPath, queryFn: sdk.fn as any });
    try {
      const created = await app.inject({
        method: 'POST', url: '/api/sessions',
        payload: { cwd: '/w', prompt: 'go', permissionMode: 'acceptEdits' },
      });
      const { sessionId } = created.json();

      // While the subagent runs — nothing has been selected, nothing tailed.
      await vi.waitFor(async () => {
        expect(await subagentsOf(app, sessionId)).toEqual([
          { id: 'ag1', name: 'reviewer', state: 'working' },
        ]);
      }, { timeout: 3000 });

      sdk.release();

      await vi.waitFor(async () => {
        expect(await subagentsOf(app, sessionId)).toEqual([]);
      }, { timeout: 3000 });
    } finally {
      await app.close();
    }
  });
});
