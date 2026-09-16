import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hub } from '../src/api/hub.js';
import {
  IDLE_NEVER,
  Runner,
  parseIdleTimeoutMs,
  sdkToChatMessages,
} from '../src/runner/runner.js';

/**
 * The id the real CLI runs the session under: the one the caller pinned via
 * `options.sessionId`, or the resumed session's id. Every fake below derives
 * `session_id` this way instead of hardcoding one, because that is what the
 * CLI actually does — a fake that invents its own id would let a Runner that
 * never pins one keep passing.
 */
function sessionIdOf(options: any): string {
  return options?.sessionId ?? options?.resume ?? 'unpinned';
}

/**
 * Fake SDK: echoes each user message, then emits a result.
 *
 * `system/init` is emitted only *after* the first user message arrives —
 * what the real CLI does in stream-json input mode. It sits idle on stdin
 * until a message shows up and only then starts the session and announces
 * it. Fakes that emitted `init` up front hid a deadlock: Runner waited for
 * `init` before sending the first prompt, so neither side ever moved.
 * See `docs/decisions/runner-pins-the-session-id.md`.
 */
function fakeQueryFn() {
  const interrupt = vi.fn(async () => {});
  const fn = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
    const sid = sessionIdOf(options);
    async function* gen() {
      let announced = false;
      for await (const userMsg of prompt) {
        if (!announced) {
          announced = true;
          yield { type: 'system', subtype: 'init', session_id: sid };
        }
        const text = userMsg.message.content[0].text;
        yield {
          type: 'assistant', session_id: sid,
          message: { role: 'assistant', content: [{ type: 'text', text: `echo:${text}` }] },
        };
        yield { type: 'result', subtype: 'success', session_id: sid, usage: { output_tokens: 5 } };
      }
    }
    const g = gen() as any;
    g.interrupt = interrupt;
    return g;
  };
  return { fn, interrupt };
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

/** Fake SDK whose generator ends on its own after one turn — no end() call, simulating the SDK process exiting. */
function fakeQueryFnSelfEnding() {
  const fn = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
    const sid = sessionIdOf(options);
    async function* gen() {
      // Pull exactly one input message off the queue, then finish without
      // looping back to ask for another — the generator just ends.
      const iterator = prompt[Symbol.asyncIterator]();
      await iterator.next();
      yield { type: 'system', subtype: 'init', session_id: sid };
      yield {
        type: 'assistant', session_id: sid,
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      };
      yield { type: 'result', subtype: 'success', session_id: sid, usage: {} };
    }
    return gen() as any;
  };
  return { fn };
}

/**
 * Fake SDK that stalls mid-turn on the second message: it yields an assistant
 * message but never yields a `result`, and it parks on a test-controlled gate
 * instead of looping back to request the next prompt value — so at the moment
 * end() is called, no dequeue() waiter is registered on Runner's input queue.
 */
function fakeQueryFnMidTurnStall() {
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  let finished!: () => void;
  const finishedPromise = new Promise<void>((resolve) => { finished = resolve; });
  const fn = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
    const sid = sessionIdOf(options);
    async function* gen() {
      try {
        let turn = 0;
        for await (const userMsg of prompt) {
          turn++;
          const text = userMsg.message.content[0].text;
          if (turn === 1) {
            yield { type: 'system', subtype: 'init', session_id: sid };
            yield {
              type: 'assistant', session_id: sid,
              message: { role: 'assistant', content: [{ type: 'text', text: `echo:${text}` }] },
            };
            yield { type: 'result', subtype: 'success', session_id: sid, usage: {} };
          } else {
            yield {
              type: 'assistant', session_id: sid,
              message: { role: 'assistant', content: [{ type: 'text', text: 'working...' }] },
            };
            // Stall here — no `result`, and no loop-back to `for await` yet,
            // so no dequeue() waiter is parked until the gate is released.
            await gate;
          }
        }
      } finally {
        finished();
      }
    }
    return gen() as any;
  };
  return { fn, releaseGate: () => releaseGate(), finishedPromise };
}

