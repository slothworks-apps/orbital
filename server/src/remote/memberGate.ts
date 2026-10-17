/**
 * Whether a member is too old to take part in the group (spec
 * 2026-10-16-device-group-design § 8), read from the last hello it sent.
 */
import type { HelloMessage } from '@orbital/shared/remote/messages';

/**
 * A device that is not a phone and whose hello names no `group`
 * capability: a Mac from before groups, paired through a code. A phone is
 * never judged here (its app version is, at hello), and a member not heard
 * from yet cannot be told.
 */
export function memberTooOld(kind: string | null, hello: HelloMessage | null): boolean {
  if (kind === 'phone' || hello === null) return false;
  return hello.capabilities?.includes('group') !== true;
}
