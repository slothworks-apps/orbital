/**
 * Asking macOS whether Orbital may notify, for the tip's Turn on (spec
 * 2026-10-08-notifications-off-by-default-design § 3, canvas `Feature -
 * Notifications off` 1d).
 *
 * Electron has no permission API for notifications on macOS: the system asks
 * the first time the app shows one, and the answer is never handed back. What
 * Electron does report is how one notification went — `show` once macOS took
 * it, `failed` when macOS refused it, which is what a refused (or since
 * revoked) permission looks like. So the question is asked by showing one
 * quiet notification and reading which of the two comes back.
 *
 * Neither may come: the system prompt can sit unanswered. That is `unknown`,
 * and the caller treats it as a yes — the user asked for notifications, and
 * macOS will hold them until its question is answered.
 */

export type NotificationPermissionAnswer = 'granted' | 'denied' | 'unknown';

/** How long the system prompt may stay unanswered before the answer is `unknown`. */
export const PERMISSION_ANSWER_TIMEOUT_MS = 60_000;

/** The part of Electron's `Notification` the probe uses. */
export interface ProbeNotification {
  on(event: 'show', listener: () => void): unknown;
  on(event: 'failed', listener: (event: unknown, error: string) => void): unknown;
  show(): void;
  close(): void;
}

export function probeNotificationPermission(
  make: () => ProbeNotification,
  timeoutMs: number = PERMISSION_ANSWER_TIMEOUT_MS,
): Promise<NotificationPermissionAnswer> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (answer: NotificationPermissionAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(answer);
    };
    const timer = setTimeout(() => settle('unknown'), timeoutMs);
    let n: ProbeNotification;
    try {
      n = make();
    } catch {
      settle('denied');
      return;
    }
    n.on('show', () => {
      // It was only the question: the tip already says what was switched on,
      // so the notification itself does not stay in Notification Centre.
      n.close();
      settle('granted');
    });
    n.on('failed', () => settle('denied'));
    try {
      n.show();
    } catch {
      settle('denied');
    }
  });
}

/**
 * System Settings → Notifications (macOS 13+, the desktop's minimum). The
 * pane lists every app; macOS has no public link to one app's own page.
 */
export const NOTIFICATION_SETTINGS_URL = 'x-apple.systempreferences:com.apple.Notifications-Settings.extension';