/** Fake SDK that yields a message belonging to an unrelated session id alongside this session's own traffic. */
function fakeQueryFnStrayForeignMessage() {
  const fn = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
    const sid = sessionIdOf(options);
    async function* gen() {
      yield {
        type: 'assistant', session_id: 'someone-else',
        message: { role: 'assistant', content: [{ type: 'text', text: 'stray' }] },
      };
      for await (const userMsg of prompt) {
        const text = userMsg.message.content[0].text;
        yield { type: 'system', subtype: 'init', session_id: sid };
        yield {
          type: 'assistant', session_id: sid,
          message: { role: 'assistant', content: [{ type: 'text', text: `echo:${text}` }] },
        };
        yield { type: 'result', subtype: 'success', session_id: sid, usage: {} };
      }
    }
    return gen() as any;
  };
  return { fn };
}

/** Fake SDK that emits a tool_use then a tool_result in the same turn, each as content index 0. */
function fakeQueryFnToolMessages() {
  const fn = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
    const sid = sessionIdOf(options);
    async function* gen() {
      for await (const _userMsg of prompt) {
        yield { type: 'system', subtype: 'init', session_id: sid };
        yield {
          type: 'assistant', session_id: sid,
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }] },
        };
        yield {
          type: 'user', session_id: sid,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
        };
        yield { type: 'result', subtype: 'success', session_id: sid, usage: {} };
      }
    }
    return gen() as any;
  };
  return { fn };
}

/**
 * Fake SDK that never says anything at all — the real CLI's behaviour when
 * nothing is ever written to its stdin (verified against
 * `@anthropic-ai/claude-agent-sdk` 0.3.0 / CLI 2.1.272: with no user message
 * and no hooks configured, not one message comes back, `system/init`
 * included). Any Runner that waits on the stream before it can report a
 * session id hangs forever here.
 */
function fakeQueryFnSilent() {
  const fn = (_args: { prompt: AsyncIterable<any>; options: any }) => {
    async function* gen(): AsyncGenerator<any> {
      await new Promise(() => {}); // never resolves
    }
    return gen() as any;
  };
  return { fn };
}

/** Like fakeQueryFn, but its result message also carries modelUsage. */
function fakeQueryFnWithModelUsage() {
  const fn = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
    const sid = sessionIdOf(options);
    async function* gen() {
      for await (const _msg of prompt) {
        yield {
          type: 'result', subtype: 'success', session_id: sid,
          usage: { output_tokens: 5 },
          modelUsage: { 'claude-sonnet-5': { contextWindow: 200_000 } },
        };
      }
    }
    return gen() as any;
  };
  return { fn };
}

