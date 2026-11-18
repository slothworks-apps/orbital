import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  VIEW_DATA_FILE_MAX_BYTES, VIEW_DATA_INLINE_REST_MAX, VIEW_PAYLOAD_MAX_BYTES, VIEW_RESULT_ECHO_MAX_BYTES, VIEW_TOOL, readViewResult, viewMessageText, type ViewPayload,
} from '@orbital/shared/views';
import { Hub } from '../src/api/hub.js';
import { sessions } from '../src/db/schema.js';
import { createPhoneFileReader } from '../src/remote/phoneFiles.js';
import { Runner, type PendingDecision } from '../src/runner/runner.js';
import { ORBITAL_TOOL_TIMEOUT_MS, orbitalMcpServer } from '../src/runner/spawnTool.js';
import { cleanTitle, entriesToMessages, parseTranscript } from '../src/transcript/parser.js';
import {
  SUBAGENT_REFUSAL, VIEWS_OFF_REFUSAL, ViewsService, compileViewComponent, viewMediaItems,
} from '../src/views/service.js';
import { makeTmpDir, openTmpDb } from './tmp.js';

const COMPONENT = 'export default function View({ data }: { data: { n: number } }) {\n  return <div className="bg-panel">{data.n}</div>;\n}\n';
const HTML = '<p>hello</p>';

/** A service over a temp data directory, its runner a stand-in the test steers. */
function makeService(opts: { enabled?: boolean; transcript?: string } = {}) {
  const dataDir = makeTmpDir('views-data');
  const cwd = makeTmpDir('views-cwd');
  let enabled = opts.enabled ?? true;
  let pending: PendingDecision | null = null;
  const parkView = vi.fn(async (_s: string, _t: string, view: { viewId: string; title: string }) => ({
    viewId: view.viewId, outcome: 'sent' as const, value: { picked: 1 },
  }));
  const service = new ViewsService({
    isEnabled: () => enabled,
    dataDir,
    transcriptPathOf: () => opts.transcript ?? null,
    cwdOf: () => cwd,
    runner: () => ({ parkView, pendingDecision: () => pending }),
  });
  const call = (toolUseId: string | null, input: Record<string, unknown>, session = 's1') =>
    service.show(session, input, toolUseId ? { _meta: { 'claudecode/toolUseId': toolUseId } } : {});
  return {
    service, dataDir, cwd, parkView, call,
    setEnabled: (on: boolean) => { enabled = on; },
    park: (decision: PendingDecision | null) => { pending = decision; },
  };
}

const extras = { approvedDomains: [], cdnHosts: [] };
const textOf = (r: { content: Array<{ text: string }> }) => r.content[0].text;

