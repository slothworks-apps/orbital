/**
 * What the CLI prints that is its own: the not-running line, the member
 * list, the status and the refusals that have no screen twin. The words it
 * shares with the screens come from `@orbital/shared/remote/groupWords`.
 */
import type { JoinResult, StartPairingResult } from '@orbital/shared/remote/ceremony';
import { osName } from '@orbital/shared/remote/device';
import {
  groupFullLine, notPrimaryAddLine, osLabel, updateAvailableLine, updateFailedLine, updateSessionsStartedLine,
} from '@orbital/shared/remote/groupWords';
import { updateIsNewer, type ServerUpdateState } from '@orbital/shared/remote/serverUpdate';
import { BAD_SECRET_ERROR, NO_RELAY_URL_ERROR } from '../remote/errors.js';
import type { RemoteStatus } from '../remote/service.js';

/** No server on the port: how to start one, where the CLI runs. */
export function notRunningLine(platform: NodeJS.Platform): string {
  return platform === 'linux'
    ? 'Orbital is not running. Start it: systemctl --user start orbital'
    : 'Orbital is not running. Open the Orbital app.';
}

export const NOT_A_CODE = "That isn't a device code.";
export const RELAY_NO_ANSWER = "The relay didn't answer. Try again.";
const JOIN_UNDER_WAY = 'A join is still under way. Cancel it first.';
const RELAY_TOO_OLD = 'The relay needs an update first.';

const NO_RELAY = 'No relay is set. Set one first: orbital relay set <url>';

/** Why the remote did not start (`RemoteStatus.error`), with the command that fixes it where there is one. */
export function remoteErrorLine(error: string): string {
  if (error === BAD_SECRET_ERROR) return 'The relay refused the relay secret. Set the one it expects: orbital relay secret';
  if (error === NO_RELAY_URL_ERROR) return NO_RELAY;
  return `The remote could not start: ${error}`;
}

/** Why the remote cannot pair right now: no relay, the switch off, a failed start, or not connected yet. */
export function remoteDownLine(remote: Pick<RemoteStatus, 'enabled' | 'relayUrl' | 'error' | 'relay'>): string {
  if (remote.relayUrl === '') return NO_RELAY;
  if (!remote.enabled) return 'The remote is off. Turn it on: orbital relay set <url>';
  if (remote.error) return remoteErrorLine(remote.error);
  if (remote.relay === 'too_old') return RELAY_TOO_OLD;
  return 'Not connected to the relay yet. Try again in a moment; orbital status shows it.';
}

/** A refusal of `POST /api/remote/pair`, as `devices add` says it. */
export function startPairingRefusal(res: Extract<StartPairingResult, { error: string }>, remote: RemoteStatus): string {
  switch (res.error) {
    case 'not_primary': return notPrimaryAddLine(res.primary.name);
    case 'joining': return JOIN_UNDER_WAY;
    case 'relay_error': return RELAY_NO_ANSWER;
    case 'relay_too_old': return RELAY_TOO_OLD;
    case 'disabled':
    case 'offline': return remoteDownLine(remote);
  }
}

/** A refusal of `POST /api/remote/join`, as `join` says it; `name` is the device the code came from. */
export function joinRefusal(res: Extract<JoinResult, { error: string }>, name: string, remote: RemoteStatus): string {
  switch (res.error) {
    case 'in_group': return 'This device is already in a group. Leave it first, then join.';
    case 'other_relay': return otherRelayLine(name, res.relay, remote);
    case 'peer_offline': return `${name} is offline. Try again once ${name} is awake.`;
    // The relay does not know the code's token: it was used, or it ran out.
    case 'bad_code': return codeExpiredLine(name);
    case 'already_paired': return `This device is already paired with ${name}.`;
    case 'disabled':
    case 'offline': return remoteDownLine(remote);
    case 'relay_too_old': return RELAY_TOO_OLD;
    case 'relay_error': return RELAY_NO_ANSWER;
    case 'group_full': return groupFullLine(name);
    case 'joining': return JOIN_UNDER_WAY;
    case 'not_primary': return notPrimaryAddLine(res.primary.name);
    case 'phone_to_phone': return 'A phone joins a group through a computer, never another phone.';
  }
}

export function codeExpiredLine(name: string): string {
  return `Code expired. Make a new one on ${name} and run orbital join again.`;
}

/** Canvas 50d B's card, in a line: the code is on another relay than this device. */
export function otherRelayLine(name: string, relay: string, remote: Pick<RemoteStatus, 'relayUrl' | 'group'>): string {
  const here = remote.relayUrl === '' ? 'this device has no relay yet' : `this device is on ${remote.relayUrl}`;
  const fix = remote.group.relayLocked ? 'Leave this group first to change relays.' : `Use it: orbital relay set ${relay}`;
  return `${name} uses another relay: it's on ${relay}; ${here}. Both need the same one. ${fix}`;
}

type Row = { name: string; kind: string; os: string; state: string; version: string; update: string; marks: string };

/** A member's update, as its row's line says it (canvas 50t); empty when there is nothing to say. */
export function updateNote(state: ServerUpdateState | undefined): string {
  if (!state) return '';
  if (state.updating) return `updating to ${state.candidate ?? 'a newer version'}`;
  if (state.failed) return updateFailedLine(state.installed);
  if (updateIsNewer(state.installed, state.candidate)) return updateAvailableLine(state.candidate as string);
  return '';
}

