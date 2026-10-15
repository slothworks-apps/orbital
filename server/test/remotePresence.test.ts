import { afterEach, describe, expect, it, vi } from 'vitest';
import { Presence } from '../src/remote/presence.js';

describe('Presence', () => {
  afterEach(() => vi.useRealTimers());

  function build() {
    vi.useFakeTimers();
    const published: unknown[] = [];
    const presence = new Presence({ publish: (topic, payload) => published.push({ topic, ...payload }), ttlMs: 1_000 });
    return { presence, published };
  }

  it('a heartbeat holds presence until the next one is overdue, and publishes only changes', () => {
    const { presence, published } = build();
    expect(presence.atMac).toBe(false);
    presence.report(true);
    vi.advanceTimersByTime(800);
    presence.report(true);
    vi.advanceTimersByTime(800);
    expect(presence.atMac).toBe(true);
    expect(published).toEqual([{ topic: 'presence', event: 'state', atMac: true }]);
    vi.advanceTimersByTime(300);
    expect(presence.atMac).toBe(false);
    expect(published).toEqual([
      { topic: 'presence', event: 'state', atMac: true },
      { topic: 'presence', event: 'state', atMac: false },
    ]);
  });

  it('a report of leaving ends presence at once, and its timer with it', () => {
    const { presence, published } = build();
    presence.report(true);
    presence.report(false);
    presence.report(false);
    expect(presence.atMac).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(published).toHaveLength(2);
  });
});
