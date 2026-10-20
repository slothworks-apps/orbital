/**
 * The `orbital` command line (spec 2026-10-19-headless-server-design § The
 * CLI table), parsed by hand: a handful of commands, one flag.
 */

export type Command =
  | { kind: 'help' }
  | { kind: 'setup' }
  | { kind: 'status' }
  | { kind: 'relay' }
  | { kind: 'relaySet'; url: string; secret: 'keep' | SecretSource; yes: boolean }
  | { kind: 'relaySecret'; secret: SecretSource | 'clear'; yes: boolean }
  | { kind: 'join'; code: string | null }
  | { kind: 'add' }
  | { kind: 'list' }
  | { kind: 'rename'; name: string }
  | { kind: 'remove'; target: string; yes: boolean }
  | { kind: 'leave'; yes: boolean }
  | { kind: 'update'; target: string | null; yes: boolean; when: 'now' | 'idle' }
  | { kind: 'updateCancel'; target: string | null };

/**
 * Where a relay secret comes from: typed at a prompt that does not echo it,
 * or one line of stdin for scripts. Never an argument: the process list
 * shows those to every user.
 */
export type SecretSource = 'prompt' | 'stdin';

/** A command line that names no command the CLI has: printed with a pointer to `--help`, exit 2. */
export type Usage = { kind: 'usage'; message: string };

export const HELP = `orbital — drive the Orbital server on this machine

Usage:
  orbital setup                       set this machine up once after installing (asks for sudo)
  orbital status                      the server, its version, relay and group
  orbital relay                       show the relay
  orbital relay set <url> [--secret]  set the relay (before pairing), and its secret
  orbital relay secret [--clear]      set, change or remove the relay secret
  orbital join [code]                 join the group whose primary shows the code
  orbital devices add                 show a code another device joins with
  orbital devices list                the group's members
  orbital devices rename <name>       rename this device
  orbital devices remove <name|id>    remove a member (on the primary)
  orbital devices leave               leave the group (on the primary: dissolve it)
  orbital update [name]               update this server, or the member named, when a newer version is out
  orbital update --cancel [name]      cancel an update waiting for sessions to finish
  orbital help                        this text

Options:
  -y, --yes        skip the confirmation (relay, remove, leave, update): update now
  --when-idle      update once no session there is working or waiting for you (update)
  --cancel         cancel an update waiting for sessions to finish (update)
  --secret         ask for the relay secret, not echoed (relay set)
  --secret-stdin   read the relay secret from one line of stdin (relay set, relay secret)
  --clear          remove the relay secret (relay secret)
  -h, --help       this text

It talks to the server on 127.0.0.1 with the token in its data dir: on the port in
$ORBITAL_PORT, else the one the orbital user unit sets, else the default.`;

/** Commands that ask before they act, and so take `--yes`. */
const CONFIRMS: ReadonlySet<Command['kind']> = new Set(['relaySet', 'relaySecret', 'remove', 'leave', 'update']);

type Flags = { yes: boolean; secret: boolean; secretStdin: boolean; clear: boolean; whenIdle: boolean; cancel: boolean };

export function parseArgs(argv: readonly string[]): Command | Usage {
  const words: string[] = [];
  const flags: Flags = { yes: false, secret: false, secretStdin: false, clear: false, whenIdle: false, cancel: false };
  let help = false;
  let rest = false;
  for (const arg of argv) {
    if (rest || !arg.startsWith('-') || arg === '-') words.push(arg);
    else if (arg === '--') rest = true;
    else if (arg === '-y' || arg === '--yes') flags.yes = true;
    else if (arg === '-h' || arg === '--help') help = true;
    else if (arg === '--secret') flags.secret = true;
    else if (arg === '--secret-stdin') flags.secretStdin = true;
    else if (arg === '--clear') flags.clear = true;
    else if (arg === '--when-idle') flags.whenIdle = true;
    else if (arg === '--cancel') flags.cancel = true;
    else if (arg.startsWith('--secret=')) return { kind: 'usage', message: 'The secret is never an argument: use --secret, or --secret-stdin.' };
    else return { kind: 'usage', message: `Unknown option: ${arg}` };
  }
  if (help) return { kind: 'help' };
  const cmd = command(words, flags);
  if (cmd.kind === 'usage') return cmd;
  if (flags.yes && !CONFIRMS.has(cmd.kind)) return { kind: 'usage', message: '--yes does nothing for this command.' };
  if ([flags.secret, flags.secretStdin, flags.clear].filter(Boolean).length > 1) {
    return { kind: 'usage', message: 'Use one of --secret, --secret-stdin and --clear.' };
  }
  if (flags.secret && cmd.kind !== 'relaySet') return { kind: 'usage', message: '--secret is for orbital relay set.' };
  if (flags.clear && cmd.kind !== 'relaySecret') return { kind: 'usage', message: '--clear is for orbital relay secret.' };
  if (flags.secretStdin && cmd.kind !== 'relaySet' && cmd.kind !== 'relaySecret') {
    return { kind: 'usage', message: '--secret-stdin is for orbital relay set and orbital relay secret.' };
  }
  if ((flags.whenIdle || flags.cancel) && cmd.kind !== 'update' && cmd.kind !== 'updateCancel') {
    return { kind: 'usage', message: `${flags.cancel ? '--cancel' : '--when-idle'} is for orbital update.` };
  }
  if (cmd.kind === 'updateCancel' && flags.whenIdle) return { kind: 'usage', message: 'Use one of --cancel and --when-idle.' };
  return cmd;
}

