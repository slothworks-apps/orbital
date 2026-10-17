/**
 * Decides, for one paired phone, which session events deserve a `wake` —
 * whether or not that phone is connected right now. The desktop's own
 * notification rules (`SessionNotifier`) are the judge, with the phone's
 * settings; this class only adds the debounce: one wake per session until
 * the phone opens it or the session moves on (spec
 * 2026-09-30-mobile-remote-design § 3 Wake flag, § 5).
 */
import { EventEmitter } from 'node:events';
import { SessionNotifier, type NotificationSettings } from '@orbital/shared/notifications';
import type { Hub } from '../api/hub.js';

export type DeviceWatcherOptions = {
  deviceId: string;
  hub: Hub;
  settings: () => NotificationSettings;
  onWake: (sessionId: string) => void;
  /**
   * True while the user is at the Mac: nothing wakes the phone then, and
   * nothing muted is sent later (spec
   * 2026-10-15-the-phone-is-quiet-while-you-are-at-the-mac-design § 2).
   */
  quiet?: () => boolean;
};

export class DeviceWatcher {
  private readonly notifier = new SessionNotifier();
  private readonly pending = new Set<string>();
  /**
   * Sessions seen only as another member's (carrying `machine`): that member
   * wakes the phone for its own (spec 2026-10-16-device-group-design § 10).
   */
  private readonly foreign = new Set<string>();
  private socket: (EventEmitter & { send(data: string): void }) | null = null;

  constructor(private readonly opts: DeviceWatcherOptions) {}

  /** `initialSessions` seeds the notifier so the first sighting is never news. */
  start(initialSessions: unknown[]): void {
    // A second subscriber would wake the phone twice for every event.
    if (this.socket) return;
    for (const session of initialSessions) {
      if (this.isForeign({ topic: 'sessions', event: 'upsert', session })) continue;
      this.notifier.onEvent({ topic: 'sessions', event: 'upsert', session });
    }
    const socket = Object.assign(new EventEmitter(), { send: (data: string) => this.onFrame(data) });
    this.socket = socket;
    this.opts.hub.handleSocket(socket);
    socket.emit('message', JSON.stringify({ type: 'subscribe', topic: 'sessions' }));
    socket.emit('message', JSON.stringify({ type: 'subscribe', topic: 'errors' }));
  }

  seen(sessionId: string): void {
    this.pending.delete(sessionId);
  }

  stop(): void {
    this.socket?.emit('close');
    this.socket = null;
  }

  /** Whether a `sessions` frame is about another member's session; remembers which ids are. */
  private isForeign(frame: Record<string, unknown>): boolean {
    if (frame.topic !== 'sessions') return false;
    const session = frame.session && typeof frame.session === 'object'
      ? (frame.session as { id?: string | number | null; machine?: unknown }) : undefined;
    if (session) {
      const id = String(session.id ?? '');
      if (session.machine != null) {
        this.foreign.add(id);
        return true;
      }
      this.foreign.delete(id);
      return false;
    }
    if (typeof frame.sessionId !== 'string' || !this.foreign.has(frame.sessionId)) return false;
    if (frame.event === 'remove') this.foreign.delete(frame.sessionId);
    return true;
  }

  private onFrame(data: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (this.isForeign(frame)) return;
    // A session leaving needs_input retires its debounce, whichever way it went.
    if (frame.topic === 'sessions') {
      const session = frame.session && typeof frame.session === 'object'
        ? (frame.session as { id?: string | number | null; status?: unknown }) : undefined;
      const id = typeof frame.sessionId === 'string' ? frame.sessionId
        // Any non-null id is stringified, as the debounce has always keyed it.
        : String(session?.id ?? '');
      const status = typeof frame.status === 'string' ? frame.status : session?.status;
      if (id && status && status !== 'needs_input') this.pending.delete(id);
      if (frame.event === 'remove' && id) this.pending.delete(id);
    }
    this.notifier.setSettings(this.opts.settings());
    const note = this.notifier.onEvent(frame);
    if (!note?.sessionId) return;
    if (this.opts.quiet?.()) return;
    // A failure is news even while a needs_input wake for the same session
    // is unopened, and it has no "leaving" event to retire a debounce with.
    const debounced = frame.topic !== 'errors';
    if (debounced && this.pending.has(note.sessionId)) return;
    try {
      this.opts.onWake(note.sessionId);
    } catch (err) {
      // Not marked pending, so the next transition gets another try.
      console.warn(`[remote] wake for ${this.opts.deviceId} failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (debounced) this.pending.add(note.sessionId);
  }
}
