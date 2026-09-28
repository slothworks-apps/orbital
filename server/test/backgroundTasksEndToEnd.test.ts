import { describe, it, expect, vi } from 'vitest';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildServer } from '../src/index.js';

/**
 * The whole chain against a real `buildServer`: SDK stream -> Runner (the
 * launching call and its output path) -> onTaskEvent -> BackgroundTaskStore
 * -> toApiSession, the stop and output routes, the output topic, and the
 * `background_tasks` table across a restart. The unit tests prove each
 * link; only this proves index.ts joins them (spec
 * 2026-09-28-background-tasks-design §§ 2, 4).
 */

/**
 * Fake SDK in the real stream order for a background `Bash`: the call, its
 * `task_started`, the launch `tool_result` naming the output file, and the
 * turn's `result` — with the shell still running. `finish()` sends its
 * notification; `exit()` ends the generator instead, the way a CLI process
 * exiting does.
 */
function fakeSdkWithShell(outputPath: string) {
  let finish!: () => void;
  let exit!: () => void;
  const finished = new Promise<'finish'>((resolve) => { finish = () => resolve('finish'); });
  const exited = new Promise<'exit'>((resolve) => { exit = () => resolve('exit'); });
  const stopTask = vi.fn(async (_taskId: string) => {});
  const options: any[] = [];
  const fn = ({ prompt, options: opts }: { prompt: AsyncIterable<any>; options: any }) => {
    options.push(opts);
    const sid = opts?.sessionId ?? opts?.resume;
    async function* gen() {
      for await (const _ of prompt) {
        yield { type: 'system', subtype: 'init', session_id: sid };
        yield {
          type: 'assistant', session_id: sid, parent_tool_use_id: null,
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tb1', name: 'Bash', input: { command: 'npm run dev', run_in_background: true } }],
          },
        };
        yield {
          type: 'system', subtype: 'task_started', session_id: sid,
          task_id: 'sh1', tool_use_id: 'tb1', description: 'dev server', task_type: 'local_bash', is_backgrounded: true,
        };
        yield {
          type: 'user', session_id: sid, parent_tool_use_id: null,
          message: {
            role: 'user',
            content: [{
              type: 'tool_result', tool_use_id: 'tb1',
              content: `Command running in background with ID: sh1. Output is being written to: ${outputPath}. You will be notified when it completes.`,
            }],
          },
        };
        yield { type: 'result', subtype: 'success', session_id: sid, usage: {} };
        const how = await Promise.race([finished, exited]);
        if (how === 'exit') return;
        yield {
          type: 'system', subtype: 'task_notification', session_id: sid,
          task_id: 'sh1', tool_use_id: 'tb1', status: 'completed', summary: '', output_file: outputPath,
        };
        yield { type: 'result', subtype: 'success', session_id: sid, usage: {} };
      }
    }
    const g = gen() as any;
    g.stopTask = stopTask;
    return g;
  };
  return { fn, finish, exit, stopTask, options };
}

function tempDirs() {
  const claudeDir = mkdtempSync(join(tmpdir(), 'orbital-bg-e2e-'));
  mkdirSync(join(claudeDir, 'projects'), { recursive: true });
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
  const outDir = mkdtempSync(join(tmpdir(), 'orbital-bg-out-'));
  return { claudeDir, dbPath: join(claudeDir, 'index.db'), outputPath: join(outDir, 'sh1.output') };
}

async function sessionOf(app: any, id: string) {
  const res = await app.inject({ method: 'GET', url: '/api/sessions' });
  return res.json().sessions.find((s: { id: string }) => s.id === id);
}

async function launch(app: any): Promise<string> {
  const created = await app.inject({
    method: 'POST', url: '/api/sessions',
    payload: { cwd: '/w', prompt: 'start the dev server', permissionMode: 'acceptEdits' },
  });
  return created.json().sessionId;
}

