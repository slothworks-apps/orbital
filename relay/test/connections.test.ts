import { describe, it, expect } from 'vitest';
import { OFFLINE_QUEUE_MAX_DEVICES, OfflineQueue } from '../src/connections.js';

describe('OfflineQueue', () => {
  it('holds at most OFFLINE_QUEUE_MAX_DEVICES devices, dropping the least recently pushed', () => {
    const q = new OfflineQueue();
    for (let i = 0; i < OFFLINE_QUEUE_MAX_DEVICES; i++) q.push(`d${i}`, new Uint8Array([i & 0xff]));
    // d0 is pushed again, so d1 is now the least recently pushed.
    q.push('d0', new Uint8Array([1]));
    q.push('new', new Uint8Array([2]));
    expect(q.drain('d1')).toEqual([]);
    expect(q.drain('d0')).toHaveLength(2);
    expect(q.drain('d2')).toHaveLength(1);
    expect(q.drain('new')).toEqual([new Uint8Array([2])]);
  });
});
