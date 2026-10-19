/**
 * Every `orbital` command but the two ceremonies (`flows.ts`), each through
 * the route the web UI uses for the same thing (spec
 * 2026-10-19-headless-server-design § The CLI). Exit codes: 0 done, 1
 * failed or declined where that is a failure, 2 a command line the CLI
 * does not take.
 */
import {
  exitWords, notPrimaryRemoveLine, relayChangeWords, relayLockedLine, removeWords,
} from '@orbital/shared/remote/groupWords';
import { PAIR_NAME_MAX_CHARS } from '@orbital/shared/remote/relayApi';
import {
  SERVER_UPDATE_REFUSALS, parseServerUpdateState, updateIsNewer, type ServerUpdateRefusal, type ServerUpdateState,
} from '@orbital/shared/remote/serverUpdate';
import type { RemoteStatus } from '../remote/service.js';
import { HELP, parseArgs, type Command } from './args.js';
import { CliError, errorOf, type Call } from './client.js';
import { addFlow, joinFlow, readStatus, type Deps } from './flows.js';
import { confirm } from './io.js';
import { listLines, statusLines } from './words.js';

export type CliDeps = Deps & { port: number };

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const cmd = parseArgs(argv);
  if (cmd.kind === 'usage') {
    deps.io.err(cmd.message);
    deps.io.err('Run orbital --help for the commands.');
    return 2;
  }
  return run(cmd, deps);
}

async function run(cmd: Command, deps: CliDeps): Promise<number> {
  const { call, io } = deps;
  switch (cmd.kind) {
    case 'help':
      io.out(HELP);
      return 0;
    case 'status': {
      const remote = await readStatus(call);
      const update = await readUpdate(call);
      for (const line of statusLines(remote, update, deps.port)) io.out(line);
      return 0;
    }
    case 'list':
      for (const line of listLines(await readStatus(call))) io.out(line);
      return 0;
    case 'relay': {
      const remote = await readStatus(call);
      if (remote.relayUrl === '') io.out('No relay is set. Set one: orbital relay set <url>');
      else io.out(`${remote.relayUrl} (${remote.enabled ? remote.relay.replace('_', ' ') : 'remote off'})`);
      return 0;
    }
    case 'relaySet':
      return relaySet(deps, cmd.url, cmd.yes);
    case 'join':
      return joinFlow(deps, cmd.code);
    case 'add':
      return addFlow(deps);
    case 'rename':
      return rename(deps, cmd.name);
    case 'remove':
      return remove(deps, cmd.target, cmd.yes);
    case 'leave':
      return leave(deps, cmd.yes);
    case 'update':
      return update(deps, cmd.yes);
  }
}

