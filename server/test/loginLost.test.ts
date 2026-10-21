import { describe, it, expect, vi } from 'vitest';
import { Hub } from '../src/api/hub.js';
import { Runner } from '../src/runner/runner.js';
import { entriesToMessages, type TranscriptEntry } from '../src/transcript/parser.js';
import type { TurnEndInfo } from '../src/login/service.js';

/**
 * A lost login, as a reload reads it from the transcript and as the runner
 * sees it live (spec 2026-10-21-log-in-from-orbital-design § 3 Recognising
 * it): both make the same `login_lost` notice, and the runner tells the
 * server at every main turn's end whether the turn ended on one.
 */

/** The entry the CLI wrote for a turn that failed on the login (CLI 2.1.223). */
const AUTH_FAILED: TranscriptEntry = {
  type: 'assistant', uuid: 'u-auth', timestamp: '2026-10-21T10:00:00.000Z',
  message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Login expired · Please run /login' }] },
  error: 'authentication_failed',
  ...{ isApiErrorMessage: true },
};

const DESIGN_CALL: TranscriptEntry = {
  type: 'assistant', uuid: 'u-call',
  message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'toolu_d', name: 'DesignSync', input: { op: 'list_files' } }] },
};
const designResult = (text: string, isError = true): TranscriptEntry => ({
  type: 'user', uuid: 'u-result',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_d', is_error: isError, content: text }] },
});

describe('the transcript parser', () => {
  it('turns an authentication_failed entry into a login_lost notice with the CLI\'s text', () => {
    const [row] = entriesToMessages([AUTH_FAILED]);
    expect(row).toMatchObject({
      role: 'notice', text: 'Login expired · Please run /login', uuid: 'u-auth',
      notice: { kind: 'login_lost', login: { kind: 'claude', claudeDirId: null, email: null, neverLoggedIn: false } },
    });
  });

  it('says so when the profile was never logged in', () => {
    const never = { ...AUTH_FAILED, message: { ...AUTH_FAILED.message!, content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } };
    expect(entriesToMessages([never])[0].notice?.login).toMatchObject({ neverLoggedIn: true });
  });

  it('leaves the same entry without the error field the assistant text it was', () => {
    const { error: _error, ...plain } = AUTH_FAILED;
    expect(entriesToMessages([plain as TranscriptEntry])[0]).toMatchObject({ role: 'assistant', text: 'Login expired · Please run /login' });
    expect(entriesToMessages([{ ...AUTH_FAILED, error: 'rate_limit' }])[0].role).toBe('assistant');
  });

  it('follows a DesignSync failure naming /design-login with a design login_lost notice, and keeps the result', () => {
    const rows = entriesToMessages([DESIGN_CALL, designResult('Not signed in to Claude Design. Run /design-login and try again.')]);
    expect(rows.map((r) => r.role)).toEqual(['tool_use', 'tool_result', 'notice']);
    expect(rows[2].notice).toMatchObject({ kind: 'login_lost', login: { kind: 'design', claudeDirId: null } });
  });

  it('adds nothing for a DesignSync failure of another kind, or a result that is no failure', () => {
    expect(entriesToMessages([DESIGN_CALL, designResult('file not found')]).map((r) => r.role)).toEqual(['tool_use', 'tool_result']);
    expect(entriesToMessages([DESIGN_CALL, designResult('see /design-login', false)]).map((r) => r.role)).toEqual(['tool_use', 'tool_result']);
  });
});

/** A fake SDK whose stream the test writes, as `runner.test.ts`'s `scriptedQueryFn`. */
function scripted() {
  const queue: any[] = [];
  let notify: (() => void) | null = null;
  let sid = 'unpinned';
  const fn = ({ options }: { options: any }) => {
    sid = options?.sessionId ?? options?.resume ?? 'unpinned';
    async function* gen() {
      for (;;) {
        while (queue.length) yield { session_id: sid, ...queue.shift() };
        await new Promise<void>((resolve) => { notify = resolve; });
      }
    }
    return gen() as any;
  };
  return {
    fn,
    push(msg: Record<string, unknown>) {
      queue.push(msg);
      const resume = notify;
      notify = null;
      resume?.();
    },
  };
}

function listen(hub: Hub, topic: string) {
  const received: any[] = [];
  const socket: any = {
    send: (d: string) => received.push(JSON.parse(d)),
    handlers: {} as Record<string, Function>,
    on(ev: string, cb: Function) { this.handlers[ev] = cb; },
  };
  hub.handleSocket(socket);
  socket.handlers.message(JSON.stringify({ type: 'subscribe', topic }));
  return received;
}

describe('the runner', () => {
  async function started() {
    const hub = new Hub();
    const script = scripted();
    const ends: TurnEndInfo[] = [];
    const runner = new Runner({
      hub, queryFn: script.fn as any, newSessionId: () => 'web-1',
      onTurnEnd: (_id, info) => ends.push(info),
      accountEmailOf: () => 'me@example.com',
    });
    const events = listen(hub, 'session:web-1');
    await runner.start({ cwd: '/p', prompt: 'go', permissionMode: 'acceptEdits', claudeDirId: 2 });
    return { script, ends, events };
  }

  it('publishes an authentication_failed frame as a login_lost notice, and the turn as ended on a lost login', async () => {
    const { script, ends, events } = await started();
    script.push({
      type: 'assistant', error: 'authentication_failed',
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Failed to authenticate: OAuth session expired and could not be refreshed' }] },
    });
    script.push({ type: 'result', subtype: 'error_during_execution', usage: {} });
    await vi.waitFor(() => expect(ends).toHaveLength(1));
    expect(ends[0]).toEqual({ loginLost: true, designLoginLost: false });
    const rows = events.filter((e) => e.event === 'message').map((e) => e.message);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: 'notice', text: 'Failed to authenticate: OAuth session expired and could not be refreshed',
      notice: { kind: 'login_lost', login: { kind: 'claude', claudeDirId: 2, email: 'me@example.com', neverLoggedIn: false } },
    });
  });

  it('marks a turn with a DesignSync failure naming /design-login, whatever came after it, and only that turn', async () => {
    const { script, ends, events } = await started();
    script.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_d', name: 'DesignSync', input: {} }] } });
    script.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_d', is_error: true, content: 'Run /design-login first.' }] } });
    script.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Please run /design-login.' }] } });
    script.push({ type: 'result', subtype: 'success', usage: {} });
    await vi.waitFor(() => expect(ends).toHaveLength(1));
    expect(ends[0]).toEqual({ loginLost: false, designLoginLost: true });
    expect(events.some((e) => e.message?.notice?.login?.kind === 'design')).toBe(true);

    script.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'next' }] } });
    script.push({ type: 'result', subtype: 'success', usage: {} });
    await vi.waitFor(() => expect(ends).toHaveLength(2));
    expect(ends[1]).toEqual({ loginLost: false, designLoginLost: false });
  });
});
