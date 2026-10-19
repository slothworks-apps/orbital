/**
 * The words the group's screens and the `orbital` CLI both say (spec
 * 2026-10-19-headless-server-design § The CLI): a join request, the
 * refusals of a member that is not the primary and of a full group, and the
 * remove, leave and dissolve confirmations. One copy, so the terminal and
 * the dialogs cannot drift apart. Platform-free: the desktop, the phone and
 * the server import it.
 */
import type { GroupManager } from './ceremony.js';
import { osName } from './device.js';

const OS_LABELS: Record<string, string> = {
  macos: 'macOS', linux: 'Linux', ios: 'iOS', android: 'Android',
};

/** An OS as a roster entry names it, worded for people (canvas 50k "WORDING"); unknown passes through as is. */
export function osLabel(os: string): string {
  return OS_LABELS[os] ?? os;
}

/**
 * A member's OS with its version, as its row reads it (canvas 50t, 50s):
 * `macOS 14.6`, `Android 15`. `version` empty gives the OS alone.
 */
export function osVersionText(os: string, version: string): string {
  const label = osLabel(os);
  const v = version.trim();
  return v === '' ? label : `${label} ${v}`;
}

/**
 * `imac-home (desktop, macOS 15.1) wants to join`: the kind a second time,
 * in its own short form — not the tile's fallback-to-desktop word; an
 * unrecognised kind passes through verbatim (canvas 50c `cK.short`).
 * `platform` as the request carried it: a Node platform (`darwin`) or an
 * OS name (`macos`, `android`) both read as the OS.
 */
export function joinSentence(request: { name: string; kind: string; platform: string }): string {
  const os = osLabel(osName(request.platform));
  const kindOs = os === '' ? request.kind : `${request.kind}, ${os}`;
  return `${request.name} (${kindOs}) wants to join`;
}

/** What a join request says under its sentence (canvas 50c): what the device gets once in. */
export const JOIN_REACH = 'Once in, it sees and drives every session on every device in this group.';

/** After a wrong code (canvas 9o C, 50d A): the boxes clear and this line counts what is left. */
export function attemptsLine(attemptsLeft: number): string {
  return `That code didn’t match · ${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} left`;
}

/** A request this device rejected. */
export const REQUEST_REJECTED = 'Request rejected';

/** A request rejected by its last wrong code (`code_rejected`). */
export const CODE_REJECTED = 'Request rejected · three codes didn’t match';

/** `not_primary` to a device asked for a code or a join (canvas 50p I): only `primary` adds. */
export function notPrimaryAddLine(primary: string): string {
  return `${primary} manages this group — add devices there.`;
}

/** `not_primary` to a removal (canvas 50p I): only `primary` removes. */
export function notPrimaryRemoveLine(primary: string): string {
  return `Only ${primary} removes devices from this group.`;
}

/** GROUP FULL's title (canvas 50o). */
export const GROUP_FULL = 'This group can’t take more devices.';

/** GROUP FULL's sentence under the title (canvas 50o): `name` was the device not added. */
export function groupFullBody(name: string): string {
  return `${name} wasn’t added and keeps running on its own. Remove one under In this group, then pair ${name} again.`;
}

/** GROUP FULL as one line, where a join answered it (canvas 50o's words). */
export function groupFullLine(name: string): string {
  return `${GROUP_FULL} Remove one under In this group, then pair ${name} again.`;
}

/** Remove's confirmation on a member's row (canvas 50a ROWS). */
export function removeWords(name: string): { question: string; body: string } {
  return {
    question: `Remove ${name}?`,
    body: 'It drops out of every device in the group now and has to be paired again from here.',
  };
}

/**
 * Dissolve on the primary, Leave on a member (canvas 50a, 50l `leave*`, 50p
 * F–H): the box's words, and its confirmation's. `count`: the other members;
 * `primary`: the primary's name.
 */
export function exitWords(exit: 'dissolve' | 'leave', count: number, primary: string) {
  if (exit === 'dissolve') {
    return {
      title: 'Dissolve this group',
      sub: 'Sessions on every device keep running.',
      button: 'Dissolve…',
      question: 'Dissolve the group?',
      body: count === 1
        ? 'The other device becomes standalone and its pair with this one ends. To form a new group, pair devices again from here.'
        : `All ${count} other devices become standalone and every pair between them ends. To form a new group, pair devices again from here.`,
      go: 'Dissolve',
      offline: 'Connect to the relay to dissolve the group — the others have to hear it.',
      failed: "Couldn't dissolve the group. Try again.",
    };
  }
  return {
    title: 'Leave this group',
    sub: 'Sessions here keep running.',
    button: 'Leave…',
    question: 'Leave the group?',
    // With one other device, that device is the primary (canvas 50p H).
    body: count === 1
      ? `This device becomes standalone and forgets ${primary}. To join again, pair it with ${primary}.`
      : `This device becomes standalone and forgets the other ${count}. To join again, pair it with ${primary}.`,
    go: 'Leave',
    offline: 'Connect to the relay to leave — the others have to hear it.',
    failed: "Couldn't leave the group. Try again.",
  };
}

/**
 * The confirm before an update stops sessions (canvas 50t CONFIRM, 50s
 * sheet), with the local Restart's three choices after it: `3 sessions are
 * running on nuc.` then `Update now stops them when it restarts.` `name` is
 * the member being updated, as its row names it. `shown`: the count the
 * confirm named before, when more run there now (50t CONFIRM · MORE
 * SESSIONS STARTED): `4 sessions are running on nuc now.` then how many
 * started since.
 */
