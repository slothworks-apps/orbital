/**
 * Every `orbital` command but the two ceremonies (`flows.ts`), each through
 * the route the web UI uses for the same thing (spec
 * 2026-10-19-headless-server-design § The CLI). Exit codes: 0 done, 1
 * failed or declined where that is a failure, 2 a command line the CLI
 * does not take.
 */
import {
  exitWords, notPrimaryRemoveLine, relayChangeWords, relayLockedLine, removeWords, updateSessionsWords,
} from '@orbital/shared/remote/groupWords';
import { PAIR_NAME_MAX_CHARS } from '@orbital/shared/remote/relayApi';
import { relaySecretCommit, relayUrlCommit } from '@orbital/shared/remote/relaySettings';
import {
  SERVER_UPDATE_REFUSALS, memberServesUpdate, parseServerUpdateState, updateIsNewer, type ServerUpdateRefusal,
  type ServerUpdateState,
} from '@orbital/shared/remote/serverUpdate';
import type { RemoteStatus } from '../remote/service.js';
import { HELP, parseArgs, type Command, type SecretSource } from './args.js';
import { CliError, errorOf, type Call, type Reply } from './client.js';
import { addFlow, joinFlow, readStatus, type Deps } from './flows.js';
import { confirm, type Io } from './io.js';
import { listLines, remoteErrorLine, statusLines } from './words.js';

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
    case 'setup':
      // It runs before there is a server to call: main.ts starts it on its own.
      throw new CliError('orbital setup does not run through the server.');
    case 'status': {
      const remote = await readStatus(call);
      const update = await readUpdate(call);
      for (const line of statusLines(remote, update, deps.port)) io.out(line);
      return 0;
    }
    case 'list': {
      const remote = await readStatus(call);
      for (const line of listLines(remote, await readMemberUpdates(call, remote))) io.out(line);
      return 0;
    }
    case 'relay': {
      const remote = await readStatus(call);
      const saved = await readRelaySettings(call);
      if (remote.relayUrl === '') io.out('No relay is set. Set one: orbital relay set <url>');
      else io.out(`${remote.relayUrl} (${remote.enabled ? remote.relay.replace('_', ' ') : 'remote off'})`);
      io.out(`secret: ${saved.secret === '' ? 'not set' : 'set'}`);
      if (remote.error) io.err(remoteErrorLine(remote.error));
      return 0;
    }
    case 'relaySet':
      return relaySet(deps, cmd.url, cmd.secret, cmd.yes);
    case 'relaySecret':
      return relaySecret(deps, cmd.secret, cmd.yes);
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
      return update(deps, cmd.target, cmd.yes);
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

/** The relay settings as saved: the URL, and the secret (never printed). */
async function readRelaySettings(call: Call): Promise<{ url: string; secret: string }> {
  const reply = await call('GET', '/api/settings');
  if (reply.status !== 200) throw new CliError(`Orbital answered ${reply.status} to /api/settings.`);
  const body = reply.body as Record<string, string | undefined>;
  return { url: (body.remote_relay_url ?? '').trim(), secret: (body.remote_relay_secret ?? '').trim() };
}

/** The secret from where the command line said; null when none came. */
async function readSecret(io: Io, source: SecretSource): Promise<string | null> {
  const typed = source === 'prompt' ? await io.askSecret('Relay secret (not shown): ') : await io.ask('');
  return typeof typed === 'string' && typed !== '' ? typed : null;
}

/**
 * Saves relay settings with the settings page's rules (Change relay, 9r):
 * locked while in a group; with devices paired outside one, a change that
 * strands them asks first and removes them — but clearing the secret strands
 * no one (`relaySecretCommit`). `ask` names the setting whose words the
 * confirmation uses.
 */
async function saveRelay(
  { call, io }: CliDeps, remote: RemoteStatus, patch: Record<string, string>, ask: 'url' | 'secret' | null, yes: boolean,
): Promise<number> {
  if (ask !== null && remote.devices.length > 0) {
    const words = relayChangeWords(remote.devices.length, ask);
    if (!yes && !(await confirm(io, `${words.title} ${words.body}`))) {
      io.out('Nothing changed.');
      return 1;
    }
    // One by one, while this device is still on the old relay, so each revoke reaches it.
    for (const d of remote.devices) await call('DELETE', `/api/remote/devices/${encodeURIComponent(d.id)}`);
  }
  // The route restarts the remote on any change of these, so the relay is asked again with them.
  const reply = await call('PATCH', '/api/settings', patch);
  if (reply.status === 409 && errorOf(reply) === 'in_group') {
    io.err(relayLockedLine(remote.group.isPrimary ? 'primary' : 'member'));
    return 1;
  }
  if (reply.status !== 200) throw new CliError(`Orbital answered ${reply.status} to the setting.`);
  return 0;
}

