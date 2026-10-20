import type { MachineRef } from '@orbital/shared/remote/device'
import type { ClaudeDirLimits } from '../../lib/types'

/**
 * The phone's plan limits across its group (spec 2026-10-20-limit-suns-design
 * § 1, § 5). There is no main Mac: every member is asked for its own
 * directories, and the answers are laid side by side, each directory tagged
 * with the member it is on, so `groupLimitsByAccount` keys a directory of
 * unknown account per device. The phone's half of the server's `memberDirs`.
 */

/** What the phone keeps of one member's limits: its own directories as it last sent them. */
export interface MemberLimits {
  machine: MachineRef
  /** As the member sent them; anything that does not read as a directory is left out on the way out. */
  dirs: readonly unknown[]
  /** The last read of this member failed; what is kept is the one before it. */
  failed: boolean
}

/**
 * The member's own directories from an answer or a frame: a directory the
 * member itself carries as another's is left out (no chaining), and so is
 * anything that is not a list.
 */
export function ownLimitDirs(dirs: unknown): unknown[] | null {
  if (!Array.isArray(dirs)) return null
  return dirs.filter((d) => isObject(d) && (d.machine === undefined || d.machine === null))
}

/**
 * One member's directories as the phone shows them: each tagged with the
 * member's `machine`, and stale while the member is offline or its last read
 * failed. The windows and their estimates stay as they came; a stale reading
 * hides its estimate where it is drawn (`estimateLine`).
 */
export function memberLimitDirs({ machine, dirs, failed }: MemberLimits): ClaudeDirLimits[] {
  const out: ClaudeDirLimits[] = []
  for (const raw of dirs) {
    if (!isObject(raw) || typeof raw.id !== 'number') continue
    if (raw.machine !== undefined && raw.machine !== null) continue
    const d = raw as Partial<ClaudeDirLimits>
    out.push({
      id: d.id as number,
      name: typeof d.name === 'string' ? d.name : '',
      // An older Mac sends neither: the directory is its own group, its plan unknown.
      account: typeof d.account === 'string' && d.account ? d.account.toLowerCase() : null,
      plan: typeof d.plan === 'string' && d.plan ? d.plan : null,
      machine,
      tracked: d.tracked !== false,
      readAt: typeof d.readAt === 'string' ? d.readAt : null,
      stale: d.stale === true || failed || !machine.online,
      windows: Array.isArray(d.windows) ? d.windows : [],
      extraUsage: d.extraUsage ?? null,
      waits: Array.isArray(d.waits) ? d.waits : [],
    })
  }
  return out
}

/** Every member's directories, in the members' order. */
export function mergeMemberLimits(members: readonly MemberLimits[]): ClaudeDirLimits[] {
  return members.flatMap(memberLimitDirs)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
