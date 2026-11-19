import { describe, it, expect, vi, afterEach } from 'vitest';
import { askContextReport } from '../src/runner/runner.js';

/**
 * The report opened from the context read-out asks the live query on the side
 * (spec 2026-11-19-context-report-dialog-design § Opening it from the context
 * read-out): full detail, bounded, and every way it can go wrong named.
 */
const ANSWER = {
  model: 'claude-opus-5', totalTokens: 1000, maxTokens: 200000, rawMaxTokens: 200000, percentage: 1,
  categories: [{ name: 'Messages', tokens: 1000, kind: 'used' }],
};

afterEach(() => vi.useRealTimers());

describe('askContextReport', () => {
  it('asks for the full breakdown and reads it', async () => {
    const getContextUsage = vi.fn(async () => ANSWER);
    const answer = await askContextReport({ getContextUsage }, 1000);
    expect(getContextUsage).toHaveBeenCalledWith({ detail: 'full' });
    expect(answer).toMatchObject({ report: { totalTokens: 1000, rawMaxTokens: 200000 } });
  });

  it('is unsupported on a query without the control request', async () => {
    expect(await askContextReport({}, 1000)).toEqual({ error: 'unsupported' });
  });

  it('fails when the CLI refuses or answers with nothing readable', async () => {
    expect(await askContextReport({ getContextUsage: async () => { throw new Error('unknown subtype'); } }, 1000))
      .toMatchObject({ error: 'failed', message: expect.stringContaining('unknown subtype') });
    expect(await askContextReport({ getContextUsage: async () => ({ totalTokens: 5 }) }, 1000))
      .toMatchObject({ error: 'failed', detail: '{"totalTokens":5}' });
  });

  it('times out on a CLI that does not answer', async () => {
    vi.useFakeTimers();
    const pending = askContextReport({ getContextUsage: () => new Promise(() => {}) }, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual({ error: 'timeout' });
  });
});
