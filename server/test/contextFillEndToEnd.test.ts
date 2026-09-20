import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/index.js';

/**
 * The context arc's numerator across the whole chain, the one place the
 * pieces meet: SDK stream -> Runner.onContextUsed -> sessions row ->
 * toApiSession -> GET /api/sessions (spec `context-fill-arc`). The unit
 * tests prove each link; only this proves index.ts joined them, and that the
 * number survives into the snapshot the map reads rather than only onto a
 * per-session topic nobody is subscribed to.
 *
 * Only Orbital's own sessions can have one at all — a terminal session's
 * transcript is indexed, and the indexer extracts no usage.
 */

/** Fake SDK that ends a turn with usage, then compacts when released. */
function fakeQueryFnCompacting(postTokens?: number) {
  let release!: () => void;
  const compacted = new Promise<void>((resolve) => { release = resolve; });
  const fn = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
    const sid = options?.sessionId ?? options?.resume;
    async function* gen() {
      for await (const _ of prompt) {
        yield { type: 'system', subtype: 'init', session_id: sid };
        yield {
          type: 'result', subtype: 'success', session_id: sid,
          usage: {
            input_tokens: 1_000, cache_read_input_tokens: 150_000,
            cache_creation_input_tokens: 2_000, output_tokens: 500,
          },
        };
        await compacted;
        yield {
          type: 'system', subtype: 'compact_boundary', session_id: sid,
          compact_metadata: {
            trigger: 'manual', pre_tokens: 153_500,
            ...(postTokens === undefined ? {} : { post_tokens: postTokens }),
          },
        };
      }
    }
    return gen() as any;
  };
  return { fn, release };
}

function tempClaudeDir() {
  const claudeDir = mkdtempSync(join(tmpdir(), 'orbital-context-e2e-'));
  mkdirSync(join(claudeDir, 'projects'), { recursive: true });
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
  return { claudeDir, dbPath: join(claudeDir, 'index.db') };
}

async function sessionOf(app: any, id: string) {
  const res = await app.inject({ method: 'GET', url: '/api/sessions' });
  return res.json().sessions.find((s: { id: string }) => s.id === id);
}

describe('context used tokens, end to end', () => {
  it('lands on the session snapshot after a turn and shrinks at a compaction', async () => {
    const { claudeDir, dbPath } = tempClaudeDir();
    const sdk = fakeQueryFnCompacting(24_000);
    const app = await buildServer({ claudeDir, dbPath, queryFn: sdk.fn as any });
    try {
      const created = await app.inject({
        method: 'POST', url: '/api/sessions',
        payload: { cwd: '/w', prompt: 'go', permissionMode: 'acceptEdits' },
      });
      const { sessionId } = created.json();

      await vi.waitFor(async () => {
        expect((await sessionOf(app, sessionId))?.contextUsedTokens).toBe(153_500);
      }, { timeout: 3000 });

      sdk.release();

      await vi.waitFor(async () => {
        expect((await sessionOf(app, sessionId))?.contextUsedTokens).toBe(24_000);
      }, { timeout: 3000 });
    } finally {
      await app.close();
    }
  });

  it('clears it when the compaction does not say how much survived', async () => {
    const { claudeDir, dbPath } = tempClaudeDir();
    const sdk = fakeQueryFnCompacting(undefined);
    const app = await buildServer({ claudeDir, dbPath, queryFn: sdk.fn as any });
    try {
      const created = await app.inject({
        method: 'POST', url: '/api/sessions',
        payload: { cwd: '/w', prompt: 'go', permissionMode: 'acceptEdits' },
      });
      const { sessionId } = created.json();
      await vi.waitFor(async () => {
        expect((await sessionOf(app, sessionId))?.contextUsedTokens).toBe(153_500);
      }, { timeout: 3000 });

      sdk.release();

      // Null rather than the pre-compaction figure: a full arc after a
      // /compact is the exact lie this branch exists to avoid.
      await vi.waitFor(async () => {
        expect((await sessionOf(app, sessionId))?.contextUsedTokens).toBeNull();
      }, { timeout: 3000 });
    } finally {
      await app.close();
    }
  });
});
