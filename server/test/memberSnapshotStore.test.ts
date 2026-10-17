import { describe, expect, it, vi } from 'vitest';
import { memberSnapshots } from '../src/db/schema.js';
import { MemberSnapshotStore } from '../src/federation/store.js';
import { openTmpDb } from './tmp.js';

describe('MemberSnapshotStore', () => {
  it('keeps a member\'s sessions and tags as sent, replaces them on the next save, and removes them', () => {
    const store = new MemberSnapshotStore(openTmpDb('snapshots'), () => 9);
    expect(store.load()).toEqual([]);
    store.save('b', [{ id: 's1', status: 'working', tagIds: [7] }], [{ id: 7, name: 'work', hue: 10 }], 100);
    store.save('c', [], [], 50);
    store.save('b', [{ id: 's2' }], [], 200);
    expect(store.load().sort((x, y) => x.memberId.localeCompare(y.memberId))).toEqual([
      { memberId: 'b', sessions: [{ id: 's2' }], tags: [], seenAt: 200 },
      { memberId: 'c', sessions: [], tags: [], seenAt: 50 },
    ]);
    store.remove('b');
    expect(store.load().map((s) => s.memberId)).toEqual(['c']);
  });

  it('skips a row that does not parse, and loads the rest', () => {
    const db = openTmpDb('snapshots');
    const store = new MemberSnapshotStore(db);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    db.insert(memberSnapshots).values({ memberId: 'bad', sessions: '{not json', tags: '[]', seenAt: 1, updatedAt: 1 }).run();
    db.insert(memberSnapshots).values({ memberId: 'object', sessions: '{}', tags: '[]', seenAt: 1, updatedAt: 1 }).run();
    store.save('good', [{ id: 's1' }], [], 5);
    expect(store.load().map((s) => s.memberId)).toEqual(['good']);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