export function updateSessionsWords(count: number, name: string, shown?: number): { question: string; body: string } {
  if (shown !== undefined && count > shown) {
    return {
      question: `${count} sessions are running on ${name} now.`,
      body: `${count - shown} started since you pressed Update. Update now stops them when it restarts.`,
    };
  }
  return {
    question: `${count} session${count === 1 ? ' is' : 's are'} running on ${name}.`,
    body: `Update now stops ${count === 1 ? 'it' : 'them'} when it restarts.`,
  };
}

/** The confirm's three choices (canvas 50q, 50s): the safe one, the one that stops sessions, and none. */
export const UPDATE_WHEN_IDLE = 'Update when sessions finish';
export const UPDATE_NOW = 'Update now';

/** `2 sessions`, `1 session`. */
function sessionCount(n: number): string {
  return `${n} session${n === 1 ? '' : 's'}`;
}

/**
 * A member whose update waits for its sessions to finish (canvas 50t
 * WAITING FOR SESSIONS TO FINISH, 50s): `line` under its row on the desktop,
 * `head` heading the phone's sheet, `phoneState` the phone row's state
 * words. `sessions` is the live count there, `target` the version it then
 * installs. The CLI says the same.
 */
export function updateWaitingWords(sessions: number, target: string): { line: string; head: string; phoneState: string } {
  return {
    line: `waiting for ${sessionCount(sessions)} to finish · then ${target}`,
    head: `Waiting for ${sessionCount(sessions)} to finish · then ${target}`,
    phoneState: `online · waiting for ${sessionCount(sessions)}`,
  };
}

/** The phone sheet's button while a member waits (canvas 50s `pBtn`). */
export const CANCEL_THE_UPDATE = 'Cancel the update';

/** Canvas 50a `relayLock`, 50p C: in a group the relay cannot change, and this says how it can again. */
export function relayLockedLine(role: 'primary' | 'member'): string {
  return role === 'member'
    ? 'One relay for the whole group. Leave the group to change it.'
    : 'One relay for the whole group. Remove the other devices, or dissolve the group, to change it.';
}

/** `1 device`, `3 devices`. */
export function deviceCount(n: number): string {
  return n === 1 ? '1 device' : `${n} devices`;
}

/**
 * The 9r confirm before a new relay URL, or a new relay secret, removes the
 * paired devices. The secret's words are provisional: the canvas draws no
 * such dialog yet.
 */
export function relayChangeWords(count: number, setting: 'url' | 'secret' = 'url'): { title: string; body: string } {
  const have = count === 1 ? 'has' : 'have';
  return setting === 'url'
    ? { title: 'Change the relay?', body: `${deviceCount(count)} will be removed and ${have} to pair again on the new relay.` }
    : { title: 'Change the relay secret?', body: `${deviceCount(count)} will be removed and ${have} to pair again with the new secret.` };
}

/**
 * What a pairing says about who will manage the group (canvas 50b, 50c,
 * 50i; `GroupManager`), each line only where it is true. `eyebrow`: the
 * request's header — `NEW GROUP` while the pairing founds the group.
 * `line`: the boxed line of the request, and the joining card's line. `done`:
 * what the request's joined screen says once the device is in, or null for
 * the screen's own default. A pairing by hand says none of it.
 */
export interface ManagerWords {
  eyebrow: string;
  line: string | null;
  done: string | null;
}

export function managerWords(manager: GroupManager, name: string): ManagerWords {
  const eyebrow = manager?.newGroup ? 'JOIN REQUEST · NEW GROUP' : 'JOIN REQUEST';
  if (!manager) return { eyebrow, line: null, done: null };
  if (manager.by === 'there') {
    return {
      eyebrow,
      line: manager.newGroup
        ? `${name} will manage the group: devices are added and removed there.`
        : `${name} manages the group: devices are added and removed there.`,
      done: `${name} manages the group: add more devices there.`,
    };
  }
  // This device already manages the group it adds to: nothing about the role is new.
  if (!manager.newGroup) return { eyebrow, line: null, done: null };
  return {
    eyebrow,
    line: 'This device will manage the group: devices are added and removed here.',
    done: 'A group of two now, managed here. Add more devices from Devices → Add a device.',
  };
}

/** A member with a newer release, on its row's line (canvas 50q, 50t) and in the CLI's UPDATE column. */
export function updateAvailableLine(candidate: string): string {
  return `update available · ${candidate}`;
}

/** A member whose update ended without the new version, on its row's line (canvas 50t FAILED) and in the CLI. */
export function updateFailedLine(installed: string): string {
  return `update didn’t finish · still on ${installed}`;
}

/**
 * A Mac that did not install the update a member asked for, because a
 * session started working on it while it downloaded (`failedReason:
 * 'sessions'`; canvas 50t FAILED · A SESSION STARTED THERE, 50v 04): the
 * update waits there, downloaded, and restarting it is that Mac's choice
 * now. `line` and `sub` under its row on the desktop, `head` heads the
 * phone's sheet, `phoneState` is the phone row's state words. The CLI says
 * the same.
 */
export function updateWaitsWords(name: string): { line: string; sub: string; head: string; phoneState: string } {
  return {
    line: `didn’t install · a session started working on ${name}`,
    sub: `it’s downloaded there · restart it on ${name}`,
    head: `Didn’t install · a session started working on ${name}`,
    phoneState: `online · update waits on ${name}`,
  };
}

/**
 * A Mac that could not tell which of its sessions worked as the download
 * landed (`failedReason: 'unknown'`; canvas 50t COULDN’T CHECK FOR
 * SESSIONS), and so did not install: `line` and `sub` under its row, `head`
 * heading the phone's sheet, with Try again. The CLI says the same.
 */
export function updateNoCountWords(name: string): { line: string; sub: string; head: string } {
  return {
    line: `couldn’t check for sessions on ${name}`,
    sub: 'nothing was started',
    head: `Couldn’t check for sessions on ${name}`,
  };
}