describe('show_view', () => {
  it('is given only while Labs has it on, and refuses a call once it is turned off', async () => {
    const { service, call, setEnabled } = makeService();
    expect(service.sessionTools('s1')).toMatchObject({ allowedTools: [VIEW_TOOL] });
    setEnabled(false);
    expect(service.sessionTools('s1')).toBeUndefined();
    const res = await call('toolu_1', { title: 'T', html: HTML });
    expect(res).toMatchObject({ isError: true });
    expect(textOf(res)).toBe(VIEWS_OFF_REFUSAL);
  });

  it('shows a view and answers with its id', async () => {
    const { call } = makeService();
    const res = await call('toolu_1', { title: 'Chart', html: HTML });
    expect(res.isError).toBeUndefined();
    expect(readViewResult(textOf(res))).toEqual({ viewId: 'toolu_1', outcome: 'shown' });
  });

  it('compiles a component, and refuses one that does not compile with where it broke', async () => {
    const { call, dataDir, service } = makeService();
    expect((await call('toolu_1', { title: 'T', component: COMPONENT })).isError).toBeUndefined();
    const script = readFileSync(join(dataDir, 'views', 's1', 'toolu_1.js'), 'utf8');
    expect(script).toContain('react/jsx-runtime');
    expect(script).not.toContain(': { n: number }');
    expect(service.payload('s1', 'toolu_1', extras)).toMatchObject({ kind: 'react', script });

    const broken = await call('toolu_2', { title: 'T', component: 'export default function V() {\n  return <div>;\n}' });
    expect(broken.isError).toBe(true);
    expect(textOf(broken)).toMatch(/line 2/);
    expect(existsSync(join(dataDir, 'views', 's1', 'toolu_2.js'))).toBe(false);
    expect(compileViewComponent('function V() { return null }')).toMatchObject({ ok: false, error: expect.stringMatching(/default export/) });
  });

  it('compiles again from the call when the stored script is gone', async () => {
    const { call, dataDir, service } = makeService();
    await call('toolu_1', { title: 'T', component: COMPONENT });
    const path = join(dataDir, 'views', 's1', 'toolu_1.js');
    rmSync(path);
    expect(service.payload('s1', 'toolu_1', extras)?.script).toContain('react/jsx-runtime');
    expect(existsSync(path)).toBe(true);
  });

  it('refuses a data file that is missing, too large, of another kind or not JSON', async () => {
    const { call, cwd } = makeService();
    expect(textOf(await call('toolu_1', { title: 'T', html: HTML, dataFile: 'nope.json' }))).toMatch(/cannot be read/);
    writeFileSync(join(cwd, 'data.txt'), 'x');
    expect(textOf(await call('toolu_2', { title: 'T', html: HTML, dataFile: 'data.txt' }))).toMatch(/\.json or \.csv/);
    writeFileSync(join(cwd, 'big.csv'), '');
    truncateSync(join(cwd, 'big.csv'), VIEW_DATA_FILE_MAX_BYTES + 1);
    expect(textOf(await call('toolu_3', { title: 'T', html: HTML, dataFile: 'big.csv' }))).toMatch(/Aggregate/);
    writeFileSync(join(cwd, 'bad.json'), '{ nope');
    expect(textOf(await call('toolu_4', { title: 'T', html: HTML, dataFile: 'bad.json' }))).toMatch(/not valid JSON/);
    mkdirSync(join(cwd, 'dir.json'));
    expect(textOf(await call('toolu_5', { title: 'T', html: HTML, dataFile: 'dir.json' }))).toMatch(/cannot be read/);
  });

  it('copies the data file, so the view keeps it when the file changes; small copies ride inline', async () => {
    const { call, cwd, service } = makeService();
    writeFileSync(join(cwd, 'rows.csv'), 'a,b\n1,2\n');
    await call('toolu_1', { title: 'T', html: HTML, dataFile: 'rows.csv' });
    writeFileSync(join(cwd, 'rows.csv'), 'changed');
    expect(service.payload('s1', 'toolu_1', extras)?.data).toEqual({ format: 'csv', bytes: 8, text: 'a,b\n1,2\n', inline: true });

    writeFileSync(join(cwd, 'big.json'), JSON.stringify({ s: 'x'.repeat(VIEW_DATA_INLINE_REST_MAX) }));
    await call('toolu_2', { title: 'T', html: HTML, dataFile: join(cwd, 'big.json') });
    expect(service.payload('s1', 'toolu_2', extras)?.data).toMatchObject({ format: 'json', inline: false });
    expect(service.payload('s1', 'toolu_2', extras)?.data?.value).toBeUndefined();
    expect(service.dataCopy('s1', 'toolu_2')?.format).toBe('json');
  });

  it('keeps every payload within one relay frame: a data copy rides outside past it, a page too large is refused', async () => {
    const { call, cwd, service } = makeService();
    // Under VIEW_PAGE_MAX_CHARS in characters, past the payload's budget in UTF-8 bytes.
    const wide = await call('toolu_w', { title: 'T', html: `<p>${'ž'.repeat(110_000)}</p>` });
    expect(wide.isError).toBe(true);
    expect(textOf(wide)).toMatch(/bytes/);
    const component = `export default function V() { return <p>{${JSON.stringify('é'.repeat(95_000))}}</p> }`;
    expect(textOf(await call('toolu_c', { title: 'T', component, wait: true }))).toMatch(/compiled/);

    // Under VIEW_DATA_INLINE_REST_MAX on its own.
    writeFileSync(join(cwd, 'rows.csv'), 'a,b\n'.repeat(25_000));
    await call('toolu_1', { title: 'T', html: `<p>${'x'.repeat(100_000)}</p>`, dataFile: 'rows.csv' });
    const big = service.payload('s1', 'toolu_1', extras)!;
    expect(big.data).toMatchObject({ format: 'csv', inline: false });
    expect(big.data?.text).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(big))).toBeLessThanOrEqual(VIEW_PAYLOAD_MAX_BYTES);
    // The same copy beside a small page still rides inside.
    await call('toolu_2', { title: 'T', html: HTML, dataFile: 'rows.csv' });
    expect(service.payload('s1', 'toolu_2', extras)?.data).toMatchObject({ format: 'csv', inline: true });
  });

  it('updates a view with replaces, resolving a later call to the view, and refuses an unknown one', async () => {
    const { call, service } = makeService();
    await call('toolu_1', { title: 'T', html: HTML });
    const second = await call('toolu_2', { title: 'T', html: HTML, replaces: 'toolu_1' });
    expect(readViewResult(textOf(second))?.viewId).toBe('toolu_1');
    const third = await call('toolu_3', { title: 'T', html: HTML, replaces: 'toolu_2' });
    expect(readViewResult(textOf(third))?.viewId).toBe('toolu_1');
    expect(service.payload('s1', 'toolu_3', extras)?.viewId).toBe('toolu_1');

    const unknown = await call('toolu_4', { title: 'T', html: HTML, replaces: 'toolu_nope' });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toMatch(/no view toolu_nope/);
    // Another session's view is not this one's to replace.
    expect((await call('toolu_5', { title: 'T', html: HTML, replaces: 'toolu_1' }, 's2')).isError).toBe(true);
  });

  it('waits on the user through the runner, and keeps one waiting view at a time', async () => {
    const { call, parkView, park } = makeService();
    const res = await call('toolu_1', { title: 'Pick one', html: HTML, wait: true });
    expect(parkView).toHaveBeenCalledWith('s1', 'toolu_1', { viewId: 'toolu_1', title: 'Pick one' }, undefined);
    expect(readViewResult(textOf(res))).toEqual({ viewId: 'toolu_1', outcome: 'sent', value: { picked: 1 } });

    park({ id: 'toolu_1', kind: 'view', input: { viewId: 'toolu_1', title: 'Pick one' }, createdAt: 1 });
    const second = await call('toolu_2', { title: 'Other', html: HTML, wait: true });
    expect(textOf(second)).toMatch(/only one view may wait/);
    const update = await call('toolu_3', { title: 'Pick one', html: HTML, replaces: 'toolu_1' });
    expect(textOf(update)).toMatch(/waiting for the user and cannot be updated/);
    // A view that does not wait still shows meanwhile.
    expect((await call('toolu_4', { title: 'Other', html: HTML })).isError).toBeUndefined();
  });

  it('marks the waiting call in its payload, and carries its result once it has one', async () => {
    const { call, service, park } = makeService();
    await call('toolu_1', { title: 'Pick', html: HTML, wait: true });
    park({ id: 'toolu_1', kind: 'view', input: { viewId: 'toolu_1', title: 'Pick' }, createdAt: 1 });
    expect(service.payload('s1', 'toolu_1', extras)).toMatchObject({ waiting: true, result: null, wait: true });
    park(null);
    expect(service.payload('s1', 'toolu_1', extras)).toMatchObject({ waiting: false, result: { outcome: 'sent', value: { picked: 1 } } });
  });

  it('echoes only the start of a long answer in the payload; the agent got all of it', async () => {
    const { call, service, parkView } = makeService();
    const typed = 'é'.repeat(200_000);
    parkView.mockResolvedValueOnce({ viewId: 'toolu_1', outcome: 'answered', text: typed } as any);
    const res = await call('toolu_1', { title: 'Pick', html: HTML, wait: true });
    expect(readViewResult(textOf(res))).toEqual({ viewId: 'toolu_1', outcome: 'answered', text: typed });
    const payload = service.payload('s1', 'toolu_1', extras)!;
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(VIEW_PAYLOAD_MAX_BYTES);
    expect(payload.result).toMatchObject({ outcome: 'answered' });
    expect((payload.result as { text: string }).text.startsWith('éé')).toBe(true);
    expect(Buffer.byteLength((payload.result as { text: string }).text)).toBeLessThanOrEqual(VIEW_RESULT_ECHO_MAX_BYTES);
  });

  it("refuses a subagent's call in its hook, and finds the main session's tool_use id there when the call carries none", async () => {
    const { service, call } = makeService();
    const hook = service.sessionTools('s1')!.preToolUse![0].hooks[0];
    const base = { session_id: 'x', transcript_path: '', cwd: '', hook_event_name: 'PreToolUse' as const, tool_name: VIEW_TOOL };
    const input = { title: 'T', html: HTML };
    const sub = await hook({ ...base, tool_input: input, tool_use_id: 'toolu_s', agent_id: 'a1' }, 'toolu_s', { signal: new AbortController().signal });
    expect(sub).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: SUBAGENT_REFUSAL } });

    expect(await hook({ ...base, tool_input: { html: HTML, title: 'T' }, tool_use_id: 'toolu_m' } as any, 'toolu_m', { signal: new AbortController().signal })).toEqual({});
    const res = await call(null, input);
    expect(readViewResult(textOf(res))?.viewId).toBe('toolu_m');
    // Taken once: the same input again without an id cannot be told apart.
    expect((await call(null, input)).isError).toBe(true);
  });

  it('reads calls and results from the transcript, and refuses to draw a refused call', async () => {
    const dir = makeTmpDir('views-transcript');
    const path = join(dir, 's1.jsonl');
    const line = (o: object) => JSON.stringify(o) + '\n';
    writeFileSync(
      path,
      line({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'go' } }) +
        line({
          type: 'assistant', uuid: 'a1', parentUuid: 'u1',
          message: { role: 'assistant', content: [
            { type: 'tool_use', id: 'toolu_ok', name: VIEW_TOOL, input: { title: 'Ok', html: HTML } },
            { type: 'tool_use', id: 'toolu_bad', name: VIEW_TOOL, input: { title: 'Bad', html: HTML } },
          ] },
        }) +
        line({
          type: 'user', uuid: 'u2', parentUuid: 'a1',
          message: { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'toolu_ok', content: [{ type: 'text', text: 'View toolu_ok: shown.\nTo change it…' }] },
            { type: 'tool_result', tool_use_id: 'toolu_bad', is_error: true, content: 'Nothing was shown' },
          ] },
        }),
    );
    const { service } = makeService({ transcript: path });
    expect(service.payload('s1', 'toolu_ok', extras)).toMatchObject({ kind: 'html', html: HTML, result: { outcome: 'shown' } });
    expect(service.payload('s1', 'toolu_bad', extras)).toBeNull();
    expect(service.payload('s1', 'toolu_nope', extras)).toBeNull();
  });

  it('clamps the height, keeps only valid live domains, and lists the approved ones and every CDN', async () => {
    const { call, service } = makeService();
    await call('toolu_1', { title: 'T', html: HTML, height: 4000, liveDomains: ['API.github.com', 'https://example.org/'] });
    const payload = service.payload('s1', 'toolu_1', { approvedDomains: ['example.org'], cdnHosts: ['cdn.example.com'] }) as ViewPayload;
    expect(payload.height).toBe(480);
    expect(payload.liveDomains).toEqual(['api.github.com', 'example.org']);
    expect(payload.approvedDomains).toEqual(['example.org']);
    expect(payload.cdnHosts.at(-1)).toBe('cdn.example.com');
    expect(payload.cdnHosts).toContain('esm.sh');
  });
});

