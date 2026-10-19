/**
 * Member grants: what each member of the group may call on this device,
 * grouped by access levels (spec 2026-10-19-member-grants-design § 1).
 */

export type GrantGroup = 'sessions' | 'spawn' | 'settings' | 'manage' | 'ide';

/**
 * Default grants: sessions, spawn, and settings are on; manage and ide are off.
 * A missing group gets its default.
 */
const DEFAULTS: Record<GrantGroup, boolean> = {
  sessions: true,
  spawn: true,
  settings: true,
  manage: false,
  ide: false,
};

export const ALL_GRANT_GROUPS: readonly GrantGroup[] = ['sessions', 'spawn', 'settings', 'manage', 'ide'];

/** Grants for a single member, with defaults applied. */
export type MemberGrants = Record<GrantGroup, boolean>;

/** All members' grants, as stored in remote_grants setting (members without an entry get defaults). */
export type GrantsData = Record<string, Partial<MemberGrants>>;

/**
 * Parse the `remote_grants` setting robustly. A malformed value returns empty
 * object (all members get defaults). Returns a map of memberId → full grants.
 */
export function parseGrants(raw: string | undefined): GrantsData {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw);
    if (typeof data !== 'object' || data === null) return {};
    const result: GrantsData = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof k === 'string' && typeof v === 'object' && v !== null) {
        result[k] = v;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Get the full grants for a member: their stored overrides merged with defaults.
 */
export function getMemberGrants(grants: GrantsData, memberId: string): MemberGrants {
  const stored = grants[memberId] ?? {};
  const pick = (g: GrantGroup) => (typeof stored[g] === 'boolean' ? stored[g] : DEFAULTS[g]);
  return {
    sessions: pick('sessions'), spawn: pick('spawn'), settings: pick('settings'), manage: pick('manage'), ide: pick('ide'),
  };
}

/** A member's refusal (`not_granted`, `member_offline`, `unknown_device`) in words a session can act on; null for any other answer. */
export function memberRefusal(status: number, body: unknown, device: string | null, id: string): string | null {
  const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const name = device ?? id;
  if (status === 403 && b.error === 'not_granted' && typeof b.grant === 'string') {
    return `${name} has not granted this device '${b.grant}'; turn it on there in Settings → Devices`;
  }
  if (status === 409 && b.error === 'member_offline') return `${name} is offline`;
  if (status === 404 && b.error === 'unknown_device') return `No device in the group has id ${id}`;
  return null;
}

/**
 * Check if a member has a specific grant.
 */
export function memberHasGrant(grants: GrantsData, memberId: string, group: GrantGroup): boolean {
  return getMemberGrants(grants, memberId)[group];
}
