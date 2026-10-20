import { describe, it, expect, afterEach, vi } from 'vitest';
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
  it('calls every subscriber hook, even after one throws', () => {
    const hub = new Hub();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const second = vi.fn();
    const secondLast = vi.fn();
    hub.onFirstSubscriber(() => { throw new Error('boom'); });
    hub.onFirstSubscriber(second);
    hub.onLastUnsubscriber(() => { throw new Error('boom'); });
    hub.onLastUnsubscriber(secondLast);
    const a = fakeSocket();
    hub.handleSocket(a);
    a.emit('message', JSON.stringify({ type: 'subscribe', topic: 'session:x' }));
    a.emit('close');
    expect(second).toHaveBeenCalledWith('session:x');
    expect(secondLast).toHaveBeenCalledWith('session:x');
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
  it('ignores malformed messages', () => {
    const hub = new Hub();
    const a = fakeSocket();
    hub.handleSocket(a);
    expect(() => a.emit('message', 'not json')).not.toThrow();
  });
});

describe('Hub heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends a heartbeat frame to a connected socket on every interval', () => {
    vi.useFakeTimers();
    const hub = new Hub({ heartbeatIntervalMs: 1000 });
    const a = fakeSocket();
    hub.handleSocket(a);

    vi.advanceTimersByTime(2000);

    const heartbeats = a.send.mock.calls.filter(
      ([data]: [string]) => JSON.parse(data).type === 'heartbeat',
    );
    expect(heartbeats).toHaveLength(2);
  });

  it('names in each heartbeat the topics the hub holds this socket on', () => {
    vi.useFakeTimers();
    const hub = new Hub({ heartbeatIntervalMs: 1000 });
    const a = fakeSocket();
    hub.handleSocket(a);
    a.emit('message', JSON.stringify({ type: 'subscribe', topic: 'sessions' }));
    a.emit('message', JSON.stringify({ type: 'subscribe', topic: 'session:x' }));
    a.emit('message', JSON.stringify({ type: 'unsubscribe', topic: 'sessions' }));

    vi.advanceTimersByTime(1000);

    const [data] = a.send.mock.calls.at(-1) as [string];
    expect(JSON.parse(data)).toEqual({ type: 'heartbeat', topics: ['session:x'] });
  });

  it('stops sending heartbeats once the socket closes', () => {
    vi.useFakeTimers();
    const hub = new Hub({ heartbeatIntervalMs: 1000 });
    const a = fakeSocket();
    hub.handleSocket(a);

    vi.advanceTimersByTime(1000);
    a.emit('close');
    vi.advanceTimersByTime(5000);

    expect(a.send).toHaveBeenCalledTimes(1);
  });
});

describe('Hub local subscribers', () => {
  it('counts only this device\'s own windows, not a paired device\'s view of the hub', () => {
    const hub = new Hub();
    const first = vi.fn();
    const last = vi.fn();
    hub.onFirstLocalSubscriber(first);
    hub.onLastLocalSubscriber(last);
    const peer = Object.assign(fakeSocket(), { peer: 'phone' });
    const win = fakeSocket();
    hub.handleSocket(peer);
    hub.handleSocket(win);
    peer.emit('message', JSON.stringify({ type: 'subscribe', topic: 'limits' }));
    expect(first).not.toHaveBeenCalled();
    win.emit('message', JSON.stringify({ type: 'subscribe', topic: 'limits' }));
    win.emit('message', JSON.stringify({ type: 'subscribe', topic: 'limits' }));
    expect(first).toHaveBeenCalledTimes(1);
    win.emit('close');
    expect(last).toHaveBeenCalledWith('limits');
    expect(hub.subscriberCount('limits')).toBe(1);
    peer.emit('close');
    expect(last).toHaveBeenCalledTimes(1);
  });
});