describe('viewMediaItems', () => {
  it('lists one item per view at its newest call, and none for a refused call', () => {
    const line = (o: object) => JSON.stringify(o) + '\n';
    const entries = parseTranscript(
      line({ type: 'assistant', uuid: 'a1', timestamp: 't1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: VIEW_TOOL, input: { title: 'First', html: HTML } }] } }) +
        line({ type: 'assistant', uuid: 'a2', timestamp: 't2', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: VIEW_TOOL, input: { title: 'Refused', html: HTML } }] } }) +
        line({ type: 'user', uuid: 'u2', timestamp: 't3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', is_error: true, content: 'no' }] } }) +
        line({ type: 'assistant', uuid: 'a3', timestamp: 't4', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: VIEW_TOOL, input: { title: 'Second', html: HTML, replaces: 'toolu_1' } }] } }),
    );
    expect(viewMediaItems(entriesToMessages(entries))).toEqual([
      { id: 'view:toolu_1', kind: 'view', source: 'view', messageId: 'a3:0', ts: 't4', view: { id: 'toolu_1', toolUseId: 'toolu_2', title: 'Second' } },
    ]);
  });
});

describe('cleanTitle', () => {
  it('drops the block of a message sent from a view', () => {
    const sent = viewMessageText({ viewId: 'toolu_1', title: 'Chart', value: { a: 1 } });
    expect(cleanTitle(sent)).toBe('');
    expect(cleanTitle(`${sent}\nAnd make it blue`)).toBe('And make it blue');
  });
});

