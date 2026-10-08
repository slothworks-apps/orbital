import { eq } from 'drizzle-orm';
import { DEFAULT_NOTIFICATION_SETTINGS } from '@orbital/shared/notifications';
import { NotificationSettingsSchema, type NotificationSettings } from '@orbital/shared/remote/messages';
import { remoteDevices } from '../db/schema.js';
import type { OrbitalDb } from '../db/database.js';

export type RemoteDevice = {
  id: string; name: string; platform: string; pairedAt: number; lastSeenAt: number | null;
  notifications: NotificationSettings;
};

/** The phones paired with this Mac (spec 2026-09-30-mobile-remote-design § 3). */
export class DeviceStore {
  constructor(private readonly db: OrbitalDb) {}

  list(): RemoteDevice[] {
    return this.db.select().from(remoteDevices).orderBy(remoteDevices.pairedAt).all().map(fromRow);
  }

  get(id: string): RemoteDevice | null {
    const row = this.db.select().from(remoteDevices).where(eq(remoteDevices.id, id)).get();
    return row ? fromRow(row) : null;
  }

  add(d: Omit<RemoteDevice, 'lastSeenAt'>): void {
    this.db.insert(remoteDevices).values({
      id: d.id, name: d.name, platform: d.platform, pairedAt: d.pairedAt,
      notifications: JSON.stringify(d.notifications),
    }).onConflictDoUpdate({
      target: remoteDevices.id,
      // Notifications and lastSeenAt are left as they are: the phone's own
      // notification rows are edited only from the phone after pairing, and
      // a revoke removes the row entirely, so a real re-pair always inserts
      // fresh rather than hitting this branch.
      set: { name: d.name, platform: d.platform, pairedAt: d.pairedAt },
    }).run();
  }

  remove(id: string): void {
    this.db.delete(remoteDevices).where(eq(remoteDevices.id, id)).run();
  }

  touch(id: string, now: number): void {
    this.db.update(remoteDevices).set({ lastSeenAt: now }).where(eq(remoteDevices.id, id)).run();
  }

  setNotifications(id: string, settings: NotificationSettings): void {
    this.db.update(remoteDevices).set({ notifications: JSON.stringify(settings) }).where(eq(remoteDevices.id, id)).run();
  }
}

function fromRow(row: typeof remoteDevices.$inferSelect): RemoteDevice {
  let notifications = DEFAULT_NOTIFICATION_SETTINGS;
  try {
    const parsed = NotificationSettingsSchema.safeParse(JSON.parse(row.notifications));
    if (parsed.success) notifications = parsed.data;
  } catch {
    // Unreadable JSON reads as the defaults: silent, as a fresh install is.
  }
  return {
    id: row.id, name: row.name, platform: row.platform, pairedAt: row.pairedAt,
    lastSeenAt: row.lastSeenAt, notifications,
  };
}
