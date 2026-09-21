import { describe, it, expect } from 'vitest';
import {
  planAutoheal,
  AUTOHEAL_CAP,
  AUTOHEAL_NEVER_CEILING_MS,
  type AutohealRow,
} from '../src/runner/autoheal.js';

const NOW = 1_800_000_000_000;
const IDLE = 30 * 60_000;

function row(over: Partial<AutohealRow> & { id: string }): AutohealRow {
  return { runnerStatus: 'needs_input', lastAt: NOW - 60_000, ...over };
}

function plan(rows: AutohealRow[], idleTimeoutMs: number | null = IDLE) {
  return planAutoheal({ rows, now: NOW, idleTimeoutMs });
}

describe('planAutoheal', () => {
  it('heals a session the runner still owned when the process died', () => {
    expect(plan([row({ id: 'a' })])).toEqual({ heal: ['a'], interrupted: [], expired: [] });
  });

  it('leaves a session the runner never owned out of the plan entirely', () => {
    expect(plan([row({ id: 'a', runnerStatus: null })])).toEqual({
      heal: [], interrupted: [], expired: [],
    });
  });

  it('expires a session the idle timer would already have ended', () => {
    const p = plan([row({ id: 'a', lastAt: NOW - IDLE - 1 })]);
    expect(p.heal).toEqual([]);
    expect(p.expired).toEqual(['a']);
  });

  it('expires a session sitting exactly on the idle boundary', () => {
    expect(plan([row({ id: 'a', lastAt: NOW - IDLE })]).expired).toEqual(['a']);
  });

  it('reports a session killed mid-turn as interrupted, and heals it too', () => {
    const p = plan([row({ id: 'a', runnerStatus: 'working' })]);
    expect(p.heal).toEqual(['a']);
    expect(p.interrupted).toEqual(['a']);
  });

  it('does not call a session that was merely waiting interrupted', () => {
    expect(plan([row({ id: 'a', runnerStatus: 'idle' })]).interrupted).toEqual([]);
  });

  it('never reports an expired session as interrupted', () => {
    const p = plan([row({ id: 'a', runnerStatus: 'working', lastAt: NOW - IDLE - 1 })]);
    expect(p.interrupted).toEqual([]);
    expect(p.expired).toEqual(['a']);
  });

  it('falls back to the ceiling when the idle timeout is "never"', () => {
    const fresh = row({ id: 'a', lastAt: NOW - AUTOHEAL_NEVER_CEILING_MS + 1 });
    const ancient = row({ id: 'b', lastAt: NOW - AUTOHEAL_NEVER_CEILING_MS });
    const p = plan([fresh, ancient], null);
    expect(p.heal).toEqual(['a']);
    expect(p.expired).toEqual(['b']);
  });

  it('expires a candidate with no recorded activity rather than guessing it is fresh', () => {
    expect(plan([row({ id: 'a', lastAt: null })]).expired).toEqual(['a']);
  });

  it('keeps the most recent sessions when more are healable than the cap', () => {
    const rows = Array.from({ length: AUTOHEAL_CAP + 3 }, (_, i) =>
      row({ id: `s${i}`, lastAt: NOW - i * 1000 }),
    );
    const p = plan(rows);
    expect(p.heal).toHaveLength(AUTOHEAL_CAP);
    expect(p.heal[0]).toBe('s0');
    expect(p.expired).toEqual([`s${AUTOHEAL_CAP}`, `s${AUTOHEAL_CAP + 1}`, `s${AUTOHEAL_CAP + 2}`]);
  });

  it('orders the heal list newest first, whatever order the rows arrive in', () => {
    const p = plan([
      row({ id: 'old', lastAt: NOW - 5000 }),
      row({ id: 'new', lastAt: NOW - 1000 }),
      row({ id: 'mid', lastAt: NOW - 3000 }),
    ]);
    expect(p.heal).toEqual(['new', 'mid', 'old']);
  });
});