/**
 * `devices list`: one line per member — name, kind, OS (with its version
 * where the member named one), online or offline, version, its update, and
 * PRIMARY / THIS DEVICE — in aligned columns. `updates`: the members whose
 * update state was read (`memberServesUpdate`); the UPDATE column shows
 * only when one of them has something to say. Devices paired here outside
 * the group follow, marked so.
 */
export function listLines(
  remote: Pick<RemoteStatus, 'group' | 'devices' | 'relay'>, updates: ReadonlyMap<string, ServerUpdateState> = new Map(),
): string[] {
  const rows: Row[] = remote.group.members.map((m) => ({
    name: m.name,
    kind: m.kind,
    os: m.osVersion || osLabel(m.os) || '—',
    // This device is on line while its relay is.
    state: m.self ? (remote.relay === 'online' ? 'online' : 'offline') : memberState(m.state, m.tooOld),
    version: updates.get(m.id)?.installed ?? m.version ?? '—',
    update: updateNote(updates.get(m.id)),
    marks: [m.primary ? 'primary' : '', m.self ? 'this device' : ''].filter(Boolean).join(', '),
  }));
  const named = new Set(remote.group.members.map((m) => m.id));
  for (const d of remote.devices) {
    if (named.has(d.id)) continue;
    rows.push({
      name: d.name, kind: d.kind ?? 'desktop', os: osLabel(osName(d.platform)) || '—',
      state: d.online ? 'online' : 'offline', version: '—', update: '', marks: 'paired here, not in the group',
    });
  }
  const head: Row = { name: 'NAME', kind: 'KIND', os: 'OS', state: 'STATE', version: 'VERSION', update: 'UPDATE', marks: '' };
  const all = [head, ...rows];
  const width = (k: keyof Row) => Math.max(...all.map((r) => r[k].length));
  const cols: (keyof Row)[] = ['name', 'kind', 'os', 'state', 'version'];
  if (rows.some((r) => r.update !== '')) cols.push('update');
  const widths = cols.map(width);
  return all.map((r) => [...cols.map((k, i) => r[k].padEnd(widths[i])), r.marks].join('  ').trimEnd());
}

function memberState(state: string, tooOld: boolean): string {
  if (tooOld) return 'too old';
  switch (state) {
    case 'linking': return 'linking';
    case 'notLinked': return 'not linked';
    default: return state;
  }
}

/** `orbital status`: the server, the relay, the group, and who is on line. `update` null: a server without the route. */
export function statusLines(remote: RemoteStatus, update: ServerUpdateState | null, port: number): string[] {
  const self = remote.group.members.find((m) => m.self);
  // A server from before updates from the group names its version nowhere the CLI reads.
  const version = update?.installed ?? self?.version ?? null;
  const lines = [version === null ? `Orbital is running on port ${port}.` : `Orbital ${version} is running on port ${port}.`];
  if (update) {
    if (update.updating) {
      const by = update.startedBy ? `, started on ${update.startedBy.name}` : '';
      lines.push(`Updating to ${update.candidate ?? 'a newer version'}${by}…`);
    }
    else if (updateIsNewer(update.installed, update.candidate)) lines.push(`Update: ${update.candidate} is out. Run orbital update.`);
    if (update.failed) {
      const why = update.failedReason === 'sessions' ? `: ${updateSessionsStartedLine(remote.macName)}` : '.';
      lines.push(`The update to ${update.failed} failed${why}`);
    }
  }
  lines.push(`This device: ${remote.macName}`);
  const relayState = { off: 'off', connecting: 'connecting', online: 'online', too_old: 'too old: it needs an update' }[remote.relay];
  if (remote.relayUrl === '') lines.push('Relay: not set. Set one: orbital relay set <url>');
  else lines.push(`Relay: ${remote.relayUrl} (${remote.enabled ? relayState : 'remote off'})`);
  if (remote.error) lines.push(remoteErrorLine(remote.error));
  const others = remote.group.members.filter((m) => !m.self);
  const primary = remote.group.primary;
  if (others.length === 0) lines.push('Group: none, this device is alone.');
  else if (remote.group.isPrimary) lines.push(`Group: ${others.length + 1} devices, managed here (primary).`);
  else lines.push(`Group: ${others.length + 1} devices, managed by ${primary?.name ?? 'another device'} (primary).`);
  if (others.length > 0) {
    const online = others.filter((m) => m.state === 'online').length;
    lines.push(`Members online: ${online} of ${others.length} others.`);
  }
  if (remote.joining) lines.push(`Joining ${remote.joining.name}: type ${remote.joining.code} on it.`);
  if (remote.group.pendingJoin) lines.push(`Joining: waiting for the group from ${pendingPrimaryName(remote)}.`);
  if (remote.pendingPair) lines.push(`${remote.pendingPair.name} asks to join. Run orbital devices add to answer.`);
  return lines;
}

/** The primary a join waits on, by its paired name; its id's start before the pair is listed. */
export function pendingPrimaryName(remote: Pick<RemoteStatus, 'group' | 'devices'>): string {
  const id = remote.group.pendingJoin?.primary ?? '';
  return remote.devices.find((d) => d.id === id)?.name ?? id.slice(0, 8);
}
