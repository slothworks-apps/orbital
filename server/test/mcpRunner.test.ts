import { describe, it, expect, vi } from 'vitest';
import { Hub } from '../src/api/hub.js';
import { McpStatusTimeoutError, Runner } from '../src/runner/runner.js';

const INIT_SERVERS = [{ name: 'gh', status: 'pending', source: 'local' }];

/**
 * Fake SDK that announces `init` with an MCP list at the first user message,
 * as the CLI does, and carries whatever MCP controls the test gives it.
 */
function fakeQuery(controls: Record<string, unknown> = {}) {
  return ({ prompt, options }: any) => {
    const sid = options.sessionId ?? options.resume;
    async function* gen() {
      for await (const _m of prompt) {
        yield { type: 'system', subtype: 'init', session_id: sid, mcpServers: INIT_SERVERS };
        yield { type: 'result', subtype: 'success', session_id: sid, usage: {} };
      }
    }
    return Object.assign(gen() as any, controls);
  };
}

/** A started session whose first turn — and so its `init` — has gone through. */
async function started(controls: Record<string, unknown> = {}, deps: Partial<ConstructorParameters<typeof Runner>[0]> = {}) {
  const runner = new Runner({ hub: new Hub(), queryFn: fakeQuery(controls), newSessionId: () => 'web-1', ...deps });
  await runner.start({ cwd: '/w/proj', prompt: 'hi', permissionMode: 'acceptEdits' });
  await vi.waitFor(() => expect(runner.status('web-1')).toBe('needs_input'));
  return runner;
}

describe('Runner — MCP servers', () => {
  it('answers from the init snapshot when the CLI cannot be asked', async () => {
    const runner = await started();
    expect(await runner.mcpServers('web-1')).toEqual([
      { name: 'gh', status: 'pending', origin: 'local', toggleable: true, editable: false },
    ]);
  });

  it('prefers the live answer, read against the session cwd', async () => {
    const mcpConfig = vi.fn((_cwd: string) => ({ find: (n: string) => (n === 'gh' ? { scope: 'local' as const, definition: null } : undefined) }));
    const runner = await started(
      { mcpServerStatus: async () => [{ name: 'gh', status: 'connected', source: 'local', tools: [] }] },
      { mcpConfig },
    );
    expect(await runner.mcpServers('web-1')).toEqual([
      { name: 'gh', status: 'connected', origin: 'local', toolCount: 0, toggleable: true, editable: true },
    ]);
    expect(mcpConfig).toHaveBeenCalledWith('/w/proj', 'web-1');
  });

  it('a live call that throws or hangs is an error, not the snapshot', async () => {
    const failing = await started({ mcpServerStatus: async () => { throw new Error('control channel closed'); } });
    await expect(failing.mcpServers('web-1')).rejects.toThrow('control channel closed');
    const hanging = await started({ mcpServerStatus: () => new Promise(() => {}) });
    await expect(hanging.mcpServers('web-1', 20)).rejects.toBeInstanceOf(McpStatusTimeoutError);
  });

  it('throws for a session it does not run', async () => {
    const runner = new Runner({ hub: new Hub(), queryFn: fakeQuery() });
    await expect(runner.mcpServers('nope')).rejects.toThrow('not active');
    await expect(runner.toggleMcpServer('nope', 'gh', false)).rejects.toThrow('not active');
    await expect(runner.reconnectMcpServer('nope', 'gh')).rejects.toThrow('not active');
  });

  it('a control the CLI lacks is an error, not a silent no-op', async () => {
    const runner = await started();
    await expect(runner.reconnectMcpServer('web-1', 'gh')).rejects.toThrow('reconnectMcpServer');
    await expect(runner.toggleMcpServer('web-1', 'gh', false)).rejects.toThrow('toggleMcpServer');
    await expect(runner.reloadMcpConfig('web-1')).rejects.toThrow('reloadPlugins');
  });

  it('passes the controls through, and never switches Orbital\'s own server', async () => {
    const toggleMcpServer = vi.fn(async () => {});
    const reconnectMcpServer = vi.fn(async () => {});
    const reloadPlugins = vi.fn(async () => ({}));
    const runner = await started({ toggleMcpServer, reconnectMcpServer, reloadPlugins });
    await runner.toggleMcpServer('web-1', 'gh', false);
    await runner.reconnectMcpServer('web-1', 'gh');
    await runner.reloadMcpConfig('web-1');
    expect(toggleMcpServer).toHaveBeenCalledWith('gh', false);
    expect(reconnectMcpServer).toHaveBeenCalledWith('gh');
    expect(reloadPlugins).toHaveBeenCalled();
    await expect(runner.toggleMcpServer('web-1', 'orbital', false)).rejects.toThrow('cannot be switched');
    expect(toggleMcpServer).toHaveBeenCalledTimes(1);
  });
});

describe('Runner — MCP login', () => {
  it('asks the CLI to start the login and answers the URL it gave', async () => {
    const mcpAuthenticate = vi.fn(async () => ({ authUrl: 'https://auth.example/a', redirectScheme: 'localhost' }));
    const runner = await started({ mcpAuthenticate });
    expect(await runner.mcpLogin('web-1', 'cf')).toEqual({ authUrl: 'https://auth.example/a' });
    expect(mcpAuthenticate).toHaveBeenCalledWith('cf');
  });

  it('a CLI without the control is an error', async () => {
    const runner = await started();
    await expect(runner.mcpLogin('web-1', 'cf')).rejects.toThrow(/cannot mcpAuthenticate/);
  });
});
