import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probeNotificationPermission } from '../src/lib/notificationPermission';

/** A notification whose fate the test decides after `show`. */
function fake() {
  const listeners: { show?: () => void; failed?: (e: unknown, error: string) => void } = {};
  const n = {
    shown: false,
    closed: false,
    on(event: 'show' | 'failed', listener: never) {
      listeners[event] = listener;
      return n;
    },
    show() {
      n.shown = true;
    },
    close() {
      n.closed = true;
    },
    emitShow: () => listeners.show?.(),
    emitFailed: () => listeners.failed?.({}, 'Notifications are not allowed for this application'),
  };
  return n;
}

describe('probeNotificationPermission', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is granted once macOS shows the notification, which then goes', async () => {
    const n = fake();
    const answer = probeNotificationPermission(() => n, 1000);
    expect(n.shown).toBe(true);
    n.emitShow();
    await expect(answer).resolves.toBe('granted');
    expect(n.closed).toBe(true);
  });

  it('is denied when macOS refuses it', async () => {
    const n = fake();
    const answer = probeNotificationPermission(() => n, 1000);
    n.emitFailed();
    await expect(answer).resolves.toBe('denied');
  });

  it('is unknown while the system prompt goes unanswered, and a late answer changes nothing', async () => {
    const n = fake();
    const answer = probeNotificationPermission(() => n, 1000);
    vi.advanceTimersByTime(1000);
    await expect(answer).resolves.toBe('unknown');
    n.emitFailed();
    await expect(answer).resolves.toBe('unknown');
  });

  it('is denied when the notification cannot even be made', async () => {
    const answer = probeNotificationPermission(() => {
      throw new Error('not supported');
    }, 1000);
    await expect(answer).resolves.toBe('denied');
  });
});
