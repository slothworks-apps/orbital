/**
 * The `orbital` command line (spec 2026-10-19-headless-server-design § The
 * CLI table), parsed by hand: a handful of commands, one flag.
 */

export type Command =
  | { kind: 'help' }
  | { kind: 'status' }
  | { kind: 'relay' }
  | { kind: 'relaySet'; url: string; yes: boolean }
  | { kind: 'join'; code: string | null }
  | { kind: 'add' }
  | { kind: 'list' }
  | { kind: 'rename'; name: string }
  | { kind: 'remove'; target: string; yes: boolean }
  | { kind: 'leave'; yes: boolean }
  | { kind: 'update'; yes: boolean };

/** A command line that names no command the CLI has: printed with a pointer to `--help`, exit 2. */
export type Usage = { kind: 'usage'; message: string };

export const HELP = `orbital — drive the Orbital server on this machine

Usage:
  orbital status                      the server, its version, relay and group
  orbital relay                       show the relay
  orbital relay set <url>             set the relay (before pairing)
  orbital join [code]                 join the group whose primary shows the code
  orbital devices add                 show a code another device joins with
  orbital devices list                the group's members
  orbital devices rename <name>       rename this device
  orbital devices remove <name|id>    remove a member (on the primary)
  orbital devices leave               leave the group (on the primary: dissolve it)
  orbital update                      update this server when a newer version is out
  orbital help                        this text

Options:
  -y, --yes    skip the confirmation (relay set, remove, leave, update)
  -h, --help   this text

It talks to the server at 127.0.0.1:$ORBITAL_PORT with the token in its data dir.`;

/** Commands that ask before they act, and so take `--yes`. */
const CONFIRMS: ReadonlySet<Command['kind']> = new Set(['relaySet', 'remove', 'leave', 'update']);

export function parseArgs(argv: readonly string[]): Command | Usage {
  const words: string[] = [];
  let yes = false;
  let help = false;
  let rest = false;
  for (const arg of argv) {
    if (rest || !arg.startsWith('-') || arg === '-') words.push(arg);
    else if (arg === '--') rest = true;
    else if (arg === '-y' || arg === '--yes') yes = true;
    else if (arg === '-h' || arg === '--help') help = true;
    else return { kind: 'usage', message: `Unknown option: ${arg}` };
  }
  if (help) return { kind: 'help' };
  const cmd = command(words, yes);
  if (cmd.kind !== 'usage' && yes && !CONFIRMS.has(cmd.kind)) {
    return { kind: 'usage', message: `--yes does nothing for this command.` };
  }
  return cmd;
}

function command(words: string[], yes: boolean): Command | Usage {
  const [head, ...args] = words;
  switch (head) {
    case undefined:
    case 'help':
      return args.length === 0 ? { kind: 'help' } : extra(args);
    case 'status':
      return args.length === 0 ? { kind: 'status' } : extra(args);
    case 'update':
      return args.length === 0 ? { kind: 'update', yes } : extra(args);
    case 'relay':
      if (args.length === 0) return { kind: 'relay' };
      if (args[0] !== 'set') return { kind: 'usage', message: `Unknown relay command: ${args[0]}` };
      if (args.length !== 2 || args[1].trim() === '') return { kind: 'usage', message: 'Usage: orbital relay set <url>' };
      return { kind: 'relaySet', url: args[1].trim(), yes };
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