describe("a background shell in one of Orbital's own sessions, end to end", () => {
  it('keeps the session working while it runs, streams its output, stops through the SDK and ends with its exit code', async () => {
    const { claudeDir, dbPath, outputPath } = tempDirs();
    writeFileSync(outputPath, 'starting\n');
    const sdk = fakeSdkWithShell(outputPath);
    const app = await buildServer({ claudeDir, dbPath, queryFn: sdk.fn as any });
    let ws: WebSocket | undefined;
    try {
      const sessionId = await launch(app);
      expect(sdk.options[0].perTaskStopAffordance).toBe(true);

      // The turn is over and only the shell runs: working, waiting on it.
      await vi.waitFor(async () => {
        const s = await sessionOf(app, sessionId);
        expect(s?.awaitingSubagents).toBe(true);
        expect(s?.backgroundTasks[0]?.hasOutput).toBe(true);
      }, { timeout: 3000 });
      const running = await sessionOf(app, sessionId);
      expect(running.status).toBe('working');
      expect(running.backgroundTasks).toEqual([{
        id: 'sh1', kind: 'shell', label: 'dev server', command: 'npm run dev', state: 'running',
        startedAt: expect.any(Number), toolUseId: 'tb1', hasOutput: true,
      }]);

      // Following: subscribe, then read the tail, then see what is appended.
      await app.listen({ host: '127.0.0.1', port: 0 });
      const port = (app.server.address() as AddressInfo).port;
      const topic = `task-output:${sessionId}:sh1`;
      const frames: any[] = [];
      ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.onmessage = (e) => {
        const frame = JSON.parse(String(e.data));
        if (frame.topic === topic) frames.push(frame);
      };
      await new Promise<void>((resolve) => {
        ws!.onopen = () => { ws!.send(JSON.stringify({ type: 'subscribe', topic })); resolve(); };
      });
      const tail = (await app.inject({ url: `/api/sessions/${sessionId}/tasks/sh1/output` })).json();
      expect(tail).toEqual({ text: 'starting\n', start: 0, end: 9 });
      // The subscribe has no ack, so keep appending until a delta arrives.
      await vi.waitFor(() => {
        appendFileSync(outputPath, 'ready\n');
        expect(frames.some((f) => f.event === 'output' && f.text.includes('ready'))).toBe(true);
      }, { timeout: 3000, interval: 300 });
      const first = frames.find((f) => f.event === 'output');
      expect(first.offset).toBeGreaterThanOrEqual(tail.end);

      const stop = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/tasks/sh1/stop` });
      expect(stop.statusCode).toBe(204);
      expect(sdk.stopTask).toHaveBeenCalledWith('sh1');

      appendFileSync(outputPath, '\n[exited with code 0]\n');
      sdk.finish();
      await vi.waitFor(async () => {
        const s = await sessionOf(app, sessionId);
        expect(s?.backgroundTasks[0]).toEqual(expect.objectContaining({ state: 'ended', status: 'completed', exitCode: 0 }));
        expect(s?.status).toBe('needs_input');
      }, { timeout: 3000 });
      expect((await sessionOf(app, sessionId)).awaitingSubagents).toBe(false);

      // An ended task can no longer be stopped; a deleted file is gone.
      expect((await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/tasks/sh1/stop` })).statusCode).toBe(409);
      rmSync(outputPath);
      await vi.waitFor(() => expect(frames.some((f) => f.event === 'gone')).toBe(true), { timeout: 3000 });
      expect((await app.inject({ url: `/api/sessions/${sessionId}/tasks/sh1/output` })).statusCode).toBe(410);
    } finally {
      ws?.close();
      await app.close();
    }
  });

  it('ends a running task without a status when the CLI process exits', async () => {
    const { claudeDir, dbPath, outputPath } = tempDirs();
    writeFileSync(outputPath, 'serving\n');
    const sdk = fakeSdkWithShell(outputPath);
    const app = await buildServer({ claudeDir, dbPath, queryFn: sdk.fn as any });
    try {
      const sessionId = await launch(app);
      await vi.waitFor(async () => expect((await sessionOf(app, sessionId))?.awaitingSubagents).toBe(true), { timeout: 3000 });
      sdk.exit();
      await vi.waitFor(async () => {
        const s = await sessionOf(app, sessionId);
        expect(s?.status).toBe('idle');
        expect(s?.backgroundTasks[0]?.state).toBe('ended');
      }, { timeout: 3000 });
      const task = (await sessionOf(app, sessionId)).backgroundTasks[0];
      expect(task).not.toHaveProperty('status');
      expect(task.endedAt).toEqual(expect.any(Number));
      // Kept, not dropped: its output is still there to read.
      expect((await app.inject({ url: `/api/sessions/${sessionId}/tasks/sh1/output` })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('keeps a task across a restart of the server, ending one that was still running', async () => {
    const { claudeDir, dbPath, outputPath } = tempDirs();
    writeFileSync(outputPath, 'serving\n');
    const sdk = fakeSdkWithShell(outputPath);
    const first = await buildServer({ claudeDir, dbPath, queryFn: sdk.fn as any });
    let sessionId: string;
    try {
      sessionId = await launch(first);
      await vi.waitFor(async () => expect((await sessionOf(first, sessionId))?.backgroundTasks[0]?.hasOutput).toBe(true), { timeout: 3000 });
    } finally {
      // A close with the process still up: nothing ends the task in this
      // server, so the row is still `running` for the next one to find.
      await first.close();
    }
    const second = await buildServer({ claudeDir, dbPath, queryFn: fakeSdkWithShell(outputPath).fn as any });
    try {
      const s = await sessionOf(second, sessionId!);
      expect(s.backgroundTasks).toEqual([{
        id: 'sh1', kind: 'shell', label: 'dev server', command: 'npm run dev', state: 'ended',
        startedAt: expect.any(Number), endedAt: expect.any(Number), toolUseId: 'tb1', hasOutput: true,
      }]);
      expect(s.awaitingSubagents).toBe(false);
      const tail = (await second.inject({ url: `/api/sessions/${sessionId!}/tasks/sh1/output` })).json();
      expect(tail.end).toBe(statSync(outputPath).size);
    } finally {
      await second.close();
    }
  });
});