function command(words: string[], flags: Flags): Command | Usage {
  const { yes } = flags;
  const [head, ...args] = words;
  switch (head) {
    case undefined:
    case 'help':
      return args.length === 0 ? { kind: 'help' } : extra(args);
    case 'setup':
      return args.length === 0 ? { kind: 'setup' } : extra(args);
    case 'status':
      return args.length === 0 ? { kind: 'status' } : extra(args);
    case 'update': {
      // Unquoted words make one name, as `devices remove` reads one.
      const named = args.join(' ').trim();
      const target = named === '' ? null : named;
      if (flags.cancel) return yes ? { kind: 'usage', message: '--yes does nothing for orbital update --cancel.' } : { kind: 'updateCancel', target };
      return { kind: 'update', target, yes, when: flags.whenIdle ? 'idle' : 'now' };
    }
    case 'relay':
      if (args.length === 0) return { kind: 'relay' };
      if (args[0] === 'secret') {
        if (args.length !== 1) return extra(args.slice(1));
        return { kind: 'relaySecret', secret: flags.clear ? 'clear' : flags.secretStdin ? 'stdin' : 'prompt', yes };
      }
      if (args[0] !== 'set') return { kind: 'usage', message: `Unknown relay command: ${args[0]}` };
      if (args.length !== 2 || args[1].trim() === '') return { kind: 'usage', message: 'Usage: orbital relay set <url> [--secret]' };
      return {
        kind: 'relaySet', url: args[1].trim(), secret: flags.secret ? 'prompt' : flags.secretStdin ? 'stdin' : 'keep', yes,
      };
    case 'join':
      return join(args);
    case 'devices':
      return devices(args, yes);
    default:
      return { kind: 'usage', message: `Unknown command: ${head}` };
  }
}

function join(args: string[]): Command | Usage {
  if (args.length > 1) return extra(args.slice(1));
  return { kind: 'join', code: args[0] ?? null };
}

function devices(args: string[], yes: boolean): Command | Usage {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'add':
      return rest.length === 0 ? { kind: 'add' } : extra(rest);
    case 'list':
      return rest.length === 0 ? { kind: 'list' } : extra(rest);
    case 'leave':
      return rest.length === 0 ? { kind: 'leave', yes } : extra(rest);
    case 'join':
      return join(rest);
    case 'rename': {
      // Unquoted words make one name, as typed.
      const name = rest.join(' ').trim();
      return name === '' ? { kind: 'usage', message: 'Usage: orbital devices rename <name>' } : { kind: 'rename', name };
    }
    case 'remove': {
      const target = rest.join(' ').trim();
      return target === ''
        ? { kind: 'usage', message: 'Usage: orbital devices remove <name-or-id>' }
        : { kind: 'remove', target, yes };
    }
    case undefined:
      return { kind: 'usage', message: 'Usage: orbital devices add|list|rename|remove|leave|join' };
    default:
      return { kind: 'usage', message: `Unknown devices command: ${sub}` };
  }
}

function extra(args: string[]): Usage {
  return { kind: 'usage', message: `Unexpected argument: ${args[0]}` };
}
