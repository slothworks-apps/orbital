import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerHarnessRoutes } from '../src/api/harness.js';
import {
  advanceMessage, applyChanges, approve, decideTurnEnd, fillInputs, snapshotSteps, gateOf, goBack, initialState,
  kickoffMessage, nudgeMessage, tick, userReopen, validateTemplate,
} from '../src/harness/logic.js';
import { HarnessService, isLocalCommit, type HarnessDeps } from '../src/harness/service.js';
import { DEFAULT_OPTIONS, type HarnessStep, type SessionHarness } from '../src/harness/types.js';
import { makeTmpDir, openTmpDb } from './tmp.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { projectRootOf } from '../src/harness/project.js';
import { harnessGateOf, statusOf } from '../src/api/shape.js';
import { sessionHarnesses as sessionHarnessesTable } from '../src/db/schema.js';
const MAX_AUTO_ROUNDS = DEFAULT_OPTIONS.maxAutoRounds;
const MAX_IDLE_NUDGES = DEFAULT_OPTIONS.maxIdleNudges;
const rec = (summary = '') => ({ summary, decisions: [], openQuestions: [] });
import { buildWatcherPrompt, parseWatcherReply } from '../src/harness/watcher.js';
import { buildDraftPrompt, digestTranscript, draftTemplate, parseDraftReply } from '../src/harness/drafter.js';

const steps: HarnessStep[] = [
  { id: 'build', title: 'Build {{name}}', instructions: 'Build it from {{figma}}.', mode: 'auto', doneWhen: 'it renders' },
  { id: 'api', title: 'Tune the API', instructions: 'Tune.', mode: 'gate', doneWhen: 'the user likes it' },
  { id: 'pr', title: 'PR', instructions: 'Open a PR.', mode: 'auto', doneWhen: 'PR is up' },
];

function harness(over: Partial<SessionHarness> = {}): SessionHarness {
  return {
    sessionId: 's1', templateId: 1, name: 'New component', steps, inputs: {},
    state: initialState(steps), options: DEFAULT_OPTIONS, paused: false, pauseReason: null, pauseKind: null, pausedAt: null,
    removedAt: null, autoRounds: 0, idleNudges: 0,
    createdAt: 0, updatedAt: 0, ...over,
  };
}

const idle = { decisionPending: false, backgroundWork: false, tickedThisTurn: false, spokeAfterTick: false };

describe('fillInputs', () => {
  it('replaces known keys and leaves unknown ones visible', () => {
    expect(fillInputs('{{ name }} from {{figma}} and {{nope}}', { name: 'Input', figma: 'f://1' }))
      .toBe('Input from f://1 and {{nope}}');
  });

  it('fills a step\'s verify command as well as its text', () => {
    const [step] = snapshotSteps([{ id: 's', title: '{{c}}', instructions: '', mode: 'auto', doneWhen: '', verify: 'npm test -- {{c}}' }], { c: 'Button' });
    expect(step.verify).toBe('npm test -- Button');
  });
});

describe('step state machine', () => {
  it('ticks only the active step', () => {
    const state = initialState(steps);
    expect(tick(steps, state, 'api', rec(''), 1)).toMatchObject({ ok: false });
    expect(tick(steps, state, 'missing', rec(''), 1)).toMatchObject({ ok: false });
    const r = tick(steps, state, 'build', rec('done'), 1);
    expect(r).toMatchObject({ ok: true, outcome: 'advanced' });
    if (r.ok) expect(r.state.map((s) => s.status)).toEqual(['done', 'active', 'pending']);
  });

  it('a gate waits for approval, then the next step becomes active', () => {
    const state = tick(steps, initialState(steps), 'build', rec(), 1);
    if (!state.ok) throw new Error();
    const gate = tick(steps, state.state, 'api', rec('tuned'), 2);
    expect(gate).toMatchObject({ ok: true, outcome: 'awaiting_approval' });
    if (!gate.ok) throw new Error();
    expect(tick(steps, gate.state, 'api', rec(''), 3)).toMatchObject({ ok: false });
    expect(approve(steps, gate.state, 0)).toBeNull();
    const approved = approve(steps, gate.state, 1);
    expect(approved?.map((s) => s.status)).toEqual(['done', 'done', 'active']);
  });

  it('the last tick finishes the checklist', () => {
    const state = [{ status: 'done' as const }, { status: 'done' as const }, { status: 'active' as const }];
    expect(tick(steps, state, 'pr', rec(''), 1)).toMatchObject({ ok: true, outcome: 'finished' });
  });

  it('going back sends everything after the step back to pending, keeping each record as a previous run', () => {
    const state = [
      { status: 'done' as const, summary: 'built' },
      { status: 'done' as const, summary: 'tuned', previousRuns: [{ status: 'done' as const, summary: 'first try', endedAt: 1, reason: 'reopened' as const }] },
      { status: 'active' as const },
    ];
    const back = goBack(steps, state, 0, 9)!;
    expect(back.map((s) => s.status)).toEqual(['active', 'pending', 'pending']);
    expect(back[0].summary).toBeUndefined();
    expect(back[0].previousRuns).toEqual([{ status: 'done', summary: 'built', endedAt: 9, reason: 'went_back' }]);
    expect(back[1].previousRuns?.map((r) => r.summary)).toEqual(['first try', 'tuned']);
    expect(back[2].previousRuns?.[0]).toMatchObject({ status: 'active', reason: 'went_back' });
    expect(goBack(steps, state, 2, 9)).toBeNull();
  });

  it('the user reopening a gate keeps its record and where it began', () => {
    const state = [{ status: 'awaiting_approval' as const, summary: 's', startHead: 'h1', startMessageUuid: 'm1', reviews: [] }];
    const reopened = userReopen(state, 0, 5)!;
    expect(reopened[0]).toMatchObject({ status: 'active', startHead: 'h1', startMessageUuid: 'm1' });
    expect(reopened[0].summary).toBeUndefined();
    expect(reopened[0].previousRuns?.[0]).toMatchObject({ summary: 's', reason: 'reopened', endedAt: 5 });
    expect(userReopen([{ status: 'done' }], 0, 5)).toBeNull();
  });

  it('a gate is waiting until a review reads it, and nothing once removed', () => {
    const at = (s: Record<string, unknown>) => [{ status: 'done' as const }, { ...s, status: 'awaiting_approval' as const }];
    expect(gateOf({ state: at({}), removedAt: null })).toBe('waiting');
    expect(gateOf({ state: at({ reviewing: true }), removedAt: null })).toBe('reviewing');
    expect(gateOf({ state: at({}), removedAt: 1 })).toBeNull();
    expect(gateOf({ state: initialState(steps), removedAt: null })).toBeNull();
  });
});

describe('decideTurnEnd', () => {
  it('waits while paused, busy, finished or at a gate', () => {
    expect(decideTurnEnd(harness({ paused: true }), idle)).toEqual({ kind: 'wait', reason: 'paused' });
    expect(decideTurnEnd(harness(), { ...idle, decisionPending: true })).toEqual({ kind: 'wait', reason: 'busy' });
    expect(decideTurnEnd(harness(), { ...idle, backgroundWork: true })).toEqual({ kind: 'wait', reason: 'busy' });
    const done = steps.map(() => ({ status: 'done' as const }));
    expect(decideTurnEnd(harness({ state: done }), idle)).toEqual({ kind: 'wait', reason: 'finished' });
    const gate = [{ status: 'done' as const }, { status: 'awaiting_approval' as const }, { status: 'pending' as const }];
    expect(decideTurnEnd(harness({ state: gate }), idle)).toEqual({ kind: 'wait', reason: 'awaiting_approval' });
  });

  it('advances after a tick and asks the watcher without one', () => {
    const state = [{ status: 'done' as const }, { status: 'active' as const }, { status: 'pending' as const }];
    expect(decideTurnEnd(harness({ state }), { ...idle, tickedThisTurn: true })).toEqual({ kind: 'advance', index: 1 });
    expect(decideTurnEnd(harness({ state }), idle)).toEqual({ kind: 'ask_watcher', index: 1, afterTick: false });
    // Prose after the tick may be a real question from the next step.
    expect(decideTurnEnd(harness({ state }), { ...idle, tickedThisTurn: true, spokeAfterTick: true }))
      .toEqual({ kind: 'ask_watcher', index: 1, afterTick: true });
  });

  it('pauses itself at the caps', () => {
    expect(decideTurnEnd(harness({ autoRounds: MAX_AUTO_ROUNDS }), { ...idle, tickedThisTurn: true }).kind).toBe('pause');
    expect(decideTurnEnd(harness({ idleNudges: MAX_IDLE_NUDGES }), idle).kind).toBe('pause');
    // A tick is progress: the nudge cap does not stop it.
    expect(decideTurnEnd(harness({ idleNudges: MAX_IDLE_NUDGES }), { ...idle, tickedThisTurn: true }).kind).toBe('advance');
  });
});

describe('parseWatcherReply', () => {
  it('reads only a clear CONTINUE as continue', () => {
    expect(parseWatcherReply('CONTINUE')).toEqual({ continue: true });
    expect(parseWatcherReply('continue\n(because…)')).toEqual({ continue: true });
    expect(parseWatcherReply('STOP: needs the Figma link')).toEqual({ continue: false, reason: 'needs the Figma link' });
    expect(parseWatcherReply('I think it should go on')).toMatchObject({ continue: false });
    expect(parseWatcherReply('')).toMatchObject({ continue: false });
  });
});