/** A relay URL as the CLI takes one: an http(s) or ws(s) URL. */
export function isRelayUrl(url: string): boolean {
  try {
    return ['http:', 'https:', 'ws:', 'wss:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * `relay set <url>`, with the settings page's rules: locked while in a group;
 * with devices paired outside one, they are removed first, after the 9r
 * confirmation. The remote is turned on with it — on a server there is no
 * other switch, and a relay is set to be used.
 */
async function relaySet({ call, io }: CliDeps, url: string, yes: boolean): Promise<number> {
  if (!isRelayUrl(url)) {
    io.err(`That isn't a relay URL: ${url}`);
    return 1;
  }
  const remote = await readStatus(call);
  if (remote.group.relayLocked) {
    io.err(relayLockedLine(remote.group.isPrimary ? 'primary' : 'member'));
    return 1;
  }
  const same = remote.relayUrl.trim() === url;
  if (same && remote.enabled) {
    io.out(`The relay is ${url} already.`);
    return 0;
  }
  if (!same && remote.devices.length > 0) {
    const words = relayChangeWords(remote.devices.length);
    if (!yes && !(await confirm(io, `${words.title} ${words.body}`))) {
      io.out('Nothing changed.');
      return 1;
    }
    // One by one, while this device is still on the old relay, so each revoke reaches it.
    for (const d of remote.devices) await call('DELETE', `/api/remote/devices/${encodeURIComponent(d.id)}`);
  }
  const patch: Record<string, string> = { remote_relay_url: url };
  if (!remote.enabled) patch.remote_enabled = 'true';
  const reply = await call('PATCH', '/api/settings', patch);
  if (reply.status === 409 && errorOf(reply) === 'in_group') {
    io.err(relayLockedLine(remote.group.isPrimary ? 'primary' : 'member'));
    return 1;
  }
  if (reply.status !== 200) throw new CliError(`Orbital answered ${reply.status} to the setting.`);
  io.out(`Relay set: ${url}. orbital status shows when it is online.`);
  return 0;
}

/** `devices rename <name>`: this device's name, the one every member sees (Settings → Devices' THIS DEVICE). */
async function rename({ call, io }: CliDeps, name: string): Promise<number> {
  if (name.length > PAIR_NAME_MAX_CHARS) {
    io.err(`A name is at most ${PAIR_NAME_MAX_CHARS} characters.`);
    return 1;
  }
  const reply = await call('PATCH', '/api/settings', { remote_mac_name: name });
  if (reply.status !== 200) throw new CliError(`Orbital answered ${reply.status} to the setting.`);
  io.out(`This device is ${name} now.`);
  return 0;
}

type Removable = { id: string; name: string; self: boolean };

/**
 * The device `target` names: an id, the start of one, or a name. Members
 * first, then devices paired here outside the group. An ambiguous name is
 * an error that lists the ids.
 */
export function findDevice(remote: Pick<RemoteStatus, 'group' | 'devices'>, target: string): Removable | { error: string } {
  const all: Removable[] = remote.group.members.map((m) => ({ id: m.id, name: m.name, self: m.self }));
  for (const d of remote.devices) if (!all.some((x) => x.id === d.id)) all.push({ id: d.id, name: d.name, self: false });
  const byId = all.filter((x) => x.id === target);
  if (byId.length === 1) return byId[0];
  const byName = all.filter((x) => x.name === target);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    return { error: `More than one device is called ${target}: ${byName.map((x) => x.id).join(', ')}. Name one by its id.` };
  }
  const byPrefix = target.length >= 4 ? all.filter((x) => x.id.startsWith(target)) : [];
  if (byPrefix.length === 1) return byPrefix[0];
  return { error: `No device ${target} here. orbital devices list shows them.` };
}

/** `devices remove <name-or-id>`: the primary's; the row's confirmation, `[y/N]`. */
async function remove({ call, io }: CliDeps, target: string, yes: boolean): Promise<number> {
  const remote = await readStatus(call);
  const found = findDevice(remote, target);
  if ('error' in found) {
    io.err(found.error);
    return 1;
  }
  if (found.self) {
    io.err('That is this device. To leave the group: orbital devices leave');
    return 1;
  }
  const primary = remote.group.primary;
  const member = remote.group.members.some((m) => m.id === found.id);
  if (member && primary && !remote.group.isPrimary) {
    io.err(notPrimaryRemoveLine(primary.name));
    return 1;
  }
  const words = removeWords(found.name);
  if (!yes && !(await confirm(io, `${words.question} ${words.body}`))) {
    io.out('Nothing changed.');
    return 1;
  }
  const reply = await call('DELETE', `/api/remote/devices/${encodeURIComponent(found.id)}`);
  if (reply.status === 200) {
    io.out(`Removed ${found.name}.`);
    return 0;
  }
  const body = reply.body as { error?: string; primary?: { name: string } } | null;
  switch (body?.error) {
    case 'not_primary':
      io.err(notPrimaryRemoveLine(body.primary?.name ?? 'the primary'));
      return 1;
    case 'not_found':
      io.err(`${found.name} is not here any more.`);
      return 1;
    default:
      io.err(`Couldn't remove ${found.name}. Try again.`);
      return 1;
  }
}

/** `devices leave`: Leave on a member, Dissolve on the primary, with that box's confirmation. */
async function leave({ call, io }: CliDeps, yes: boolean): Promise<number> {
  const remote = await readStatus(call);
  const others = remote.group.members.filter((m) => !m.self);
  if (others.length === 0) {
    io.err('This device is not in a group.');
    return 1;
  }
  const exit = remote.group.isPrimary ? 'dissolve' : 'leave';
  const words = exitWords(exit, others.length, remote.group.primary?.name ?? '');
  if (!remote.enabled || remote.relay !== 'online') {
    io.err(words.offline);
    return 1;
  }
  if (!yes && !(await confirm(io, `${words.question} ${words.body}`))) {
    io.out('Nothing changed.');
    return 1;
  }
  const reply = await call('POST', '/api/remote/leave');
  if (reply.status === 200) {
    io.out(exit === 'dissolve' ? 'The group is dissolved.' : 'This device left the group.');
    return 0;
  }
  const error = errorOf(reply);
  io.err(error === 'offline' ? words.offline : words.failed);
  return 1;
}

/** The update state, or null from a server older than the route. */
async function readUpdate(call: Call): Promise<ServerUpdateState | null> {
  const reply = await call('GET', '/api/server/update');
  if (reply.status === 404) return null;
  if (reply.status !== 200) throw new CliError(`Orbital answered ${reply.status} to /api/server/update.`);
  const state = parseServerUpdateState(reply.body);
  if (!state) throw new CliError('Orbital answered the update state in a shape this CLI does not read.');
  return state;
}

/** What each refusal of `POST /api/server/update` means here. */
const UPDATE_REFUSAL_LINES: Record<ServerUpdateRefusal, string> = {
  no_update: 'There is no newer version to install.',
  updating: 'An update is under way already.',
  not_set_up: 'Updates are not set up on this server yet. Run orbital setup.',
  not_packaged: 'This Orbital was not installed from the package; update it the way it was installed.',
};

function isRefusal(error: string | null): error is ServerUpdateRefusal {
  return error !== null && error in SERVER_UPDATE_REFUSALS;
}

/**
 * `update`: the Update button's update, for this device. With sessions
 * working here, it asks first: the restart stops them.
 */
async function update({ call, io }: CliDeps, yes: boolean): Promise<number> {
  const state = await readUpdate(call);
  if (!state) {
    io.err('This Orbital is older than updates from the group; update it the way it was installed.');
    return 1;
  }
  if (!state.packaged) {
    io.err(UPDATE_REFUSAL_LINES.not_packaged);
    return 1;
  }
  if (state.updating) {
    io.out(`Updating to ${state.candidate ?? 'a newer version'} already.`);
    return 0;
  }
  if (state.failed) io.err(`The last update, to ${state.failed}, failed.`);
  if (!updateIsNewer(state.installed, state.candidate)) {
    io.out(`Orbital ${state.installed} is the newest version.`);
    return 0;
  }
  if (state.sessions > 0 && !yes) {
    const n = state.sessions;
    const question = `${n} session${n === 1 ? ' is' : 's are'} working here. The update restarts Orbital and stops ${n === 1 ? 'it' : 'them'}; ${n === 1 ? 'it' : 'they'} can be resumed after. Update to ${state.candidate} now?`;
    if (!(await confirm(io, question))) {
      io.out('Nothing changed.');
      return 1;
    }
  }
  const reply = await call('POST', '/api/server/update');
  if (reply.status === 202) {
    io.out(`Updating ${state.installed} → ${state.candidate}. Orbital restarts on its own; orbital status shows the new version once it is back.`);
    return 0;
  }
  const error = errorOf(reply);
  if (isRefusal(error)) {
    io.err(UPDATE_REFUSAL_LINES[error]);
    return 1;
  }
  throw new CliError(`Orbital answered ${reply.status} to the update.`);
}
