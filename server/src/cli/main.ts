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
import { cliTarget, readToken } from './target.js';
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
    const token = await readToken(target.tokenFile);
    // The server writes the token at its first start: without one, none has run here.
    if (token === null) {
      io.err(notRunningLine(process.platform));
      return 1;
    }
    try {
      return await runCli(argv, { call: httpCall(target.port, token), io, port: target.port });
    } catch (err) {
      if (err instanceof NotRunning) io.err(notRunningLine(process.platform));
      else if (err instanceof TokenRefused) io.err(`Orbital on port ${target.port} refused the token in ${target.tokenFile}.`);
      else if (err instanceof CliError) io.err(err.message);
      else throw err;
      return 1;
    }
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
