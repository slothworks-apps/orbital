/**
 * The group's roster (spec 2026-10-16-device-group-design § 2): every member
 * keeps all of it and they converge on it by merging. The merge picks one
 * whole entry per id, by an order every member computes the same way, so two
 * members that saw the same entries hold the same roster and the same digest.
 * No I/O: the server stores it, the channel carries it.
 */
import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** The most members a roster carries; one channel frame holds them with room to spare. */
export const ROSTER_MAX_ENTRIES = 256;

export const RosterEntrySchema = z.object({
  id: z.string().max(64),
  kind: z.string().max(20),
  name: z.string().max(80),
  os: z.string().max(20),
  /** The device links with other members: its hello named the `group` capability. */
  links: z.boolean(),
  epoch: z.number().int().nonnegative(),
  addedBy: z.string().max(64),
  addedAt: z.number(),
  describedAt: z.number(),
  removedBy: z.string().max(64).optional(),
  removedAt: z.number().optional(),
});
export type RosterEntry = z.infer<typeof RosterEntrySchema>;
export const RosterSchema = z.array(RosterEntrySchema).max(ROSTER_MAX_ENTRIES);

export function isLive(e: RosterEntry): boolean {
  return e.removedAt === undefined;
}

/** The keys in a fixed order, so the same entry always reads the same. */
function canonical(e: RosterEntry): string {
  return JSON.stringify([
    e.id, e.kind, e.name, e.os, e.links, e.epoch, e.addedBy, e.addedAt, e.describedAt,
    e.removedBy ?? null, e.removedAt ?? null,
  ]);
}

/** The entry that stands for an id: higher epoch, then removed, then later described, then the larger canonical form. */
export function winner(a: RosterEntry, b: RosterEntry): RosterEntry {
  if (a.epoch !== b.epoch) return a.epoch > b.epoch ? a : b;
  if (isLive(a) !== isLive(b)) return isLive(a) ? b : a;
  if (a.describedAt !== b.describedAt) return a.describedAt > b.describedAt ? a : b;
  return canonical(a) >= canonical(b) ? a : b;
}

export function mergeRosters(a: RosterEntry[], b: RosterEntry[]): RosterEntry[] {
  const byId = new Map<string, RosterEntry>();
  for (const e of [...a, ...b]) {
    const known = byId.get(e.id);
    byId.set(e.id, known ? winner(known, e) : e);
  }
  return [...byId.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

export function rosterDigest(entries: RosterEntry[]): string {
  const sorted = [...entries].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return bytesToHex(sha256(new TextEncoder().encode(sorted.map(canonical).join('\n'))));
}

/** A newcomer, or a removed device paired again: the next epoch after any entry known for it. */
export function addMember(
  roster: RosterEntry[], entry: Omit<RosterEntry, 'epoch' | 'removedBy' | 'removedAt'>,
): RosterEntry[] {
  const known = roster.find((e) => e.id === entry.id);
  const epoch = known ? known.epoch + 1 : 1;
  return mergeRosters(roster.filter((e) => e.id !== entry.id), [{ ...entry, epoch }]);
}

/** Marks a live member removed, at its current epoch; unchanged when unknown or already removed. */
export function removeMember(roster: RosterEntry[], id: string, by: string, now: number): RosterEntry[] {
  const known = roster.find((e) => e.id === id);
  if (!known || !isLive(known)) return roster;
  return roster.map((e) => (e.id === id ? { ...e, removedBy: by, removedAt: now } : e));
}

/** What a member says about a device; the same array back when nothing changes, so callers can tell. */
export function describeMember(
  roster: RosterEntry[], id: string, patch: Partial<Pick<RosterEntry, 'name' | 'os' | 'links' | 'kind'>>, now: number,
): RosterEntry[] {
  const known = roster.find((e) => e.id === id);
  if (!known) return roster;
  const changed = (Object.keys(patch) as (keyof typeof patch)[]).some((k) => patch[k] !== undefined && patch[k] !== known[k]);
  if (!changed) return roster;
  return roster.map((e) => (e.id === id ? { ...e, ...patch, describedAt: now } : e));
}