describe('Runner', () => {
  it('starts a session, streams messages, and lands in needs_input after the turn', async () => {
    const hub = new Hub();
    const { fn } = fakeQueryFn();
    const runner = new Runner({ hub, queryFn: fn as any, newSessionId: () => 'web-1' });
    const received = subscribed(hub, 'session:web-1');
    const id = await runner.start({ cwd: '/p', prompt: 'hello', permissionMode: 'acceptEdits' });
    expect(id).toBe('web-1');
    await vi.waitFor(() => expect(runner.status('web-1')).toBe('needs_input'));
    const events = received.map((r) => r.event);
    expect(events).toContain('message');
    expect(events).toContain('turn_result');
    const msg = received.find((r) => r.event === 'message');
    expect(msg.message.text).toBe('echo:hello');
  });

  it('hands each turn result modelUsage to its consumer', async () => {
    const hub = new Hub();
    const seen: unknown[] = [];
    const { fn } = fakeQueryFnWithModelUsage();
    const runner = new Runner({ hub, queryFn: fn, onTurnUsage: (u) => seen.push(u) });
    await runner.start({ cwd: '/w', prompt: 'hi', permissionMode: 'acceptEdits' });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual({ 'claude-sonnet-5': { contextWindow: 200_000 } });
  });

  it('start() with an empty prompt does not enqueue a first turn; waits in needs_input for send() (I6)', async () => {
    const hub = new Hub();
    const { fn } = fakeQueryFn();
    const runner = new Runner({ hub, queryFn: fn as any, newSessionId: () => 'web-1' });
    const received = subscribed(hub, 'session:web-1');
    const id = await runner.start({ cwd: '/p', prompt: '', permissionMode: 'acceptEdits' });
    expect(id).toBe('web-1');

    // No turn ran: the fake only ever yields a message/turn_result after
    // pulling a user message off the input queue, so nothing should have
    // reached the hub, and status should have moved off 'working' straight
    // to 'needs_input' (a session that isn't running a turn shouldn't be
    // reported as 'working').
    await vi.waitFor(() => expect(runner.status('web-1')).toBe('needs_input'));
    expect(received.filter((r) => r.event === 'message')).toHaveLength(0);
    expect(received.filter((r) => r.event === 'turn_result')).toHaveLength(0);

    // send() delivers the first real message and runs a turn as normal.
    runner.send('web-1', 'first real message');
    expect(runner.status('web-1')).toBe('working');
    await vi.waitFor(() => expect(runner.status('web-1')).toBe('needs_input'));
    const msg = received.find((r) => r.event === 'message');
    expect(msg.message.text).toBe('echo:first real message');
  });

  it('send() runs another turn; end() closes the session', async () => {
    const hub = new Hub();
    const { fn } = fakeQueryFn();
    const runner = new Runner({ hub, queryFn: fn as any, newSessionId: () => 'web-1' });
    const received = subscribed(hub, 'session:web-1');
    await runner.start({ cwd: '/p', prompt: 'one', permissionMode: 'plan' });
    await vi.waitFor(() => expect(runner.status('web-1')).toBe('needs_input'));
    runner.send('web-1', 'two');
    expect(runner.status('web-1')).toBe('working');
    await vi.waitFor(() =>
      expect(received.filter((r) => r.event === 'turn_result')).toHaveLength(2),
    );
    await runner.end('web-1');
    expect(runner.status('web-1')).toBe('ended');
    expect(runner.active()).toEqual([]);
  });

  it('interrupt() calls the SDK interrupt', async () => {
    const hub = new Hub();
    const { fn, interrupt } = fakeQueryFn();
    const runner = new Runner({ hub, queryFn: fn as any, newSessionId: () => 'web-1' });
    await runner.start({ cwd: '/p', prompt: 'x', permissionMode: 'plan' });
    await runner.interrupt('web-1');
    expect(interrupt).toHaveBeenCalled();
  });

  it('passes the claude_code preset and setting sources to the SDK', async () => {
    const hub = new Hub();
    let captured: any;
    const fn = (args: any) => {
      captured = args.options;
      return fakeQueryFn().fn(args);
    };
    const runner = new Runner({ hub, queryFn: fn as any, newSessionId: () => 'web-1' });
    await runner.start({ cwd: '/p', prompt: 'x', permissionMode: 'acceptEdits', resume: 'old-1', model: 'claude-opus' });
    expect(captured).toMatchObject({
      cwd: '/p',
      permissionMode: 'acceptEdits',
      resume: 'old-1',
      model: 'claude-opus',
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
    });
  });

  it('ends the session cleanly when the SDK generator finishes on its own (no end() call)', async () => {
    const hub = new Hub();
    const { fn } = fakeQueryFnSelfEnding();
    const runner = new Runner({ hub, queryFn: fn as any, newSessionId: () => 'web-1' });
    const received = subscribed(hub, 'session:web-1');
    await runner.start({ cwd: '/p', prompt: 'hi', permissionMode: 'plan' });
    await vi.waitFor(() => expect(runner.active()).toEqual([]));
    expect(runner.status('web-1')).toBe('ended');
    const endedEvents = received.filter((r) => r.event === 'status' && r.status === 'ended');
    expect(endedEvents).toHaveLength(1);
  });

  it('end() while working with no waiter parked still terminates the input stream (not a hang)', async () => {
    const hub = new Hub();
    const { fn, releaseGate, finishedPromise } = fakeQueryFnMidTurnStall();
    const runner = new Runner({ hub, queryFn: fn as any, newSessionId: () => 'web-1' });
    const received = subscribed(hub, 'session:web-1');
    await runner.start({ cwd: '/p', prompt: 'one', permissionMode: 'plan' });
    await vi.waitFor(() => expect(runner.status('web-1')).toBe('needs_input'));
    runner.send('web-1', 'two');
    // Wait until the fake has yielded the mid-turn "working..." message and is
    // parked on the gate — at this point no dequeue() waiter is registered.
    await vi.waitFor(() =>
      expect(received.some((r) => r.event === 'message' && r.message.text === 'working...')).toBe(true),
    );
    expect(runner.status('web-1')).toBe('working');

    await runner.end('web-1');
    expect(runner.status('web-1')).toBe('ended');

    releaseGate();
    await Promise.race([
      finishedPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timed out waiting for the SDK generator to terminate')), 1000),
      ),
    ]);
  });

  it('pins the session id itself and returns it without waiting for the SDK to speak', async () => {
    // The launch bug: the CLI emits `system/init` only once it has been sent
    // a user message, and Runner used to withhold that message until it had
    // seen `init`. Against a stream that says nothing, start() must still
    // resolve — the id is the Runner's to choose, not the CLI's to reveal.
    const hub = new Hub();
    const { fn } = fakeQueryFnSilent();
    let captured: any;
    const capturing = (args: any) => {
      captured = args.options;
      return fn(args);
    };
    const runner = new Runner({ hub, queryFn: capturing as any, newSessionId: () => 'web-1' });
    const id = await Promise.race([
      runner.start({ cwd: '/p', prompt: 'hello', permissionMode: 'plan' }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('start() hung waiting on the SDK stream')), 1000),
      ),
    ]);
    expect(id).toBe('web-1');
    // ...and the id is handed to the CLI, so the transcript it writes and the
    // row Orbital stores are the same session.
    expect(captured.sessionId).toBe('web-1');
    expect(runner.status('web-1')).toBe('working');
  });

  it('sends the first prompt without waiting for init (the CLI only inits once it has input)', async () => {
    const hub = new Hub();
    const { fn } = fakeQueryFn();
    const runner = new Runner({ hub, queryFn: fn as any, newSessionId: () => 'web-1' });
    const received = subscribed(hub, 'session:web-1');
    await runner.start({ cwd: '/p', prompt: 'hello', permissionMode: 'plan' });
    // The fake only ever emits anything after it pulls a user message off the
    // input stream, exactly like the CLI. A turn completing proves the prompt
    // went in on its own rather than waiting for an init that would never come.
    await vi.waitFor(() => expect(runner.status('web-1')).toBe('needs_input'));
    expect(received.find((r) => r.event === 'message').message.text).toBe('echo:hello');
  });

  it('does not publish messages belonging to another session id', async () => {
    const hub = new Hub();
    const { fn } = fakeQueryFnStrayForeignMessage();
    const runner = new Runner({ hub, queryFn: fn as any, newSessionId: () => 'web-1' });
    const received = subscribed(hub, 'session:web-1');
    const id = await runner.start({ cwd: '/p', prompt: 'hello', permissionMode: 'plan' });
    expect(id).toBe('web-1');
    await vi.waitFor(() => expect(runner.status('web-1')).toBe('needs_input'));
    const texts = received.filter((r) => r.event === 'message').map((r) => r.message.text);
    expect(texts).toEqual(['echo:hello']);
  });

  it('assigns distinct message ids even when messages land in the same millisecond', async () => {
    const hub = new Hub();
    const { fn } = fakeQueryFnToolMessages();
    const runner = new Runner({ hub, queryFn: fn as any, newSessionId: () => 'web-1' });
    const received = subscribed(hub, 'session:web-1');
    await runner.start({ cwd: '/p', prompt: 'go', permissionMode: 'plan' });
    await vi.waitFor(() => expect(received.filter((r) => r.event === 'turn_result')).toHaveLength(1));
    const ids = received.filter((r) => r.event === 'message').map((r) => r.message.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('start() with resume of an active session throws (collision guard)', async () => {
    const hub = new Hub();
    const { fn } = fakeQueryFn();
    const runner = new Runner({ hub, queryFn: fn as any, newSessionId: () => 'web-1' });
    await runner.start({ cwd: '/p', prompt: 'x', permissionMode: 'plan' });
    await expect(
      runner.start({ cwd: '/p', prompt: 'y', permissionMode: 'plan', resume: 'web-1' }),
    ).rejects.toThrow(/collision/);
  });

  it('start() with two concurrent resumes of the same session: only one wins', async () => {
    const hub = new Hub();
    const { fn } = fakeQueryFnSilent();
    const runner = new Runner({ hub, queryFn: fn as any, newSessionId: () => 'web-1' });

    // Both calls are made before either has heard a word from its SDK
    // stream. Registration is synchronous, so the second one still collides.
    const p1 = runner.start({ cwd: '/p', prompt: 'x', permissionMode: 'plan', resume: 'old-1' });
    const p2 = runner.start({ cwd: '/p', prompt: 'y', permissionMode: 'plan', resume: 'old-1' });

    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/collision/);
  });

  it('sdkToChatMessages: nextSeq is called once per content block, producing distinct ids', () => {
    let seq = 0;
    const nextSeq = () => ++seq;
    const toolUse = sdkToChatMessages(
      { type: 'assistant', session_id: 'x', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }] } },
      nextSeq,
    );
    const toolResult = sdkToChatMessages(
      { type: 'user', session_id: 'x', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } },
      nextSeq,
    );
    expect(toolUse[0].id).not.toBe(toolResult[0].id);
  });
});

