import { describe, it, expect } from 'vitest';
import { statusOf, type ShapeContext } from '../src/api/shape.js';
import type { SessionRow, SessionSource, SessionStatus } from '../src/types.js';

/**
 * `statusOf` reads only the Runner, the registry and the row, so the context
 * is those two lookups and nothing else.
 */
function ctxWith(opts: { runner?: SessionStatus; registry?: SessionStatus } = {}): ShapeContext {
  return {
    runner: { status: () => opts.runner },
    registry: { get: () => (opts.registry ? { status: opts.registry } : undefined) },
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