describe('validateTemplate', () => {
  const ok = { name: 'x', tags: [], inputs: [{ key: 'figma', label: 'Figma' }], steps };
  it('accepts a sound template and names what is wrong otherwise', () => {
    expect(validateTemplate(ok)).toBeNull();
    expect(validateTemplate({ ...ok, name: ' ' })).toMatch(/name/);
    expect(validateTemplate({ ...ok, steps: [] })).toMatch(/at least one step/);
    expect(validateTemplate({ ...ok, steps: [steps[0], steps[0]] })).toMatch(/twice/);
    expect(validateTemplate({ ...ok, inputs: [{ key: 'a b', label: 'x' }] })).toMatch(/key/);
    expect(validateTemplate({ ...ok, steps: [{ ...steps[0], mode: 'maybe' }] })).toMatch(/mode/);
  });
});

function makeService(over: Partial<HarnessDeps> = {}) {
  const db = openTmpDb('harness');
  const sent: string[] = [];
  const published: (SessionHarness | null)[] = [];
  const deps: HarnessDeps = {
    db,
    isEnabled: () => true,
    cwdOf: () => '/tmp',
    decisionPending: () => false,
    backgroundWork: () => false,
    isWaiting: () => true,
    send: (_id, text) => {
      sent.push(text);
      return `uuid-${sent.length}`;
    },
    askWatcher: async () => 'CONTINUE',
    askDrafter: async () => '',
    askReviewer: async () => '',
    // Not a repository unless a test says so: commit-per-step then does nothing.
    git: async () => ({ ok: false, output: 'not a git repository' }),
    publish: (_id, h) => void published.push(h),
    defer: (fn) => fn(),
    ...over,
  };
  const service = new HarnessService(deps);
  const template = service.createTemplate({
    name: 'New component', description: '', tags: ['ui'],
    inputs: [{ key: 'name', label: 'Name' }, { key: 'figma', label: 'Figma' }], steps,
  });
  if (!template.ok) throw new Error(template.error);
  return { db, service, sent, published, templateId: template.value.id };
}

