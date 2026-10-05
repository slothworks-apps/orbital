import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { harnessGateOf, harnessStepOf } from '../src/api/shape.js';
import { sessionHarnesses } from '../src/db/schema.js';
import type { StepState } from '../src/harness/types.js';
import { openTmpDb } from './tmp.js';

/**
 * `ApiSession.harnessStep`: what lets a list say "step n of m" without
 * reading the harness (spec 2026-10-05-mobile-next-design § 1 Server).
 */
describe('harnessStep on the snapshot', () => {
  function withHarness(state: StepState[]) {
    const db = openTmpDb('phone-snapshot');
    db.insert(sessionHarnesses).values({
      sessionId: 's1', name: 'h', steps: [], inputs: {}, state, createdAt: 0, updatedAt: 0,
    }).run();
    return db;
  }

  it('is null without a harness', () => {
    expect(harnessStepOf(openTmpDb('phone-snapshot'), 's1')).toBeNull();
  });

  it('is the first step not done, mid-run and at a gate', () => {
    const db = withHarness([{ status: 'done' }, { status: 'active' }, { status: 'pending' }]);
    expect(harnessStepOf(db, 's1')).toEqual({ index: 1, total: 3 });

    db.update(sessionHarnesses).set({ state: [{ status: 'done' }, { status: 'done' }, { status: 'awaiting_approval' }] }).run();
    expect(harnessStepOf(db, 's1')).toEqual({ index: 2, total: 3 });
    expect(harnessGateOf(db, 's1')).toBe('waiting');
  });

  it('reads index === total once every step is done', () => {
    const db = withHarness([{ status: 'done' }, { status: 'done' }]);
    expect(harnessStepOf(db, 's1')).toEqual({ index: 2, total: 2 });
  });

  it('is null once the harness was removed', () => {
    const db = withHarness([{ status: 'active' }, { status: 'pending' }]);
    db.update(sessionHarnesses).set({ removedAt: 1 }).where(eq(sessionHarnesses.sessionId, 's1')).run();
    expect(harnessStepOf(db, 's1')).toBeNull();
  });
});
