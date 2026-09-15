import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Hub } from '../src/api/hub.js';

function fakeSocket() {
  const em = new EventEmitter() as any;
  em.send = vi.fn();
  return em;
}

describe('Hub', () => {
  it('routes published payloads to topic subscribers only', () => {
    const hub = new Hub();
    const a = fakeSocket();
    const b = fakeSocket();
    hub.handleSocket(a);
    hub.handleSocket(b);
    a.emit('message', JSON.stringify({ type: 'subscribe', topic: 'sessions' }));
    hub.publish('sessions', { event: 'upsert', session: { id: 's1' } });
    expect(a.send).toHaveBeenCalledWith(
      JSON.stringify({ topic: 'sessions', event: 'upsert', session: { id: 's1' } }),
    );
    expect(b.send).not.toHaveBeenCalled();
  });
  it('fires first/last subscriber callbacks and cleans up on close', () => {
    const hub = new Hub();
    const first = vi.fn();
    const last = vi.fn();
    hub.onFirstSubscriber(first);
    hub.onLastUnsubscriber(last);
    const a = fakeSocket();
    hub.handleSocket(a);
    a.emit('message', JSON.stringify({ type: 'subscribe', topic: 'session:x' }));
    expect(first).toHaveBeenCalledWith('session:x');
    a.emit('close');
    expect(last).toHaveBeenCalledWith('session:x');
    expect(hub.subscriberCount('session:x')).toBe(0);
  });
  it('ignores malformed messages', () => {
    const hub = new Hub();
    const a = fakeSocket();
    hub.handleSocket(a);
    expect(() => a.emit('message', 'not json')).not.toThrow();
  });
});