describe('HarnessService', () => {
  it('attaches a snapshot with the inputs filled in', () => {
    const { service, templateId } = makeService();
    const r = service.attach('s1', templateId, { name: 'Input', figma: 'f://1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.harness.steps[0].title).toBe('Build Input');
    expect(r.value.kickoff).toContain('Build it from f://1.');
    expect(service.attach('s1', templateId, {})).toMatchObject({ ok: false, status: 409 });
    // Editing the template leaves the session's snapshot alone.
    service.updateTemplate(templateId, { name: 'Renamed', tags: [], inputs: [], steps: [steps[2]] });
    expect(service.get('s1')?.steps).toHaveLength(3);
  });

  it('a tick then a turn end sends the next step', async () => {
    const { service, sent, templateId } = makeService();
    service.attach('s1', templateId, {});
    expect(await service.completeStep('s1', 'build', rec('rendered'))).toMatch(/^Ticked/);
    await service.handleTurnEnd('s1');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('step 2 of 3');
    expect(service.get('s1')?.autoRounds).toBe(1);
  });

  it('a tick followed by a question asks the watcher before advancing', async () => {
    const { service, sent, templateId } = makeService({ askWatcher: async () => 'STOP: needs the colour' });
    service.attach('s1', templateId, {});
    await service.completeStep('s1', 'build', rec(''));
    service.feed('s1', [{ id: 'a1', role: 'assistant', text: 'Built. For the API: red or blue?' } as never]);
    await service.handleTurnEnd('s1');
    expect(sent).toEqual([]);
    expect(service.get('s1')?.idleNudges).toBe(0);
  });

  it('a failing verify does not tick', async () => {
    const withVerify = steps.map((s, i) => (i === 0 ? { ...s, verify: 'npm test' } : s));
    const { service } = makeService({ runVerify: async () => ({ ok: false, output: '2 failed' }) });
    const t = service.createTemplate({ name: 'v', description: '', tags: [], inputs: [], steps: withVerify });
    if (!t.ok) throw new Error();
    service.attach('s1', t.value.id, {});
    const reply = await service.completeStep('s1', 'build', rec(''));
    expect(reply).toContain('2 failed');
    expect(service.get('s1')?.state[0].status).toBe('active');
  });

  it('without a tick the watcher decides, and a stop sends nothing', async () => {
    const stop = makeService({ askWatcher: async () => 'STOP: needs the ticket' });
    stop.service.attach('s1', stop.templateId, {});
    await stop.service.handleTurnEnd('s1');
    expect(stop.sent).toEqual([]);
    expect(stop.service.events('s1')[0]).toMatchObject({ kind: 'watcher_stop' });

    const go = makeService();
    go.service.attach('s1', go.templateId, {});
    await go.service.handleTurnEnd('s1');
    expect(go.sent[0]).toContain('not ticked yet');
    expect(go.service.get('s1')?.idleNudges).toBe(1);
  });

  it('a failed watcher call reads as a stop', async () => {
    const onError = vi.fn();
    const { service, sent, templateId } = makeService({ askWatcher: async () => { throw new Error('down'); }, onError });
    service.attach('s1', templateId, {});
    await service.handleTurnEnd('s1');
    expect(sent).toEqual([]);
    expect(onError).toHaveBeenCalled();
  });

  it('pauses after the nudge cap, and the user typing resets the count', async () => {
    const { service, sent, templateId } = makeService();
    service.attach('s1', templateId, {});
    await service.handleTurnEnd('s1');
    // Orbital's own nudge coming back as a user entry is not the user.
    service.feed('s1', [{ id: 'u1', role: 'user', text: sent[0] } as never]);
    expect(service.get('s1')?.idleNudges).toBe(1);
    service.feed('s1', [{ id: 'u2', role: 'user', text: 'use the other icon' } as never]);
    expect(service.get('s1')?.idleNudges).toBe(0);
    for (let n = 0; n <= MAX_IDLE_NUDGES; n++) await service.handleTurnEnd('s1');
    const h = service.get('s1');
    expect(h?.paused).toBe(true);
    expect(h?.state[0].nudges).toBe(MAX_IDLE_NUDGES + 1);
    expect(h?.pauseReason).toMatch(/^Stuck: /);
    expect(h?.pauseKind).toBe('nudge_cap');
  });

  it('does nothing when the feature is off or the user already started a turn', async () => {
    const off = makeService({ isEnabled: () => false });
    off.service.attach('s1', off.templateId, {});
    await off.service.handleTurnEnd('s1');
    expect(off.sent).toEqual([]);
    expect(off.service.tools('s1')).toBeUndefined();

    const busy = makeService({ isWaiting: () => false });
    busy.service.attach('s1', busy.templateId, {});
    await busy.service.completeStep('s1', 'build', rec(''));
    await busy.service.handleTurnEnd('s1');
    expect(busy.sent).toEqual([]);
  });

  it('exposes its tools pre-approved', () => {
    const { service } = makeService();
    expect(service.tools('s1')?.allowedTools).toEqual([
      'mcp__orbital__harness_status', 'mcp__orbital__harness_complete_step', 'mcp__orbital__harness_save_template',
      'mcp__orbital__harness_propose',
    ]);
  });
});

describe('harness routes', () => {
  function makeApp(enabled = true, over: Partial<HarnessDeps> = {}) {
    const made = makeService(over);
    const errors = { record: vi.fn() };
    const delivered: string[] = [];
    const deliver = vi.fn(async (_id: string, text: string) => {
      delivered.push(text);
      return { outcome: 'sent' as const, uuid: `d-${delivered.length}` };
    });
    const app = Fastify();
    registerHarnessRoutes(app, {
      harness: made.service,
      errors,
      settings: { get: (k: string) => (k === 'harness_enabled' && enabled ? 'true' : ''), set: () => {} },
    } as never, deliver, (id) => (id === 'known' ? [{ id: 'u', role: 'user', text: 'build the Input' } as never] : null));
    return { ...made, app, delivered, deliver, errors };
  }

  it('template CRUD validates and round-trips', async () => {
    const { app } = makeApp();
    const bad = await app.inject({ method: 'POST', url: '/api/harness/templates', payload: { name: 'x', tags: [], inputs: [], steps: [] } });
    expect(bad.statusCode).toBe(400);
    const created = await app.inject({ method: 'POST', url: '/api/harness/templates', payload: { name: 'Fix', tags: ['bug'], inputs: [], steps } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    const put = await app.inject({ method: 'PUT', url: `/api/harness/templates/${id}`, payload: { name: 'Fix it', tags: [], inputs: [], steps } });
    expect(put.json().name).toBe('Fix it');
    expect((await app.inject({ method: 'PUT', url: '/api/harness/templates/999', payload: { name: 'x', tags: [], inputs: [], steps } })).statusCode).toBe(404);
    const list = await app.inject({ method: 'GET', url: '/api/harness/templates' });
    expect(list.json().templates.map((t: { name: string }) => t.name)).toContain('Fix it');
    expect((await app.inject({ method: 'DELETE', url: `/api/harness/templates/${id}` })).statusCode).toBe(204);
  });

  it('stores a project scope as the resolved repository root, so sessions in it match', async () => {
    const { app } = makeApp();
    const repo = realpathSync(makeTmpDir('scoped'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    mkdirSync(join(repo, 'packages'));
    const link = join(makeTmpDir('links'), 'repo');
    symlinkSync(repo, link);
    const created = await app.inject({
      method: 'POST', url: '/api/harness/templates',
      payload: { name: 'Scoped', tags: [], inputs: [], steps, scope: { kind: 'project', root: join(link, 'packages') } },
    });
    expect(created.json().scope).toMatchObject({ kind: 'project', root: repo });
  });

  it('attaching delivers the kickoff; approving a gate delivers the next step', async () => {
    const { app, service, delivered, templateId } = makeApp();
    const attached = await app.inject({ method: 'POST', url: '/api/sessions/s1/harness', payload: { templateId, inputs: { name: 'Input', figma: 'f://1' } } });
    expect(attached.statusCode).toBe(201);
    expect(delivered[0]).toContain('Build Input');
    await service.completeStep('s1', 'build', rec(''));
    await service.completeStep('s1', 'api', rec(''));
    const early = await app.inject({ method: 'POST', url: '/api/sessions/s1/harness/steps/0/approve' });
    expect(early.statusCode).toBe(409);
    const ok = await app.inject({ method: 'POST', url: '/api/sessions/s1/harness/steps/1/approve' });
    expect(ok.statusCode).toBe(200);
    expect(delivered[1]).toContain('step 3 of 3');
    const paused = await app.inject({ method: 'PATCH', url: '/api/sessions/s1/harness', payload: { paused: true } });
    expect(paused.json().harness.paused).toBe(true);
  });

  it('refuses to attach while the feature is off, and undoes an attach nobody can receive', async () => {
    const off = makeApp(false);
    const r = await off.app.inject({ method: 'POST', url: '/api/sessions/s1/harness', payload: { templateId: off.templateId, inputs: { name: 'n', figma: 'f' } } });
    expect(r.statusCode).toBe(403);

    const terminal = makeApp();
    terminal.deliver.mockResolvedValueOnce({ outcome: 'terminal' } as never);
    const t = await terminal.app.inject({ method: 'POST', url: '/api/sessions/s1/harness', payload: { templateId: terminal.templateId, inputs: { name: 'n', figma: 'f' } } });
    expect(t.statusCode).toBe(409);
    expect(terminal.service.get('s1')).toBeNull();
  });
});

const draftJson = JSON.stringify({ name: 'Bug fix', description: 'd', tags: ['bug'], inputs: [], steps });

describe('parseDraftReply', () => {
  it('reads a fenced block, bare JSON, or JSON inside prose', () => {
    expect(parseDraftReply('```json\n' + draftJson + '\n```')).toMatchObject({ ok: true, template: { name: 'Bug fix' } });
    expect(parseDraftReply(draftJson)).toMatchObject({ ok: true });
    expect(parseDraftReply(`Here it is: ${draftJson} Enjoy.`)).toMatchObject({ ok: true });
  });

  it('names what is wrong otherwise', () => {
    expect(parseDraftReply('no json here')).toMatchObject({ ok: false, error: /no JSON/ });
    expect(parseDraftReply('{"name": ')).toMatchObject({ ok: false, error: /did not parse/ });
    expect(parseDraftReply(JSON.stringify({ name: 'x', steps: [] }))).toMatchObject({ ok: false, error: /at least one step/ });
    expect(parseDraftReply('[1,2]')).toMatchObject({ ok: false });
  });
});

describe('draftTemplate', () => {
  it('retries once with the error, then gives up', async () => {
    const ask = vi.fn().mockResolvedValueOnce('nope').mockResolvedValueOnce(draftJson);
    expect(await draftTemplate(ask, 'p')).toMatchObject({ ok: true });
    expect(ask.mock.calls[1][0]).toMatch(/not a valid template: the reply held no JSON/);
    const bad = vi.fn().mockResolvedValue('nope');
    expect(await draftTemplate(bad, 'p')).toMatchObject({ ok: false });
    expect(bad).toHaveBeenCalledTimes(2);
  });
});

describe('digestTranscript', () => {
  const long = 'x'.repeat(5000);
  const messages = [
    { id: '1', role: 'user', text: `Build it ${long}` },
    { id: '2', role: 'assistant', text: long },
    { id: '3', role: 'tool_use', toolName: 'Bash', toolInput: { command: 'npm test' } },
    { id: '4', role: 'user', text: 'no, use tokens' },
  ] as never[];

  it('keeps user messages whole and trims the agent', () => {
    const digest = digestTranscript(messages);
    expect(digest).toContain(`USER: Build it ${long}`);
    expect(digest).toContain('tool Bash: npm test');
    expect(digest).toContain('USER: no, use tokens');
    expect(digest).not.toContain(long + long);
  });

  it('drops tool lines before cutting, and never exceeds the cap', () => {
    const digest = digestTranscript(messages, digestTranscript(messages).length - 1);
    expect(digest).not.toContain('tool Bash');
    expect(digest).toContain('no, use tokens');
    expect(digestTranscript(messages, 1000).length).toBeLessThanOrEqual(1000);
  });

  it('the prompt carries what it was given and the templates that exist', () => {
    const prompt = buildDraftPrompt({ description: 'components', digest: 'USER: hi', existing: ['New component'] });
    expect(prompt).toContain('components');
    expect(prompt).toContain('USER: hi');
    expect(prompt).toContain('New component');
  });
});

describe('drafting routes and the save tool', () => {
  it('drafts from a description or a session, and reports a bad draft', async () => {
    const asked: string[] = [];
    const { app } = (() => {
      const made = makeAppFor({ askDrafter: async (p) => { asked.push(p); return draftJson; } });
      return made;
    })();
    expect((await app.inject({ method: 'POST', url: '/api/harness/templates/draft', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/harness/templates/draft', payload: { sessionId: 'gone' } })).statusCode).toBe(404);
    const r = await app.inject({ method: 'POST', url: '/api/harness/templates/draft', payload: { sessionId: 'known', description: 'fix bugs' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().template.name).toBe('Bug fix');
    expect(asked[0]).toContain('build the Input');
    expect(asked[0]).toContain('fix bugs');
    // Nothing was saved: the draft goes to the editor.
    expect((await app.inject({ method: 'GET', url: '/api/harness/templates' })).json().templates).toHaveLength(1);

    const bad = makeAppFor({ askDrafter: async () => 'nope' });
    expect((await bad.app.inject({ method: 'POST', url: '/api/harness/templates/draft', payload: { description: 'x' } })).statusCode).toBe(422);
    const down = makeAppFor({ askDrafter: async () => { throw new Error('offline'); } });
    const failed = await down.app.inject({ method: 'POST', url: '/api/harness/templates/draft', payload: { description: 'x' } });
    expect(failed.statusCode).toBe(502);
    expect(down.errors.record).toHaveBeenCalled();
  });

  it('serves the interview prompt naming the save tool', async () => {
    const { app } = makeAppFor({});
    expect((await app.inject({ method: 'GET', url: '/api/harness/interview' })).json().prompt).toContain('mcp__orbital__harness_save_template');
  });

  function makeAppFor(over: Partial<HarnessDeps>) {
    const made = makeService(over);
    const errors = { record: vi.fn() };
    const app = Fastify();
    registerHarnessRoutes(app, {
      harness: made.service, errors, settings: { get: () => 'true', set: () => {} },
    } as never, vi.fn(), (id) => (id === 'known' ? [{ id: 'u', role: 'user', text: 'build the Input' } as never] : null));
    return { ...made, app, errors };
  }
});

import { normalizeOptions } from '../src/harness/logic.js';
import { parseReviewReply, reviewerMayRun } from '../src/harness/reviewer.js';

describe('options', () => {
  it('fills what is missing or malformed with the defaults', () => {
    expect(normalizeOptions(undefined)).toEqual(DEFAULT_OPTIONS);
    expect(normalizeOptions({ lucky: true, maxAutoRounds: -3, maxIdleNudges: 1.5, commitPerStep: 'yes' }))
      .toEqual({ ...DEFAULT_OPTIONS, lucky: true });
    expect(normalizeOptions({ maxAutoRounds: 0 }).maxAutoRounds).toBe(0);
  });

  it('caps come from the options, and lucky lifts the round cap only', () => {
    const tight = { ...DEFAULT_OPTIONS, maxAutoRounds: 3, maxIdleNudges: 1 };
    expect(decideTurnEnd(harness({ options: tight, autoRounds: 3 }), { ...idle, tickedThisTurn: true }).kind).toBe('pause');
    expect(decideTurnEnd(harness({ options: { ...tight, lucky: true }, autoRounds: 999 }), { ...idle, tickedThisTurn: true }).kind).toBe('advance');
    expect(decideTurnEnd(harness({ options: { ...tight, lucky: true }, idleNudges: 1 }), idle).kind).toBe('pause');
  });

  it('with lucky a waiting gate is reviewed, until the reopen cap', () => {
    const gate = [{ status: 'done' as const }, { status: 'awaiting_approval' as const }, { status: 'pending' as const }];
    const lucky = { ...DEFAULT_OPTIONS, lucky: true, maxReviewerReopens: 2 };
    expect(decideTurnEnd(harness({ state: gate, options: lucky }), idle)).toEqual({ kind: 'review', index: 1 });
    const worn = gate.map((s, i) => (i === 1 ? { ...s, reviewerReopens: 2 } : s));
    expect(decideTurnEnd(harness({ state: worn, options: lucky }), idle)).toEqual({ kind: 'wait', reason: 'awaiting_approval' });
  });
});

describe('the reviewer', () => {
  const verdict = { verdict: 'reopen', uncertain: false, reasoning: 'Padding is off.', checked: ['Input.tsx'], findings: ['padding 6px, should be 4px'] };

  it('reads the last JSON block of its reply', () => {
    const raw = 'Looked at `{"a":1}`\n```json\n{"x":1}\n```\nDone.\n```json\n' + JSON.stringify(verdict) + '\n```';
    expect(parseReviewReply(raw)).toEqual({ ok: true, review: verdict });
    expect(parseReviewReply(JSON.stringify({ ...verdict, verdict: 'maybe' }))).toMatchObject({ ok: false });
    expect(parseReviewReply(JSON.stringify({ ...verdict, reasoning: '' }))).toMatchObject({ ok: false });
    expect(parseReviewReply('I think it is fine')).toMatchObject({ ok: false });
  });

  it('may only look and run checks', () => {
    for (const ok of ['git diff abc..def', 'git log --oneline -5', 'cat src/a.ts', 'npm test', 'yarn run lint', 'npx vitest run x', 'rg foo src']) {
      expect(reviewerMayRun(ok), ok).toBe(true);
    }
    for (const no of ['git commit -am x', 'git push', 'rm -rf src', 'npm install', 'cat a > b', 'git diff; rm x', 'ls $(pwd)', 'npm test && git push']) {
      expect(reviewerMayRun(no), no).toBe(false);
    }
  });
});

describe('step records and lucky, in the service', () => {
  const gateFirst: HarnessStep[] = [
    { id: 'api', title: 'Tune the API', instructions: 'Tune.', mode: 'gate', doneWhen: 'good' },
    { id: 'pr', title: 'PR', instructions: 'Prepare.', mode: 'auto', doneWhen: 'ready' },
  ];
  const approveReply = '```json\n{"verdict":"approve","uncertain":true,"reasoning":"Looks right.","checked":["diff"],"findings":[]}\n```';
  const reopenReply = '```json\n{"verdict":"reopen","uncertain":false,"reasoning":"Missing size.","checked":["Input.tsx"],"findings":["add size lg"]}\n```';

  function lucky(over: Partial<HarnessDeps> = {}, heads = ['aaa', 'bbb']) {
    let n = 0;
    const made = makeService({
      git: async (_cwd, args) =>
        args[0] === 'rev-parse' ? { ok: true, output: heads[Math.min(n++, heads.length - 1)] + '\n' }
          : args[0] === 'status' ? { ok: true, output: '' }
            : { ok: true, output: `git ${args.join(' ')}` },
      ...over,
    });
    const t = made.service.createTemplate({ name: 'L', description: '', tags: [], inputs: [], steps: gateFirst, options: { ...DEFAULT_OPTIONS, lucky: true, maxReviewerReopens: 1 } });
    if (!t.ok) throw new Error(t.error);
    made.service.attach('s1', t.value.id, {});
    return made;
  }

  it('records heads, the starting message and the agent\'s decisions', async () => {
    const { service } = lucky();
    await service.stepStarted('s1', 0, 'm-1');
    await service.completeStep('s1', 'api', {
      summary: 'Closed size set', decisions: [{ what: 'size is sm|md|lg', why: 'legacy uses only these' }], openQuestions: ['icon slot?'],
    });
    const step = service.get('s1')!.state[0];
    expect(step).toMatchObject({
      status: 'awaiting_approval', startHead: 'aaa', endHead: 'bbb', startMessageUuid: 'm-1',
      summary: 'Closed size set', openQuestions: ['icon slot?'],
    });
    expect(await service.diff('s1', 0)).toMatchObject({ ok: true, value: { range: 'aaa..bbb' } });
    expect(await service.diff('s1', 1)).toMatchObject({ ok: false, status: 409 });
  });

  it('counts the step\'s commits and says whether a remote branch holds them', async () => {
    const answers = (remote: string) => {
      const heads = ['aaa', 'bbb'];
      let n = 0;
      return async (_cwd: string, args: string[]) => {
        if (args[0] === 'rev-list') return { ok: true, output: '3\n' };
        if (args[0] === 'branch') return { ok: true, output: remote };
        if (args[0] === 'rev-parse') return { ok: true, output: `${heads[Math.min(n++, 1)]}\n` };
        return { ok: true, output: '' };
      };
    };
    for (const [remote, pushed] of [['', false], ['  origin/feat/button\n', true]] as const) {
      const { service } = lucky({ git: answers(remote) });
      await service.stepStarted('s1', 0, 'm-1');
      await service.completeStep('s1', 'api', { summary: 'done', decisions: [], openQuestions: [] });
      expect(await service.diff('s1', 0)).toMatchObject({ ok: true, value: { range: 'aaa..bbb', commits: 3, pushed } });
    }
  });

  it('refuses a tick over uncommitted changes when commit-per-step is on', async () => {
    const { service } = lucky({ git: async (_c, args) => ({ ok: true, output: args[0] === 'status' ? ' M src/Input.tsx' : 'h' }) });
    const reply = await service.completeStep('s1', 'api', rec('x'));
    expect(reply).toMatch(/uncommitted/);
    expect(service.get('s1')!.state[0].status).toBe('active');
  });

  it('an approving review moves on and says it was the reviewer, uncertain included', async () => {
    const { service, sent } = lucky({ askReviewer: async () => approveReply });
    const deliver = vi.fn(async (_id: string, _text: string) => ({ outcome: 'sent' as const, uuid: 'm-2' }));
    service.useDelivery(deliver);
    await service.completeStep('s1', 'api', rec('done'));
    await service.handleTurnEnd('s1');
    const h = service.get('s1')!;
    expect(h.state[0]).toMatchObject({ status: 'done', approvedBy: 'reviewer' });
    expect(h.state[0].reviews?.[0]).toMatchObject({ verdict: 'approve', uncertain: true, reasoning: 'Looks right.' });
    expect(h.state[1]).toMatchObject({ status: 'active', startMessageUuid: 'm-2' });
    expect(deliver.mock.calls[0][1]).toContain('step 2 of 2');
    expect(sent).toEqual([]);
  });

  it('a reopening review sends the findings back, and past the cap waits for the user', async () => {
    const { service } = lucky({ askReviewer: async () => reopenReply });
    const deliver = vi.fn(async (_id: string, _text: string) => ({ outcome: 'sent' as const, uuid: 'x' }));
    service.useDelivery(deliver);
    await service.completeStep('s1', 'api', rec('first'));
    await service.handleTurnEnd('s1');
    let step = service.get('s1')!.state[0];
    expect(step).toMatchObject({ status: 'active', reviewerReopens: 1 });
    expect(deliver.mock.calls[0][1]).toContain('add size lg');
    await service.completeStep('s1', 'api', rec('second'));
    // The cap is 1: the gate is now the user's.
    await service.handleTurnEnd('s1');
    step = service.get('s1')!.state[0];
    expect(step.status).toBe('awaiting_approval');
    expect(step.reviews).toHaveLength(1);
  });

  it('a review that fails leaves the gate to the user, paused with the reason', async () => {
    const { service } = lucky({ askReviewer: async () => 'no verdict here' });
    await service.completeStep('s1', 'api', rec('x'));
    await service.handleTurnEnd('s1');
    const h = service.get('s1')!;
    expect(h.state[0].status).toBe('awaiting_approval');
    expect(h.paused).toBe(true);
    expect(h.pauseReason).toMatch(/reviewer could not decide/);
  });

  it('the user deciding during the review wins', async () => {
    let release!: () => void;
    const { service } = lucky({ askReviewer: () => new Promise((r) => { release = () => r(approveReply); }) });
    service.useDelivery(async () => ({ outcome: 'sent' as const, uuid: 'x' }));
    await service.completeStep('s1', 'api', rec('x'));
    const reviewing = service.handleTurnEnd('s1');
    await vi.waitFor(() => expect(release).toBeDefined());
    service.reopen('s1', 0);
    release();
    await reviewing;
    expect(service.get('s1')!.state[0]).toMatchObject({ status: 'active' });
    expect(service.get('s1')!.state[0].reviews).toBeUndefined();
  });

  it('turning lucky on reviews a gate already waiting', async () => {
    const made = makeService({ askReviewer: async () => approveReply });
    made.service.useDelivery(async () => ({ outcome: 'sent' as const, uuid: 'x' }));
    const t = made.service.createTemplate({ name: 'G', description: '', tags: [], inputs: [], steps: gateFirst });
    if (!t.ok) throw new Error();
    made.service.attach('s1', t.value.id, {});
    await made.service.completeStep('s1', 'api', rec('x'));
    expect(made.service.get('s1')!.options.lucky).toBe(false);
    made.service.setOptions('s1', { lucky: true });
    await vi.waitFor(() => expect(made.service.get('s1')!.state[0].status).toBe('done'));
  });
});

describe('the step commit needs no card', () => {
  it('recognises a local commit and nothing more', () => {
    for (const ok of ['git commit -m "x"', 'git add math.mjs && git commit -m "Add divide"', 'git add -A && git commit -am "step: api"']) {
      expect(isLocalCommit(ok), ok).toBe(true);
    }
    for (const no of ['git push', 'git commit --amend -m x', 'git add . && git push', 'git commit -m x; rm -rf .', 'git commit --no-verify -m x', 'rm x && git commit -m y', 'git reset --hard']) {
      expect(isLocalCommit(no), no).toBe(false);
    }
  });

  it('is allowed only while the session has a harness that commits per step', () => {
    const { service, templateId } = makeService();
    const commit = { command: 'git commit -m x' };
    expect(service.allowsWithoutAsking('s1', 'Bash', commit)).toBe(false);
    service.attach('s1', templateId, {});
    expect(service.allowsWithoutAsking('s1', 'Bash', commit)).toBe(true);
    expect(service.allowsWithoutAsking('s1', 'Write', commit)).toBe(false);
    service.setOptions('s1', { commitPerStep: false });
    expect(service.allowsWithoutAsking('s1', 'Bash', commit)).toBe(false);
  });

  it('allows a step\'s own verify command, exactly', async () => {
    const { service } = makeService();
    const t = service.createTemplate({ name: 'v', description: '', tags: [], inputs: [], steps: [{ ...steps[0], verify: 'node math.test.mjs' }] });
    if (!t.ok) throw new Error();
    service.attach('s1', t.value.id, {});
    expect(service.allowsWithoutAsking('s1', 'Bash', { command: 'node math.test.mjs' })).toBe(true);
    expect(service.allowsWithoutAsking('s1', 'Bash', { command: 'node math.test.mjs && rm -rf .' })).toBe(false);
  });
});

describe('the project a session belongs to', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

  it('is the repository root, for its worktrees too, and the directory itself outside git', () => {
    const base = realpathSync(makeTmpDir('project'));
    const repo = join(base, 'orbital');
    mkdirSync(join(repo, 'server', 'src'), { recursive: true });
    git(repo, 'init', '-q');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x');
    git(repo, 'worktree', 'add', '-q', join(repo, '.claude', 'worktrees', 'tray'));
    git(repo, 'worktree', 'add', '-q', join(base, 'elsewhere'));
    expect(projectRootOf(join(repo, 'server', 'src'))).toBe(repo);
    expect(projectRootOf(join(repo, '.claude', 'worktrees', 'tray'))).toBe(repo);
    expect(projectRootOf(join(base, 'elsewhere'))).toBe(repo);
    const plain = join(base, 'plain');
    mkdirSync(plain);
    expect(projectRootOf(plain)).toBe(plain);
  });
});

describe('template scope and drafts', () => {
  const body = (name: string, over: Record<string, unknown> = {}) => ({ name, description: '', tags: [], inputs: [], steps, ...over });

  it('offers a session its project\'s saved templates first, then global ones, never another project\'s', () => {
    const { service } = makeService({ cwdOf: (id) => (id === 'in-orbital' ? '/work/orbital' : '/work/billing') });
    service.createTemplate(body('Orbital only', { scope: { kind: 'project', root: '/work/orbital' } }));
    service.createTemplate(body('Billing only', { scope: { kind: 'project', root: '/work/billing' } }));
    service.createTemplate(body('Orbital draft', { scope: { kind: 'project', root: '/work/orbital' }, draft: true }));
    const offered = service.templatesForSession('in-orbital');
    expect(offered.project).toEqual({ root: '/work/orbital', name: 'orbital' });
    expect(offered.templates.map((t) => t.name)).toEqual(['Orbital only', 'New component']);
    expect(offered.templates[0].scope).toEqual({ kind: 'project', root: '/work/orbital', name: 'orbital' });
    // Settings lists drafts, marked.
    const orbital = service.listTemplates({ scope: { project: '/work/orbital' } });
    expect(orbital.map((t) => [t.name, t.draft])).toEqual([['Orbital draft', true], ['Orbital only', false]]);
    expect(service.listTemplates({ scope: 'global' }).map((t) => t.name)).toEqual(['New component']);
  });

  it('a save keeps the scope it does not name, can move it, and clears the draft mark', () => {
    const { service } = makeService();
    const t = service.createTemplate(body('D', { scope: { kind: 'project', root: '/work/orbital' }, draft: true }));
    if (!t.ok) throw new Error(t.error);
    const saved = service.updateTemplate(t.value.id, body('D'));
    expect(saved).toMatchObject({ ok: true, value: { draft: false, scope: { kind: 'project', root: '/work/orbital' } } });
    expect(service.updateTemplate(t.value.id, body('D', { scope: { kind: 'global' } }))).toMatchObject({ ok: true, value: { scope: { kind: 'global' } } });
    expect(service.createTemplate(body('x', { scope: { kind: 'project', root: 'relative' } }))).toMatchObject({ ok: false, status: 400 });
    const copy = service.duplicateTemplate(t.value.id);
    expect(copy).toMatchObject({ ok: true, value: { name: 'D (copy)', draft: false, scope: { kind: 'global' } } });
  });

  it('the drafting conversation saves a draft into its scope, and saving again updates it', () => {
    const { service } = makeService({ cwdOf: () => '/work/billing' });
    service.noteInterview('talk', { kind: 'project', root: '/work/orbital' }, 'opus');
    const first = service.saveDraftFrom('talk', body('Bug fix'));
    const second = service.saveDraftFrom('talk', body('Bug fix v2'));
    expect(first).toMatchObject({ ok: true, value: { draft: true, scope: { kind: 'project', root: '/work/orbital' } } });
    if (!first.ok || !second.ok) throw new Error();
    expect(second.value.id).toBe(first.value.id);
    expect(service.templatesForSession('talk').templates.map((t) => t.name)).not.toContain('Bug fix v2');
    // Once the user saved it, the conversation's next save is a new draft.
    service.updateTemplate(first.value.id, body('Bug fix v2'));
    const third = service.saveDraftFrom('talk', body('Bug fix v3'));
    expect(third.ok && third.value.id).not.toBe(first.value.id);
    // Any other session saves into its own project.
    expect(service.saveDraftFrom('other', body('Other'))).toMatchObject({ ok: true, value: { scope: { kind: 'project', root: '/work/billing' }, draft: true } });
  });

  it('the interview route starts a drafting conversation in the scope\'s project, on the chosen model', async () => {
    const made = makeService();
    const launch = vi.fn(async (_opts: Record<string, unknown>) => ({ ok: true as const, sessionId: 'talk' }));
    const app = Fastify();
    registerHarnessRoutes(app, { harness: made.service, errors: { record: vi.fn() }, settings: { get: (k: string) => (k === 'harness_enabled' ? 'true' : '') } } as never, vi.fn(), () => null, launch);
    const res = await app.inject({ method: 'POST', url: '/api/harness/interview', payload: { model: 'sonnet', scope: { kind: 'project', root: '/work/orbital' } } });
    expect(res.statusCode).toBe(201);
    expect(launch.mock.calls[0][0]).toMatchObject({ cwd: '/work/orbital', model: 'sonnet', purpose: 'harness_draft' });
    expect(made.service.saveDraftFrom('talk', body('Saved'))).toMatchObject({ ok: true, value: { scope: { kind: 'project', root: '/work/orbital' } } });
    expect((await app.inject({ method: 'POST', url: '/api/harness/interview', payload: { model: 'haiku', cwd: '/x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/harness/interview', payload: {} })).statusCode).toBe(400);
  });

  it('the start route filters by the session, and the projects route lists where templates live', async () => {
    const made = makeService({ cwdOf: () => '/work/orbital' });
    made.service.createTemplate(body('Orbital only', { scope: { kind: 'project', root: '/work/orbital' } }));
    const app = Fastify();
    registerHarnessRoutes(app, { harness: made.service, errors: { record: vi.fn() }, settings: { get: () => 'true', set: () => {} } } as never, vi.fn(), () => null);
    const forSession = (await app.inject({ method: 'GET', url: '/api/harness/templates?sessionId=s1' })).json();
    expect(forSession.project.name).toBe('orbital');
    expect(forSession.templates.map((t: { name: string }) => t.name)).toEqual(['Orbital only', 'New component']);
    const projects = (await app.inject({ method: 'GET', url: '/api/harness/projects' })).json().projects;
    expect(projects).toEqual([{ root: '/work/orbital', name: 'orbital', lastAt: null, templates: 1 }]);
  });
});

describe('the redesigned run', () => {
  const gateFirst: HarnessStep[] = [
    { id: 'api', title: 'Tune the API', instructions: 'Tune.', mode: 'gate', doneWhen: 'good' },
    { id: 'pr', title: 'PR', instructions: 'Prepare.', mode: 'auto', doneWhen: 'ready' },
  ];
  const approveReply = '```json\n{"verdict":"approve","uncertain":false,"reasoning":"Fine.","checked":["diff"],"findings":[]}\n```';
  const reopenReply = '```json\n{"verdict":"reopen","uncertain":false,"reasoning":"Missing size.","checked":["x"],"findings":["add size lg"]}\n```';

  /** A gate-first harness with lucky on; the reviewer answers when `release` is called. */
  function held(over: Partial<HarnessDeps> = {}, reply = approveReply) {
    let release: (() => void) | undefined;
    let controller: AbortController | undefined;
    let model: string | undefined;
    const delivered: string[] = [];
    const made = makeService({
      askReviewer: (_p, _cwd, opts) => {
        controller = opts.abortController;
        model = opts.model;
        return new Promise((r) => { release = () => r(reply); });
      },
      ...over,
    });
    made.service.useDelivery(async (_id, text) => {
      delivered.push(text);
      return { outcome: 'sent', uuid: `d-${delivered.length}` };
    });
    const t = made.service.createTemplate({ name: 'L', description: '', tags: [], inputs: [], steps: gateFirst, options: { lucky: true } });
    if (!t.ok) throw new Error(t.error);
    made.service.attach('s1', t.value.id, {});
    return {
      ...made, delivered,
      release: () => release!(), started: () => release !== undefined,
      controller: () => controller!, model: () => model,
    };
  }

  it('the reviewer runs on the session\'s model unless the harness names one', async () => {
    const r = held({ modelOf: () => 'sonnet[1m]' });
    await r.service.completeStep('s1', 'api', rec('x'));
    void r.service.handleTurnEnd('s1');
    await vi.waitFor(() => expect(r.started()).toBe(true));
    expect(r.model()).toBe('sonnet[1m]');
    expect(normalizeOptions({ reviewerModel: ' opus ' }).reviewerModel).toBe('opus');
  });

  it('shows a review as REVIEWER READING, and "decide myself" stops it and keeps the gate for the user', async () => {
    const r = held();
    await r.service.completeStep('s1', 'api', rec('x'));
    const reviewing = r.service.handleTurnEnd('s1');
    await vi.waitFor(() => expect(r.started()).toBe(true));
    expect(gateOf(r.service.get('s1'))).toBe('reviewing');
    expect(r.service.decideMyself('s1', 0)).toMatchObject({ ok: true });
    expect(r.controller().signal.aborted).toBe(true);
    r.release();
    await reviewing;
    const h = r.service.get('s1')!;
    expect(h.state[0]).toMatchObject({ status: 'awaiting_approval', reviewerOff: true });
    expect(h.state[0].reviews).toBeUndefined();
    expect(gateOf(h)).toBe('waiting');
    expect(r.service.events('s1')[0]).toMatchObject({ kind: 'review_aborted', detail: { by: 'user', index: 0 } });
    // The next turn end leaves it to the user too.
    await r.service.handleTurnEnd('s1');
    expect(r.service.get('s1')!.state[0].reviewing).toBeUndefined();
    // Turning lucky on anew hands it back to the reviewer.
    r.service.setOptions('s1', { lucky: false });
    r.service.setOptions('s1', { lucky: true });
    await vi.waitFor(() => expect(r.service.get('s1')!.state[0].reviewing).toBe(true));
  });

  it('turning lucky off during a review stops it', async () => {
    const r = held();
    await r.service.completeStep('s1', 'api', rec('x'));
    void r.service.handleTurnEnd('s1');
    await vi.waitFor(() => expect(r.started()).toBe(true));
    r.service.setOptions('s1', { lucky: false });
    expect(r.controller().signal.aborted).toBe(true);
    expect(gateOf(r.service.get('s1'))).toBe('waiting');
    expect(r.service.events('s1').map((e) => e.kind)).toContain('review_aborted');
  });

  it('a review a restart cut off leaves the gate to the user', async () => {
    const r = held();
    await r.service.completeStep('s1', 'api', rec('x'));
    void r.service.handleTurnEnd('s1');
    await vi.waitFor(() => expect(r.started()).toBe(true));
    r.service.dispose();
    const next = new HarnessService({ db: r.db, publish: () => {}, isEnabled: () => true } as unknown as HarnessDeps);
    next.recover();
    expect(next.get('s1')!.state[0]).toMatchObject({ status: 'awaiting_approval', reviewerOff: true });
    expect(next.get('s1')!.state[0].reviewing).toBeUndefined();
    expect(next.events('s1')[0]).toMatchObject({ kind: 'review_aborted', detail: { by: 'restart' } });
  });

  it('paused with lucky on, a gate is still reviewed, but nothing is sent until auto-continue is back on', async () => {
    const r = held({ askReviewer: async () => approveReply });
    r.service.setPaused('s1', true);
    await r.service.completeStep('s1', 'api', rec('x'));
    await r.service.handleTurnEnd('s1');
    const h = r.service.get('s1')!;
    expect(h.state.map((s) => s.status)).toEqual(['done', 'active']);
    expect(h.state[0].approvedBy).toBe('reviewer');
    expect(r.delivered).toEqual([]);
    r.service.setPaused('s1', false);
    await vi.waitFor(() => expect(r.delivered).toHaveLength(1));
    expect(r.delivered[0]).toContain('step 2 of 2');
    await vi.waitFor(() => expect(r.service.get('s1')!.state[1].startMessageUuid).toBe('d-1'));
  });

  it('paused, a send-back holds its findings until auto-continue is back on', async () => {
    const r = held({ askReviewer: async () => reopenReply });
    r.service.setPaused('s1', true);
    await r.service.completeStep('s1', 'api', rec('x'));
    await r.service.handleTurnEnd('s1');
    expect(r.service.get('s1')!.state[0]).toMatchObject({ status: 'active', unsentFindings: true });
    expect(r.delivered).toEqual([]);
    r.service.setPaused('s1', false);
    await vi.waitFor(() => expect(r.delivered).toHaveLength(1));
    expect(r.delivered[0]).toContain('add size lg');
    expect(r.service.get('s1')!.state[0].unsentFindings).toBeUndefined();
  });

  it('removing keeps the records readable, and a new harness can be attached after', async () => {
    const { app, service, templateId } = routesApp();
    await app.inject({ method: 'POST', url: '/api/sessions/s1/harness', payload: { templateId, inputs: { name: 'n', figma: 'f' } } });
    await service.completeStep('s1', 'build', rec('built it'));
    expect((await app.inject({ method: 'DELETE', url: '/api/sessions/s1/harness' })).statusCode).toBe(204);
    const read = (await app.inject({ method: 'GET', url: '/api/sessions/s1/harness' })).json();
    expect(read.harness).toBeNull();
    expect(read.removed.state[0]).toMatchObject({ status: 'done', summary: 'built it' });
    expect(read.events[0]).toMatchObject({ kind: 'removed' });
    // Automation stops.
    expect(await service.completeStep('s1', 'api', rec())).toBe('This session has no harness.');
    const again = await app.inject({ method: 'POST', url: '/api/sessions/s1/harness', payload: { templateId, inputs: { name: 'n', figma: 'f' } } });
    expect(again.statusCode).toBe(201);
    expect(service.removed('s1')).toBeNull();
  });

  it('going back keeps the later steps\' records and logs it', async () => {
    const { app, service, templateId } = routesApp();
    await app.inject({ method: 'POST', url: '/api/sessions/s1/harness', payload: { templateId, inputs: { name: 'n', figma: 'f' } } });
    await service.completeStep('s1', 'build', rec('built'));
    await service.completeStep('s1', 'api', rec('tuned'));
    const back = await app.inject({ method: 'POST', url: '/api/sessions/s1/harness/steps/0/go-back' });
    expect(back.statusCode).toBe(200);
    const h = back.json().harness;
    expect(h.state.map((s: { status: string }) => s.status)).toEqual(['active', 'pending', 'pending']);
    expect(h.state[1].previousRuns[0]).toMatchObject({ summary: 'tuned', reason: 'went_back' });
    expect(service.events('s1')[0]).toMatchObject({ kind: 'went_back', detail: { index: 0 } });
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/harness/steps/2/go-back' })).statusCode).toBe(409);
  });

  it('every input is required unless its hint says optional', async () => {
    const { app, service } = routesApp();
    const t = service.createTemplate({ name: 'I', description: '', tags: [], steps, inputs: [{ key: 'a', label: 'Ticket' }, { key: 'b', label: 'Notes', hint: 'Optional' }] });
    if (!t.ok) throw new Error();
    const missing = await app.inject({ method: 'POST', url: '/api/sessions/s1/harness', payload: { templateId: t.value.id, inputs: {} } });
    expect(missing.json()).toEqual({ error: 'Ticket is required' });
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/harness', payload: { templateId: t.value.id, inputs: { a: 'X-1' } } })).statusCode).toBe(201);
  });

  it('records which user entries were Orbital\'s, by uuid', async () => {
    const { app, service, templateId } = routesApp();
    await app.inject({ method: 'POST', url: '/api/sessions/s1/harness', payload: { templateId, inputs: { name: 'n', figma: 'f' } } });
    await service.handleTurnEnd('s1');
    expect([...service.messagesOf('s1')]).toEqual([
      ['d-1', { kind: 'kickoff', step: 0 }],
      ['uuid-1', { kind: 'nudge', step: 0 }],
    ]);
  });

  it('a ticked event says whether a verify ran', async () => {
    const { service } = makeService({ runVerify: async () => ({ ok: true, output: '' }) });
    const t = service.createTemplate({ name: 'v', description: '', tags: [], inputs: [], steps: [{ ...steps[0], verify: 'npm test' }, steps[2]] });
    if (!t.ok) throw new Error();
    service.attach('s1', t.value.id, {});
    await service.completeStep('s1', 'build', rec('x'));
    await service.completeStep('s1', 'pr', rec('y'));
    const ticks = service.events('s1').filter((e) => e.kind === 'ticked').map((e) => e.detail.verify);
    // Newest first.
    expect(ticks).toEqual([null, 'passed']);
  });

  it('a session ending mid-run pauses its harness, and the new session carries it on from the current step', async () => {
    const { app, service, templateId, delivered } = routesApp();
    await app.inject({ method: 'POST', url: '/api/sessions/s1/harness', payload: { templateId, inputs: { name: 'n', figma: 'f' } } });
    await service.completeStep('s1', 'build', rec('built'));
    service.sessionEnded('s1');
    const paused = service.get('s1')!;
    expect(paused).toMatchObject({ paused: true, pauseKind: 'session_ended' });
    expect(paused.pauseReason).toMatch(/step 2/);
    const carried = await app.inject({ method: 'POST', url: '/api/sessions/s2/harness/carry', payload: { fromSessionId: 's1' } });
    expect(carried.statusCode).toBe(200);
    const h = carried.json().harness;
    expect(h).toMatchObject({ sessionId: 's2', paused: false, pauseKind: null });
    expect(h.state[0]).toMatchObject({ status: 'done', summary: 'built' });
    expect(h.state[1]).toMatchObject({ status: 'active', startMessageUuid: 'd-2' });
    expect(delivered[1]).toContain('## Step 2: Tune the API');
    expect(service.get('s1')).toBeNull();
    expect(service.removed('s1')!.state[0].summary).toBe('built');
    const log = service.events('s2').map((e) => e.kind);
    expect(log[0]).toBe('carried_over');
    expect(log).toContain('ticked');
  });

  it('a waiting gate makes a sleeping session need input, and a review does not', () => {
    const { db, service, templateId } = makeService();
    service.attach('s1', templateId, {});
    const ctx = { db, runner: { status: () => undefined }, registry: { get: () => undefined } } as never;
    const row = { id: 's1', source: 'web', ended_at: null } as never;
    expect(statusOf(ctx, row)).toBe('idle');
    db.update(sessionHarnessesTable).set({ state: [{ status: 'done' }, { status: 'awaiting_approval' }, { status: 'pending' }] }).run();
    expect(statusOf(ctx, row)).toBe('needs_input');
    db.update(sessionHarnessesTable).set({ state: [{ status: 'done' }, { status: 'awaiting_approval', reviewing: true }, { status: 'pending' }] }).run();
    expect(statusOf(ctx, row)).toBe('idle');
    expect(statusOf(ctx, { ...(row as object), ended_at: 1 } as never)).toBe('ended');
  });

  function routesApp() {
    const made = makeService();
    const delivered: string[] = [];
    const app = Fastify();
    registerHarnessRoutes(app, {
      harness: made.service, errors: { record: vi.fn() },
      settings: { get: (k: string) => (k === 'harness_enabled' ? 'true' : ''), set: () => {} },
    } as never, async (_id, text) => {
      delivered.push(text);
      return { outcome: 'sent' as const, uuid: `d-${delivered.length}` };
    }, () => null);
    return { ...made, app, delivered };
  }
});

describe('the step graph', () => {
  // load → build → story → ◆parity ─┐
  //      └→ calls ─┴→ migrate ───────┴→ pr
  const graph: HarnessStep[] = [
    { id: 'load', title: 'Load', instructions: 'Load.', mode: 'auto', doneWhen: 'loaded' },
    { id: 'build', title: 'Build', instructions: 'Build.', mode: 'auto', doneWhen: 'built' },
    { id: 'calls', title: 'Call sites', instructions: 'Find them.', mode: 'auto', doneWhen: 'listed', dependsOn: ['load'] },
    { id: 'story', title: 'Storybook', instructions: 'Stories.', mode: 'auto', doneWhen: 'stories', dependsOn: ['build'] },
    { id: 'parity', title: 'Parity', instructions: 'Compare.', mode: 'gate', doneWhen: 'matches', dependsOn: ['story'] },
    { id: 'migrate', title: 'Migrate', instructions: 'Migrate.', mode: 'auto', doneWhen: 'migrated', dependsOn: ['build', 'calls'] },
    { id: 'pr', title: 'PR', instructions: 'Prepare.', mode: 'auto', doneWhen: 'ready', dependsOn: ['parity', 'migrate'] },
  ];
  const statuses = (state: { status: string }[]) => Object.fromEntries(graph.map((s, i) => [s.id, state[i]?.status]));
  function run(ids: string[], state = initialState(graph)) {
    for (const id of ids) {
      const r = tick(graph, state, id, rec(id), 1);
      if (!r.ok) throw new Error(r.error);
      state = r.state;
    }
    return state;
  }

  it('opens every step whose steps it needs are done, and refuses one that still waits', () => {
    expect(statuses(initialState(graph))).toMatchObject({ load: 'active', build: 'pending', calls: 'pending' });
    const afterLoad = tick(graph, initialState(graph), 'load', rec(), 1);
    expect(afterLoad).toMatchObject({ ok: true, outcome: 'advanced', unlocked: [1, 2] });
    const state = run(['load', 'build']);
    expect(statuses(state)).toMatchObject({ calls: 'active', story: 'active', migrate: 'pending' });
    const early = tick(graph, state, 'migrate', rec(), 1);
    expect(early).toMatchObject({ ok: false });
    expect(!early.ok && early.error).toContain('"calls"');
    // Several roots open at once.
    expect(initialState([{ ...graph[0] }, { ...graph[1], dependsOn: [] }]).map((s) => s.status)).toEqual(['active', 'active']);
  });

  it('a waiting gate holds back only the steps that need it', () => {
    const state = run(['load', 'build', 'story', 'parity']);
    expect(statuses(state)).toMatchObject({ parity: 'awaiting_approval', calls: 'active', pr: 'pending' });
    const h = harness({ steps: graph, state });
    expect(gateOf(h)).toBe('waiting');
    // The agent goes on with the open step, rather than waiting for the user.
    expect(decideTurnEnd(h, { ...idle, tickedThisTurn: true })).toEqual({ kind: 'advance', index: 2 });
    const approved = approve(graph, state, 4)!;
    expect(statuses(approved)).toMatchObject({ parity: 'done', pr: 'pending' });
    // With nothing else open, the gate is what is left: wait for the user.
    const onlyGate = run(['calls', 'migrate'], state);
    expect(decideTurnEnd(harness({ steps: graph, state: onlyGate }), idle)).toEqual({ kind: 'wait', reason: 'awaiting_approval' });
  });

  it('a gate behind an open step still asks for the user', () => {
    const state = run(['load', 'build', 'story', 'parity']);
    // `calls` comes before `parity` in the list and is still open.
    expect(gateOf({ state, removedAt: null })).toBe('waiting');
    expect(gateOf({ state, removedAt: null }, true)).toBe('waiting');
    expect(gateOf(null, true)).toBe('proposal');
    expect(gateOf({ state: initialState(graph), removedAt: null }, false)).toBeNull();
  });

  it('a step may need only steps before it; one that names none follows the step before', () => {
    const t = (s: HarnessStep[]) => validateTemplate({ name: 'x', tags: [], inputs: [], steps: s });
    expect(t(graph)).toBeNull();
    expect(t([{ ...graph[0], dependsOn: ['load'] }])).toMatch(/itself/);
    expect(t([graph[0], { ...graph[1], dependsOn: ['nope'] }])).toMatch(/not a step/);
    expect(t([{ ...graph[0], dependsOn: ['build'] }, graph[1]])).toMatch(/comes after it/);
    expect(t([graph[0], { ...graph[1], dependsOn: 'load' as never }])).toMatch(/list of step ids/);
    // A linear template says nothing about dependencies to the agent.
    expect(kickoffMessage(harness(), [])).not.toContain('— needs');
    expect(kickoffMessage(harness({ steps: graph, state: initialState(graph) }), [])).toContain('— needs 2, 3');
  });

  it('going back reopens the step and what needs it, and leaves the other branch alone', () => {
    const state = run(['load', 'build', 'calls', 'story', 'parity']);
    const back = goBack(graph, state, 1, 9)!;
    expect(statuses(back)).toEqual({
      load: 'done', build: 'active', calls: 'done', story: 'pending', parity: 'pending', migrate: 'pending', pr: 'pending',
    });
    expect(back[3].previousRuns?.[0]).toMatchObject({ summary: 'story', reason: 'went_back' });
    expect(back[2].previousRuns).toBeUndefined();
  });

  it('several open steps are named in the advance and the nudge', () => {
    const h = harness({ steps: graph, state: run(['load']) });
    expect(advanceMessage(h)).toMatch(/Steps 2 and 3 are open/);
    expect(advanceMessage(h)).toContain('## Step 3: Call sites');
    expect(nudgeMessage(h)).toContain('id `calls`');
    expect(buildWatcherPrompt('x', '', [graph[1], graph[2]], '')).toContain('Open step: Call sites');
  });
});

describe('editing a running harness', () => {
  const linear = steps.map((s) => ({ ...s, title: s.id }));

  it('refuses to change a finished step, and gives a removed step\'s needs to the steps after it', () => {
    const state = tick(linear, initialState(linear), 'build', rec('b'), 1);
    if (!state.ok) throw new Error();
    expect(applyChanges(linear, state.state, { remove: ['build'] }, 2)).toMatchObject({ ok: false, error: expect.stringMatching(/finished/) });
    expect(applyChanges(linear, state.state, { update: [{ ...linear[1], id: 'nope' }] }, 2)).toMatchObject({ ok: false });
    const r = applyChanges(linear, state.state, { remove: ['api'] }, 2);
    if (!r.ok) throw new Error(r.error);
    expect(r.steps.map((s) => [s.id, s.dependsOn])).toEqual([['build', []], ['pr', ['build']]]);
    // `pr` needed `api`; now it needs what `api` needed, which is done.
    expect(r.state.map((s) => s.status)).toEqual(['done', 'active']);
    expect(r.opened).toEqual([1]);
    expect(linear[2].dependsOn).toBeUndefined();
  });

  it('an open step that comes to need an unfinished step waits again, its record kept', () => {
    const state = tick(linear, initialState(linear), 'build', rec('b'), 1);
    if (!state.ok) throw new Error();
    const started = patchStepAt(state.state, 1, { startedAt: 5 });
    const added = { id: 'docs', title: 'Docs', instructions: 'Write.', mode: 'auto' as const, doneWhen: 'written', dependsOn: ['build'] };
    const r = applyChanges(linear, started, { add: [added], update: [{ ...linear[1], dependsOn: ['build', 'docs'] }] }, 7);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/comes after it/) });
    const moved = applyChanges(linear, started, { add: [added] }, 7);
    if (!moved.ok) throw new Error(moved.error);
    // Appended with explicit needs: open at once, since `build` is done.
    expect(moved.state.map((s) => s.status)).toEqual(['done', 'active', 'pending', 'active']);
    const back = applyChanges(moved.steps, moved.state, { update: [{ ...moved.steps[1], dependsOn: ['build', 'docs'] }] }, 9);
    expect(back).toMatchObject({ ok: false });
    const waits = applyChanges(linear, started, { update: [{ ...linear[1], title: 'Tune harder' }] }, 9);
    if (!waits.ok) throw new Error(waits.error);
    expect(waits.state[1]).toMatchObject({ status: 'active', startedAt: 5 });
    expect(applyChanges(linear, started, { remove: ['api', 'pr'] }, 9)).toMatchObject({ ok: true });
  });

  it('removing what an open step needs from its branch sends the step back to waiting', () => {
    const two: HarnessStep[] = [
      { id: 'a', title: 'A', instructions: '', mode: 'auto', doneWhen: 'a' },
      { id: 'b', title: 'B', instructions: '', mode: 'auto', doneWhen: 'b', dependsOn: [] },
      { id: 'c', title: 'C', instructions: '', mode: 'auto', doneWhen: 'c', dependsOn: [] },
    ];
    const state = patchStepAt(initialState(two), 2, { startedAt: 3, summary: 'half' });
    const r = applyChanges(two, state, { update: [{ ...two[2], dependsOn: ['a'] }] }, 8);
    if (!r.ok) throw new Error(r.error);
    expect(r.state[2]).toMatchObject({ status: 'pending', previousRuns: [{ status: 'active', summary: 'half', reason: 'edited', endedAt: 8 }] });
  });
});

function patchStepAt<T extends object>(state: T[], index: number, patch: object): T[] {
  return state.map((s, i) => (i === index ? { ...s, ...patch } : s));
}

describe('the graph and proposals, in the service and the routes', () => {
  const graph: HarnessStep[] = [
    { id: 'load', title: 'Load', instructions: 'Load.', mode: 'auto', doneWhen: 'loaded' },
    { id: 'build', title: 'Build', instructions: 'Build.', mode: 'auto', doneWhen: 'built' },
    { id: 'calls', title: 'Call sites', instructions: 'Find.', mode: 'auto', doneWhen: 'listed', dependsOn: ['load'] },
    { id: 'parity', title: 'Parity', instructions: 'Compare.', mode: 'gate', doneWhen: 'matches', dependsOn: ['build'] },
    { id: 'pr', title: 'PR', instructions: 'Prepare.', mode: 'auto', doneWhen: 'ready', dependsOn: ['parity', 'calls'] },
  ];

  function app(over: Partial<HarnessDeps> = {}) {
    const made = makeService(over);
    const delivered: string[] = [];
    const server = Fastify();
    registerHarnessRoutes(server, {
      harness: made.service, errors: { record: vi.fn() },
      settings: { get: (k: string) => (k === 'harness_enabled' ? 'true' : ''), set: () => {} },
    } as never, async (_id, text) => {
      delivered.push(text);
      return { outcome: 'sent' as const, uuid: `d-${delivered.length}` };
    }, () => null);
    return { ...made, app: server, delivered };
  }

  it('each step\'s commit range starts at the tick before it, whichever step that was', async () => {
    let head = 'h0';
    const { service, templateId: _t } = makeService({
      git: async (_cwd, args) => (args[0] === 'rev-parse' ? { ok: true, output: `${head}\n` } : { ok: true, output: '' }),
    });
    const t = service.createTemplate({ name: 'G', description: '', tags: [], inputs: [], steps: graph });
    if (!t.ok) throw new Error(t.error);
    service.attach('s1', t.value.id, {});
    await service.openStepsStarted('s1', 'm1');
    head = 'h1';
    await service.completeStep('s1', 'load', rec());
    await service.openStepsStarted('s1', 'm2');
    head = 'h2';
    await service.completeStep('s1', 'calls', rec());
    head = 'h3';
    await service.completeStep('s1', 'build', rec());
    const state = service.get('s1')!.state;
    expect(state[0]).toMatchObject({ startHead: 'h0', endHead: 'h1' });
    expect(state[2]).toMatchObject({ startHead: 'h1', endHead: 'h2' });
    // `build` opened with `calls` at h1, but `calls` was ticked at h2 since.
    expect(state[1]).toMatchObject({ startHead: 'h2', endHead: 'h3' });
  });

  it('a gate ticked while other steps are open asks for the user at once', async () => {
    const { db, service } = makeService();
    const t = service.createTemplate({ name: 'G', description: '', tags: [], inputs: [], steps: graph });
    if (!t.ok) throw new Error(t.error);
    service.attach('s1', t.value.id, {});
    await service.completeStep('s1', 'load', rec());
    await service.completeStep('s1', 'build', rec());
    const reply = await service.completeStep('s1', 'parity', rec());
    expect(reply).toMatch(/Carry on with the open steps/);
    expect(harnessGateOf(db, 's1')).toBe('waiting');
  });

  it('the agent proposes a harness; the user applies it and the kickoff goes out', async () => {
    const { app: server, service, db, delivered } = app();
    expect(service.propose('s1', { kind: 'harness', harness: { name: 'One-off', steps: [{ ...graph[0], dependsOn: ['pr'] }] } }, null))
      .toMatchObject({ ok: false, error: expect.stringMatching(/not a step/) });
    expect(service.propose('s1', { kind: 'changes', changes: {} }, null)).toMatchObject({ ok: false, status: 409 });
    expect(service.propose('s1', { kind: 'harness', harness: { name: 'First', steps: graph.slice(0, 2) } }, null).ok).toBe(true);
    expect(service.propose('s1', { kind: 'harness', harness: { name: 'One-off', steps: graph } }, 'Branches for the call sites.').ok).toBe(true);
    expect(harnessGateOf(db, 's1')).toBe('proposal');
    const read = (await server.inject({ method: 'GET', url: '/api/sessions/s1/harness' })).json();
    expect(read.proposal).toMatchObject({ kind: 'harness', note: 'Branches for the call sites.', harness: { name: 'One-off' } });
    expect(read.events.map((e: { kind: string }) => e.kind)).toContain('proposal_superseded');
    const applied = await server.inject({ method: 'POST', url: '/api/sessions/s1/harness/proposal/apply' });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().harness).toMatchObject({ templateId: null, name: 'One-off' });
    expect(delivered[0]).toContain('This session follows the Orbital harness "One-off"');
    expect(service.get('s1')!.state[0]).toMatchObject({ startMessageUuid: 'd-1' });
    expect(service.proposal('s1')).toBeNull();
    expect(harnessGateOf(db, 's1')).toBeNull();
    expect((await server.inject({ method: 'POST', url: '/api/sessions/s1/harness/proposal/apply' })).statusCode).toBe(409);
    expect(service.propose('s1', { kind: 'harness', harness: { name: 'Again', steps: graph } }, null)).toMatchObject({ ok: false, status: 409 });
  });

  it('a proposed change the harness moved past no longer applies; discard drops it', async () => {
    const { app: server, service, templateId } = app();
    service.attach('s1', templateId, {});
    const proposed = service.propose('s1', { kind: 'changes', changes: { update: [{ ...steps[0], title: 'Build better' }] } }, null);
    expect(proposed.ok).toBe(true);
    await service.completeStep('s1', 'build', rec());
    const stale = await server.inject({ method: 'POST', url: '/api/sessions/s1/harness/proposal/apply' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatch(/finished/);
    expect((await server.inject({ method: 'POST', url: '/api/sessions/s1/harness/proposal/discard' })).json()).toEqual({ ok: true });
  });

  it('the user\'s edited version of a proposal is applied instead of it', async () => {
    const { app: server, service, delivered } = app();
    service.propose('s1', { kind: 'harness', harness: { name: 'One-off', steps: graph } }, 'why');
    const wrong = await server.inject({ method: 'POST', url: '/api/sessions/s1/harness/proposal/apply', payload: { changes: {} } });
    expect(wrong.statusCode).toBe(400);
    const bad = await server.inject({
      method: 'POST', url: '/api/sessions/s1/harness/proposal/apply',
      payload: { harness: { name: 'Mine', steps: [{ ...graph[0], dependsOn: ['load'] }] } },
    });
    expect(bad.statusCode).toBe(400);
    expect(service.proposal('s1')).toMatchObject({ harness: { name: 'One-off' } });
    const ok = await server.inject({
      method: 'POST', url: '/api/sessions/s1/harness/proposal/apply', payload: { harness: { name: 'Mine', steps: graph.slice(0, 2) } },
    });
    expect(ok.json().harness).toMatchObject({ name: 'Mine', steps: [{ id: 'load' }, { id: 'build' }] });
    expect(delivered[0]).toContain('"Mine"');
    expect((await server.inject({ method: 'POST', url: '/api/sessions/s1/harness/proposal/discard' })).statusCode).toBe(409);
  });

  it('the user edits the running harness, and the agent is told what changed', async () => {
    const { app: server, service, templateId, delivered } = app();
    service.attach('s1', templateId, {});
    const added = { id: 'docs', title: 'Docs', instructions: 'Write the docs.', mode: 'auto', doneWhen: 'written', dependsOn: [] };
    const edited = await server.inject({ method: 'PUT', url: '/api/sessions/s1/harness/steps', payload: { add: [added] } });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().harness.state.map((s: { status: string }) => s.status)).toEqual(['active', 'pending', 'pending', 'active']);
    expect(delivered[0]).toMatch(/The user changed the checklist: added 4 "Docs"/);
    expect(delivered[0]).toContain('## Step 4: Docs');
    expect(service.get('s1')!.state[3].startMessageUuid).toBe('d-1');
    expect(service.events('s1').map((e) => e.kind)).toContain('edited');
    expect((await server.inject({ method: 'PUT', url: '/api/sessions/s1/harness/steps', payload: { add: [added] } })).statusCode).toBe(400);
    expect((await server.inject({ method: 'PUT', url: '/api/sessions/s1/harness/steps', payload: { remove: 'docs' } })).statusCode).toBe(400);
  });
});
