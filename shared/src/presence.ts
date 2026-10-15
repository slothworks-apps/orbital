/**
 * Whether the user is at the Mac, as the desktop app reports it and the hub
 * publishes it (spec 2026-10-15-the-phone-is-quiet-while-you-are-at-the-mac-design).
 * While it holds, the phone notifies nothing.
 */

/** The hub topic presence is published on, and the phone subscribes to. */
export const PRESENCE_TOPIC = 'presence';

/** `{ topic: 'presence', event: 'state', atMac }`: true or false; null for any other frame. */
export function presenceFromFrame(frame: unknown): boolean | null {
  if (typeof frame !== 'object' || frame === null) return null;
  const f = frame as { topic?: unknown; event?: unknown; atMac?: unknown };
  if (f.topic !== PRESENCE_TOPIC || f.event !== 'state' || typeof f.atMac !== 'boolean') return null;
  return f.atMac;
}