describe('file_get as view-data', () => {
  it("reads a session's own data copy by its call, and nothing outside it", () => {
    const db = openTmpDb('views-phone');
    db.insert(sessions).values({ id: 's1', projectDir: 'p', cwd: '/w', title: 't', lastAt: 1, source: 'web', permissionMode: null }).run();
    db.insert(sessions).values({ id: 's2', projectDir: 'p', cwd: '/w', title: 't', lastAt: 1, source: 'web', permissionMode: null }).run();
    const dataDir = makeTmpDir('views-phone-data');
    mkdirSync(join(dataDir, 'views', 's1'), { recursive: true });
    writeFileSync(join(dataDir, 'views', 's1', 'toolu_1.csv'), 'a,b\n');
    writeFileSync(join(dataDir, 'secret.json'), '{}');
    const read = createPhoneFileReader(db, () => '/nonexistent', undefined, dataDir);
    expect(read('s1', 'toolu_1', 'view-data')).toMatchObject({ status: 200, mediaType: 'text/csv; charset=utf-8', size: 4 });
    expect(read('s2', 'toolu_1', 'view-data').status).toBe(404);
    expect(read('s1', '../secret', 'view-data').status).toBe(404);
    expect(read('s1', '../../secret', 'view-data').status).toBe(404);
    expect(read('nope', 'toolu_1', 'view-data').status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// The runner's parking of a waiting view

function fakeQueryFnAsking() {
  const controller = new AbortController();
  let options: any;
  const interrupt = vi.fn(async () => {});
  const fn = ({ prompt, options: o }: { prompt: AsyncIterable<any>; options: any }) => {
    options = o;
    async function* gen(): AsyncGenerator<any> {
      for await (const _ of prompt) { /* the turn stays inside its tool call */ }
    }
    const g = gen() as any;
    g.interrupt = interrupt;
    return g;
  };
  const ask = (input: unknown, toolUseID: string, toolName: string): Promise<any> =>
    options.canUseTool(toolName, input, { signal: controller.signal, toolUseID, requestId: 'req-1' });
  return { fn, ask };
}

function subscribed(hub: Hub, topic: string) {
  const received: any[] = [];
  const socket: any = {
    send: (d: string) => received.push(JSON.parse(d)),
    handlers: {} as Record<string, Function>,
    on(ev: string, cb: Function) { this.handlers[ev] = cb; },
  };
  hub.handleSocket(socket);
  socket.handlers['message'](JSON.stringify({ type: 'subscribe', topic }));
  return received;
}

async function parkedView(signal?: AbortSignal) {
  const hub = new Hub();
  const { fn, ask } = fakeQueryFnAsking();
  const runner = new Runner({ hub, queryFn: fn as any, newSessionId: () => 'web-1' });
  const received = subscribed(hub, 'session:web-1');
  const id = await runner.start({ cwd: '/w', prompt: 'go', permissionMode: 'acceptEdits' });
  const result = runner.parkView(id, 'toolu_v', { viewId: 'toolu_root', title: 'Pick a colour' }, signal);
  return { runner, id, received, result, ask };
}

describe('Runner.parkView', () => {
  it('parks the view as a decision carrying only its id and title, and waits in needs_input', async () => {
    const { runner, id, received } = await parkedView();
    expect(runner.status(id)).toBe('needs_input');
    const decision = { id: 'toolu_v', kind: 'view', input: { viewId: 'toolu_root', title: 'Pick a colour' }, createdAt: expect.any(Number), toolName: VIEW_TOOL, title: 'Pick a colour' };
    expect(runner.pendingDecision(id)).toEqual(decision);
    expect(received).toContainEqual({ topic: 'session:web-1', event: 'decision_pending', decision });
  });

  it('settles with the value the page sent, and tells every client', async () => {
    const { runner, id, received, result } = await parkedView();
    expect(runner.answerDecision(id, 'toolu_v', { approved: true })).toBe(false);
    expect(runner.answerDecision(id, 'toolu_v', { value: { colour: 'red' } })).toBe(true);
    expect(await result).toEqual({ viewId: 'toolu_root', outcome: 'sent', value: { colour: 'red' } });
    expect(runner.pendingDecision(id)).toBeNull();
    expect(runner.status(id)).toBe('working');
    expect(received).toContainEqual({
      topic: 'session:web-1', event: 'decision_resolved', decisionId: 'toolu_v',
      view: { viewId: 'toolu_root', outcome: 'sent', value: { colour: 'red' } },
    });
  });

  it('takes text typed in the composer as the answer', async () => {
    const { runner, id, result } = await parkedView();
    expect(runner.send(id, 'blue, please')).toBeNull();
    expect(await result).toEqual({ viewId: 'toolu_root', outcome: 'answered', text: 'blue, please' });
  });

  it('is cancelled by a refusal, an interrupt, the end, an abort and a newer ask', async () => {
    const closed = await parkedView();
    expect(closed.runner.answerDecision(closed.id, 'toolu_v', { approved: false })).toBe(true);
    expect(await closed.result).toMatchObject({ outcome: 'cancelled' });

    const interrupted = await parkedView();
    await interrupted.runner.interrupt(interrupted.id);
    expect(await interrupted.result).toMatchObject({ outcome: 'cancelled', reason: 'The user interrupted.' });

    const ended = await parkedView();
    await ended.runner.stop(ended.id);
    expect(await ended.result).toMatchObject({ outcome: 'cancelled' });

    const controller = new AbortController();
    const aborted = await parkedView(controller.signal);
    controller.abort();
    expect(await aborted.result).toMatchObject({ outcome: 'cancelled', reason: 'The request was aborted.' });

    const superseded = await parkedView();
    void superseded.ask({ command: 'ls' }, 'toolu_bash', 'Bash');
    expect(await superseded.result).toMatchObject({ outcome: 'cancelled', reason: 'Superseded by a newer request.' });
    expect(superseded.runner.pendingDecision(superseded.id)).toMatchObject({ id: 'toolu_bash', kind: 'permission' });
  });

  it('answers cancelled at once for a session it does not run', async () => {
    const runner = new Runner({ hub: new Hub(), queryFn: fakeQueryFnAsking().fn as any, newSessionId: () => 'web-1' });
    expect(await runner.parkView('nope', 'toolu_v', { viewId: 'toolu_v', title: 'T' })).toMatchObject({ outcome: 'cancelled' });
  });
});

describe("Orbital's MCP server", () => {
  it("carries its own tool-call timeout, so the user's MCP_TOOL_TIMEOUT cannot cut a waiting view", () => {
    expect(orbitalMcpServer('s1', {})).toMatchObject({ type: 'sdk', timeout: ORBITAL_TOOL_TIMEOUT_MS });
  });
});
