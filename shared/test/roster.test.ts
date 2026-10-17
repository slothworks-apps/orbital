import { describe, expect, it } from 'vitest';
import {
  addMember, describeMember, isLive, mergeRosters, removeMember, rosterDigest, type RosterEntry,
} from '../src/remote/roster.js';

const base = { kind: 'desktop', name: 'studio', os: 'macos', links: true, addedBy: 'A', addedAt: 1, describedAt: 1 };
const entry = (id: string, over: Partial<RosterEntry> = {}): RosterEntry => ({ ...base, id, epoch: 1, ...over });

describe('mergeRosters', () => {
  it('keeps every id from both sides, sorted', () => {
    expect(mergeRosters([entry('B')], [entry('A')]).map((e) => e.id)).toEqual(['A', 'B']);
  });

  it('a higher epoch wins, a removal wins within an epoch', () => {
    const removed = removeMember([entry('X')], 'X', 'A', 5);
    expect(isLive(mergeRosters([entry('X')], removed)[0])).toBe(false);
    const readded = addMember(removed, { ...base, id: 'X', addedBy: 'B', addedAt: 9, describedAt: 9 });
    expect(readded[0].epoch).toBe(2);
    expect(isLive(mergeRosters(removed, readded)[0])).toBe(true);
  });

  it('stale member: an old live entry never brings a removed device back', () => {
    const stale = [entry('X', { describedAt: 999 })];
    const current = removeMember([entry('X')], 'X', 'A', 5);
    expect(isLive(mergeRosters(stale, current)[0])).toBe(false);
    expect(isLive(mergeRosters(current, stale)[0])).toBe(false);
  });

  it('converges: merge is commutative and the digests agree', () => {
    const a = [entry('A'), entry('N', { addedBy: 'A', addedAt: 5, describedAt: 5 })];
    const b = [entry('B'), entry('N', { addedBy: 'B', addedAt: 6, describedAt: 5 })];
    const ab = mergeRosters(a, b);
    const ba = mergeRosters(b, a);
    expect(ab).toEqual(ba);
    expect(rosterDigest(ab)).toBe(rosterDigest(ba));
  });

  it('the later description wins within one epoch', () => {
    const renamed = describeMember([entry('A')], 'A', { name: 'home' }, 50);
    expect(mergeRosters([entry('A')], renamed)[0].name).toBe('home');
  });
});

describe('describeMember', () => {
  it('leaves the roster as it is when nothing changes', () => {
    const roster = [entry('A')];
    expect(describeMember(roster, 'A', { name: 'studio' }, 50)).toBe(roster);
  });
});

describe('rosterDigest', () => {
  it('changes with any field, not with key order', () => {
    const one = entry('A');
    const reordered = Object.fromEntries(Object.entries(one).reverse()) as RosterEntry;
    expect(rosterDigest([one])).toBe(rosterDigest([reordered]));
    expect(rosterDigest([one])).not.toBe(rosterDigest([entry('A', { links: false })]));
  });
});
