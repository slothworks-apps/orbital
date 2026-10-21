import { describe, it, expect } from 'vitest';
import { endCli, isClaudeCommand, TERM_GRACE_MS, type EndCliDeps } from '../src/watcher/endCli.js';

/** A process that dies on the signals listed in `diesOn`, on a clock the test owns. */
function fakeProcess(command: string | null, diesOn: NodeJS.Signals[]) {
  let alive = true;
  let now = 0;
  const signals: NodeJS.Signals[] = [];
  const deps: EndCliDeps = {
    isAlive: () => alive,
    commandOf: () => command,
    kill: (_pid, signal) => {
      signals.push(signal);
      if (diesOn.includes(signal)) alive = false;
    },
    sleep: async (ms) => { now += ms; },
  };
  return { deps, signals, elapsed: () => now };
}

describe('endCli', () => {
  it('ends a CLI that takes SIGTERM without escalating', async () => {
    const p = fakeProcess('claude --resume abc', ['SIGTERM']);
    expect(await endCli(1, p.deps)).toBe('ended');
    expect(p.signals).toEqual(['SIGTERM']);
  });

  it('kills a CLI that outlives the grace period', async () => {
    const p = fakeProcess('claude', ['SIGKILL']);
    expect(await endCli(1, p.deps)).toBe('ended');
    expect(p.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(p.elapsed()).toBeGreaterThanOrEqual(TERM_GRACE_MS);
  });

  it('reports a process that survives SIGKILL', async () => {
    const p = fakeProcess('claude', []);
    expect(await endCli(1, p.deps)).toBe('still_running');
  });

  it('never signals a reused pid that is not a CLI', async () => {
    const p = fakeProcess('/usr/bin/vim notes.md', ['SIGTERM']);
    expect(await endCli(1, p.deps)).toBe('not_claude');
    expect(p.signals).toEqual([]);
  });

  it('reads a process gone before the check as ended', async () => {
    const p = fakeProcess(null, []);
    expect(await endCli(1, p.deps)).toBe('ended');
    expect(p.signals).toEqual([]);
  });
});

describe('isClaudeCommand', () => {
  it.each([
    'claude --resume abc',
    '/opt/homebrew/bin/claude --output-format stream-json',
    '/Users/me/.local/share/claude/versions/2.1.280 --resume abc',
    'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
  ])('accepts %s', (command) => {
    expect(isClaudeCommand(command)).toBe(true);
  });

  it.each([
    '/usr/bin/vim claude',
    'node /srv/app/server.js',
    '/bin/zsh -c claude-notes',
    'claudette',
  ])('refuses %s', (command) => {
    expect(isClaudeCommand(command)).toBe(false);
  });
});