/**
 * `relay set <url> [--secret | --secret-stdin]`. The remote is turned on
 * with it — on a server there is no other switch, and a relay is set to be
 * used.
 */
async function relaySet(deps: CliDeps, url: string, source: 'keep' | SecretSource, yes: boolean): Promise<number> {
  const { call, io } = deps;
  if (!isRelayUrl(url)) {
    io.err(`That isn't a relay URL: ${url}`);
    return 1;
  }
  const remote = await readStatus(call);
  if (remote.group.relayLocked) {
    io.err(relayLockedLine(remote.group.isPrimary ? 'primary' : 'member'));
    return 1;
  }
  const secret = source === 'keep' ? null : await readSecret(io, source);
  if (source !== 'keep' && secret === null) {
    io.err('No secret given. To remove the secret: orbital relay secret --clear');
    return 1;
  }
  const saved = await readRelaySettings(call);
  const paired = remote.devices.length;
  const urlCommit = relayUrlCommit(saved.url, url, paired);
  const secretCommit = secret === null ? 'none' : relaySecretCommit(saved.secret, secret, paired);
  const secretChanged = secretCommit !== 'none';
  if (urlCommit === 'none' && !secretChanged && remote.enabled) {
    io.out(`The relay is ${url} already.`);
    return 0;
  }
  const patch: Record<string, string> = { remote_relay_url: url };
  if (secretChanged) patch.remote_relay_secret = secret as string;
  if (!remote.enabled) patch.remote_enabled = 'true';
  const ask = urlCommit === 'ask' ? 'url' : secretCommit === 'ask' ? 'secret' : null;
  const code = await saveRelay(deps, remote, patch, ask, yes);
  if (code !== 0) return code;
  io.out(`Relay set: ${url}${secretChanged ? ', with its secret' : ''}. orbital status shows when it is online.`);
  return 0;
}

