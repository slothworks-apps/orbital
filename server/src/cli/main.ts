/**
 * `orbital`, the server's command line (spec 2026-10-19-headless-server-design
 * § The CLI). Bundled on its own as `dist/cli.mjs`; the package installs it
 * as `/usr/bin/orbital`. It drives the server already running on this
 * machine and never starts one.
 */
import { homedir } from 'node:os';
import { parseArgs } from './args.js';
import { CliError, NotRunning, TokenRefused, httpCall } from './client.js';
import { runCli } from './commands.js';
import { TerminalIo } from './io.js';
import { SystemSetup, runSetup } from './setup.js';
import { cliTarget, readServiceUser, readToken, rootHint, unreadableTokenLine } from './target.js';
import { notRunningLine } from './words.js';

async function main(): Promise<number> {
  const io = new TerminalIo();
  try {
    const argv = process.argv.slice(2);
    const parsed = parseArgs(argv);
    // Help and a bad command line need no server.
    if (parsed.kind === 'help' || parsed.kind === 'usage') {
      return await runCli(argv, { call: () => Promise.reject(new NotRunning()), io, port: 0 });
    }
    const target = cliTarget({ env: process.env, home: homedir(), platform: process.platform });
    if ('error' in target) {
      io.err(target.error);
      return 1;
    }
    const notRunning = async () => {
      io.err(notRunningLine(process.platform));
      const hint = rootHint(process.getuid?.() ?? null, await readServiceUser());
      if (hint) io.err(hint);
    };
    /** `argv` against the server, with the token read now: setup reads it only once the server has written it. */
    const drive = async (args: readonly string[], port = target.port): Promise<number> => {
      const read = await readToken(target.tokenFile);
      if ('unreadable' in read) {
        io.err(unreadableTokenLine(target.tokenFile, await readServiceUser()));
        return 1;
      }
      // The server writes the token at its first start: without one, none has run here.
      if ('missing' in read) {
        await notRunning();
        return 1;
      }
      try {
        return await runCli(args, { call: httpCall(port, read.token), io, port });
      } catch (err) {
        if (err instanceof NotRunning) await notRunning();
        else if (err instanceof TokenRefused) io.err(`Orbital on port ${port} refused the token in ${target.tokenFile}.`);
        else if (err instanceof CliError) io.err(err.message);
        else throw err;
        return 1;
      }
    };
    if (parsed.kind === 'setup') {
      return await runSetup({ io, sys: new SystemSetup(), status: (port) => drive(['status'], port) });
    }
    return await drive(argv);
  } finally {
    io.close();
  }
}

/** Exits once what was written has left: a pipe on a Mac takes its writes asynchronously. */
function exit(code: number): void {
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

main().then(exit, (err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  exit(1);
});
