import { describe, it, expect } from 'vitest';
import { listedBackgroundTasks, statusOf, type ShapeContext } from '../src/api/shape.js';
import type { BackgroundTaskInfo } from '../src/transcript/backgroundTasks.js';
import type { SessionRow, SessionSource, SessionStatus } from '../src/types.js';

/**
 * `statusOf` reads only the Runner, the registry, the pending rewinds and the
 * row, so the context is those three lookups and nothing else.
 */
function ctxWith(opts: { runner?: SessionStatus; registry?: SessionStatus } = {}): ShapeContext {
  return {
    runner: { status: () => opts.runner },
    registry: { get: () => (opts.registry ? { status: opts.registry } : undefined) },
    // No pending rewind anywhere.
    db: { select: () => ({ from: () => ({ where: () => ({ get: () => undefined }) }) }) },
  } as unknown as ShapeContext;
}

function row(source: SessionSource, endedAt: number | null): SessionRow {
  return { id: 'x', source, ended_at: endedAt } as SessionRow;
}

// Spec 2026-09-24-sessions-end-only-by-hand-design § 1.
describe('statusOf', () => {
  it('takes the Runner\'s status over everything, the ended stamp included', () => {
    expect(statusOf(ctxWith({ runner: 'working', registry: 'idle' }), row('web', 5))).toBe('working');
  });

  it('falls back to the terminal registry when the Runner holds nothing', () => {
    expect(statusOf(ctxWith({ registry: 'needs_input' }), row('terminal', null))).toBe('needs_input');
  });

  it('reads a terminal session nobody is running as ended, with no stamp', () => {
    expect(statusOf(ctxWith(), row('terminal', null))).toBe('ended');
  });

  it('reads an Orbital session with no process and no stamp as idle', () => {
    expect(statusOf(ctxWith(), row('web', null))).toBe('idle');
  });

  it('reads an Orbital session the user ended as ended', () => {
    expect(statusOf(ctxWith(), row('web', 1234))).toBe('ended');
  });
});

describe('listedBackgroundTasks', () => {
  const task = (id: number, state: 'running' | 'ended'): BackgroundTaskInfo =>
    ({ id: `t${id}`, kind: 'shell', label: 'x', state, startedAt: id }) as BackgroundTaskInfo;

  it('keeps only the running tasks, in start order', () => {
    const tasks = [task(0, 'running'), task(1, 'ended'), task(2, 'ended'), task(3, 'running')];
    expect(listedBackgroundTasks(tasks).map((t) => t.id)).toEqual(['t0', 't3']);
  });
});