// ---------------------------------------------------------------------------
// Idle timeout: live setting changes + the "never" sentinel
// ---------------------------------------------------------------------------

describe('parseIdleTimeoutMs', () => {
  it('maps minute counts to milliseconds', () => {
    expect(parseIdleTimeoutMs('15')).toBe(15 * 60_000);
    expect(parseIdleTimeoutMs('120')).toBe(120 * 60_000);
    expect(parseIdleTimeoutMs(60)).toBe(60 * 60_000);
  });

  it('maps the sentinel to null (case/whitespace tolerant)', () => {
    expect(parseIdleTimeoutMs(IDLE_NEVER)).toBeNull();
    expect(parseIdleTimeoutMs('never')).toBeNull();
    expect(parseIdleTimeoutMs('  Never  ')).toBeNull();
  });

  it('never yields NaN or a non-positive delay for junk, missing or zero values', () => {
    // The destructive edge: `Number('banana')`/`Number('')` reaching
    // setTimeout would fire on the next tick and end every session at once.
    for (const raw of ['banana', '', '0', '-5', null, undefined, NaN]) {
      const ms = parseIdleTimeoutMs(raw as any);
      expect(ms).toBe(30 * 60_000);
    }
  });
});

describe('Runner idle timer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Starts a session and drives it to `needs_input` (idle timer armed). */
  async function idlingRunner(idleTimeoutMs: number | null) {
    const hub = new Hub();
    const { fn } = fakeQueryFn();
    const runner = new Runner({ hub, queryFn: fn as any, idleTimeoutMs, newSessionId: () => 'web-1' });
    const id = await runner.start({ cwd: '/p', prompt: 'hi', permissionMode: 'plan' });
    await vi.waitFor(() => expect(runner.status(id)).toBe('needs_input'));
    return { runner, id };
  }

  it('arms a timer that ends the session after the configured timeout', async () => {
    const { runner, id } = await idlingRunner(15 * 60_000);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(15 * 60_000);
    expect(runner.status(id)).toBe('ended');
  });

  it('a null timeout ("never") arms NO timer at all', async () => {
    const { runner, id } = await idlingRunner(null);
    // Not "a very long timer" — no timer: nothing pending, and no amount of
    // elapsed time ends the session.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(365 * 24 * 60 * 60_000);
    expect(runner.status(id)).toBe('needs_input');
  });

  it('a null timeout keeps arming nothing across further turns', async () => {
    const { runner, id } = await idlingRunner(null);
    runner.send(id, 'again');
    await vi.waitFor(() => expect(runner.status(id)).toBe('needs_input'));
    expect(vi.getTimerCount()).toBe(0);
    await runner.interrupt(id);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('setIdleTimeoutMs re-arms an already-idling session immediately', async () => {
    const { runner, id } = await idlingRunner(60 * 60_000);
    // Switch to 15 min while the session is already idling: the old 60-min
    // timer must be replaced, not left running alongside the new value.
    runner.setIdleTimeoutMs(15 * 60_000);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(15 * 60_000);
    expect(runner.status(id)).toBe('ended');
  });

  it('setIdleTimeoutMs(null) disarms a timer that was already counting down', async () => {
    const { runner, id } = await idlingRunner(15 * 60_000);
    vi.advanceTimersByTime(14 * 60_000);
    runner.setIdleTimeoutMs(null);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60 * 60_000);
    expect(runner.status(id)).toBe('needs_input');
  });

  it('switching back from "never" to a timed value re-arms an already-idling session', async () => {
    const { runner, id } = await idlingRunner(null);
    expect(vi.getTimerCount()).toBe(0);
    runner.setIdleTimeoutMs(15 * 60_000);
    // Re-arms even though the session will never be touched again — that is
    // exactly the state the setting governs.
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(15 * 60_000);
    expect(runner.status(id)).toBe('ended');
  });

  it('re-arming starts a full new interval rather than counting elapsed idle time', async () => {
    const { runner, id } = await idlingRunner(60 * 60_000);
    vi.advanceTimersByTime(30 * 60_000); // 30 min already idle
    runner.setIdleTimeoutMs(15 * 60_000); // shorter than the time already elapsed
    // A "remaining time" implementation would have ended it instantly here.
    vi.advanceTimersByTime(14 * 60_000);
    expect(runner.status(id)).toBe('needs_input');
    vi.advanceTimersByTime(60_000);
    expect(runner.status(id)).toBe('ended');
  });

  it('does not arm a timer on a session that is mid-turn', async () => {
    const hub = new Hub();
    const { fn, releaseGate, finishedPromise } = fakeQueryFnMidTurnStall();
    const runner = new Runner({ hub, queryFn: fn as any, idleTimeoutMs: 15 * 60_000, newSessionId: () => 'web-1' });
    const id = await runner.start({ cwd: '/p', prompt: 'one', permissionMode: 'plan' });
    await vi.waitFor(() => expect(runner.status(id)).toBe('needs_input'));
    expect(vi.getTimerCount()).toBe(1);

    runner.send(id, 'two'); // back to working; the fake stalls without a result
    expect(runner.status(id)).toBe('working');
    expect(vi.getTimerCount()).toBe(0); // send() disarmed the idle timer

    runner.setIdleTimeoutMs(15 * 60_000);
    expect(vi.getTimerCount()).toBe(0); // working sessions are left alone
    vi.advanceTimersByTime(60 * 60_000);
    expect(runner.status(id)).toBe('working');

    await runner.end(id);
    releaseGate();
    await finishedPromise;
  });

  it('leaves no pending timer once a session ends, and dispose() clears the rest', async () => {
    const { runner, id } = await idlingRunner(15 * 60_000);
    await runner.end(id);
    expect(vi.getTimerCount()).toBe(0);

    const second = await idlingRunner(15 * 60_000);
    expect(vi.getTimerCount()).toBe(1);
    second.runner.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60 * 60_000);
    expect(second.runner.status(second.id)).toBe('needs_input');
  });
});
