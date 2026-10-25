/**
 * What a device in a group is (spec 2026-10-16-device-group-design § 1, § 8):
 * its kind, what it does, and which side of a pair opens the channel (§ 5).
 */

export type DeviceKind = 'desktop' | 'headless' | 'phone';
export type Capability = 'sessions' | 'map' | 'ide' | 'folderPicker' | 'presence' | 'group' | 'settings-sync';

/**
 * The member of the group a session runs on, as the device showing it names
 * it (spec 2026-10-16-device-group-design § 7); absent on a session of the
 * device itself. `asOf`: when that device last heard from the member, while
 * it shows the member offline (epoch ms); null while it is online.
 */
export type MachineRef = { id: string; name: string; kind: string; os: string; online: boolean; asOf: number | null };

/**
 * The `sessions` event that says a member's state changed — online, offline,
 * renamed: every session with `machine.id` takes `machine`, in one frame
 * rather than an upsert per session. Never sent to a peer: it is about
 * another member.
 */
export type MachineEvent = { event: 'machine'; machine: MachineRef };

/**
 * The first ask id of a channel's responder. The initiator numbers from 1;
 * a blob chunk's id (a 32-bit field) then says on its own whether it
 * answers this side's ask or carries the peer's upload.
 */
export const RESPONDER_FIRST_ID = 2 ** 31;

/**
 * What a kind of device can be asked about or sent, named in its hello
 * (spec 2026-10-16-device-group-design § 1, § 2). `group` is the roster
 * itself: a device that serves anything carries it, so a shipped phone
 * (always `[]`) never takes a group message (`Channel.groups`).
 * `settings-sync`: it shares the group's settings
 * (`SETTINGS_SYNC_CAPABILITY`, spec 2026-10-24-group-shared-settings-design).
 */
export function capabilitiesOf(kind: DeviceKind): Capability[] {
  if (kind === 'phone') return [];
  if (kind === 'headless') return ['sessions', 'group', 'settings-sync'];
  return ['sessions', 'map', 'ide', 'folderPicker', 'presence', 'group', 'settings-sync'];
}

/**
 * Whether this device opens the channel to `peer`. `peer.kind` null: paired
 * through the code of a Mac from before kinds, which only ever answers.
 */
export function initiates(self: { id: string; kind: DeviceKind }, peer: { id: string; kind: string | null }): boolean {
  if (self.kind === 'phone') return true;
  if (peer.kind === 'phone') return false;
  if (peer.kind === null) return true;
  return self.id < peer.id;
}

/** A Node `process.platform` or a Capacitor platform, as a device names its OS. */
export function osName(platform: string): string {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return platform;
}