/** `relay secret [--secret-stdin | --clear]`: the secret alone, with the URL's lock rules. */
async function relaySecret(deps: CliDeps, source: SecretSource | 'clear', yes: boolean): Promise<number> {
  const { call, io } = deps;
  const remote = await readStatus(call);
  if (remote.group.relayLocked) {
    io.err(relayLockedLine(remote.group.isPrimary ? 'primary' : 'member'));
    return 1;
  }
  const secret = source === 'clear' ? '' : await readSecret(io, source);
  if (secret === null) {
    io.err('No secret given. To remove the secret: orbital relay secret --clear');
    return 1;
  }
  const saved = await readRelaySettings(call);
  const commit = relaySecretCommit(saved.secret, secret, remote.devices.length);
  if (commit === 'none') {
    io.out(secret === '' ? 'No relay secret is set.' : 'The relay secret is that already.');
    return 0;
  }
  const code = await saveRelay(deps, remote, { remote_relay_secret: secret }, commit === 'ask' ? 'secret' : null, yes);
  if (code !== 0) return code;
  io.out(secret === '' ? 'Relay secret removed.' : 'Relay secret set.');
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

/** Where an update goes: this device (`machine` null), or a member through this one (`?machine=`). */
export type UpdateTarget = { machine: string | null; name: string };

/**
 * Where `orbital update [name]` goes (the desktop's `startMemberUpdate`
 * gate, spec 2026-10-19-headless-server-design § Updating from the group):
 * no name, or this device's own, is this device; another member is asked
 * through this server, but never a phone (its store updates it), a member
 * that is not online, or one whose version does not serve the route.
 */
export function updateTarget(remote: Pick<RemoteStatus, 'group' | 'macName'>, name: string | null): UpdateTarget | { error: string } {
  if (name === null) return { machine: null, name: remote.macName };
  const found = findDevice({ group: remote.group, devices: [] }, name);
  if ('error' in found) return found;
  const m = remote.group.members.find((x) => x.id === found.id);
  if (!m || m.self) return { machine: null, name: remote.macName };
  if (m.kind === 'phone') return { error: `${m.name} is a phone: it updates from its store, not from here.` };
  if (m.state !== 'online') return { error: `${m.name} is ${m.state === 'offline' ? 'offline' : 'not reachable from here'}. Update it once it is online.` };
  if (m.tooOld || !memberServesUpdate(m)) {
    return { error: `${m.name} runs ${m.version ? `Orbital ${m.version}` : 'an Orbital'} that can't be updated from the group. Update it on ${m.name} itself.` };
  }
  return { machine: m.id, name: m.name };
}

/** `path` asked of `machine`, or of this device for null. */
function onMachine(path: string, machine: string | null): string {
  return machine === null ? path : `${path}?machine=${encodeURIComponent(machine)}`;
}

/** Why a member could not be asked (the federation's refusals), in one line; null for an answer of the member's own. */
function memberDownLine(reply: Reply, target: UpdateTarget): string | null {
  if (target.machine === null) return null;
  switch (errorOf(reply)) {
    case 'member_offline': return `${target.name} is offline. Update it once it is online.`;
    case 'unknown_device': return `${target.name} is not in this group any more.`;
    case 'member_unreachable':
    case 'member_refused': return `${target.name} didn't answer. Try again in a moment.`;
    default: return reply.status >= 500 ? `${target.name} didn't answer. Try again in a moment.` : null;
  }
}

/** The update state of `target`, or null from a server older than the route. */
async function readUpdate(call: Call, target: UpdateTarget = { machine: null, name: '' }): Promise<ServerUpdateState | null> {
  const reply = await call('GET', onMachine('/api/server/update', target.machine));
  if (reply.status === 404 && errorOf(reply) !== 'unknown_device') return null;
  const down = reply.status === 200 ? null : memberDownLine(reply, target);
  if (down) throw new CliError(down);
  if (reply.status !== 200) throw new CliError(`Orbital answered ${reply.status} to /api/server/update.`);
  const state = parseServerUpdateState(reply.body);
  if (!state) throw new CliError('Orbital answered the update state in a shape this CLI does not read.');
  return state;
}

/** What each refusal of `POST /api/server/update` means; `name` for a member, null for this device. */
function updateRefusalLine(error: ServerUpdateRefusal, name: string | null): string {
  switch (error) {
    case 'no_update': return 'There is no newer version to install.';
    case 'updating': return 'An update is under way already.';
    case 'not_set_up': return name === null
      ? 'Updates are not set up on this server yet. Run orbital setup.'
      : `Updates are not set up on ${name} yet. Run orbital setup there.`;
    case 'not_packaged': return name === null
      ? 'This Orbital was not installed from the package; update it the way it was installed.'
      : `${name} was not installed from the package; update it the way it was installed.`;
  }
}

function isRefusal(error: string | null): error is ServerUpdateRefusal {
  return error !== null && error in SERVER_UPDATE_REFUSALS;
}

/**
 * `update [name]`: the Update button's update, for this device or the
 * member named. With sessions running there, it asks first in the row's
 * words: the restart stops them.
 */
async function update({ call, io }: CliDeps, name: string | null, yes: boolean): Promise<number> {
  const target = updateTarget(await readStatus(call), name);
  if ('error' in target) {
    io.err(target.error);
    return 1;
  }
  const member = target.machine === null ? null : target.name;
  const state = await readUpdate(call, target);
  if (!state) {
    io.err(member === null
      ? 'This Orbital is older than updates from the group; update it the way it was installed.'
      : `${member} is older than updates from the group; update it on ${member} itself.`);
    return 1;
  }
  if (!state.packaged) {
    io.err(updateRefusalLine('not_packaged', member));
    return 1;
  }
  if (state.updating) {
    io.out(`${member === null ? 'Updating' : `${member} is updating`} to ${state.candidate ?? 'a newer version'} already.`);
    return 0;
  }
  if (state.failed) io.err(`The last update${member === null ? '' : ` of ${member}`}, to ${state.failed}, failed.`);
  if (!updateIsNewer(state.installed, state.candidate)) {
    io.out(member === null
      ? `Orbital ${state.installed} is the newest version.`
      : `${member} runs ${state.installed}, the newest version.`);
    return 0;
  }
  if (state.sessions > 0 && !yes) {
    const words = updateSessionsWords(state.sessions, target.name);
    if (!(await confirm(io, `${words.question} ${words.body} Update ${target.name}?`))) {
      io.out('Nothing changed.');
      return 1;
    }
  }
  const reply = await call('POST', onMachine('/api/server/update', target.machine));
  if (reply.status === 202) {
    io.out(member === null
      ? `Updating ${state.installed} → ${state.candidate}. Orbital restarts on its own; orbital status shows the new version once it is back.`
      : `Updating ${member} ${state.installed} → ${state.candidate}. It restarts on its own; orbital devices list shows the new version once it is back.`);
    return 0;
  }
  const error = errorOf(reply);
  if (isRefusal(error)) {
    io.err(updateRefusalLine(error, member));
    return 1;
  }
  const down = memberDownLine(reply, target);
  if (down) {
    io.err(down);
    return 1;
  }
  throw new CliError(`Orbital answered ${reply.status} to the update.`);
}

/**
 * Every member's update state for `devices list`, through the same gate as
 * `update` and the desktop's rows: this device, and each other member that
 * is online and serves the route. A member that cannot be read is left out.
 */
async function readMemberUpdates(call: Call, remote: RemoteStatus): Promise<Map<string, ServerUpdateState>> {
  const out = new Map<string, ServerUpdateState>();
  await Promise.all(remote.group.members.map(async (m) => {
    if (!memberServesUpdate(m) || (!m.self && (m.state !== 'online' || m.tooOld))) return;
    try {
      const state = await readUpdate(call, { machine: m.self ? null : m.id, name: m.name });
      if (state) out.set(m.id, state);
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
    }
  }));
  return out;
}
