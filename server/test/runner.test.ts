import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hub } from '../src/api/hub.js';
import {
  IDLE_NEVER,
  Runner,
  parseIdleTimeoutMs,
  sdkToChatMessages,
} from '../src/runner/runner.js';

/** Fake SDK: echoes each user message, then emits a result. */
function fakeQueryFn() {
  const interrupt = vi.fn(async () => {});
  const fn = ({ prompt }: { prompt: AsyncIterable<any>; options: any }) => {
    async function* gen() {
      yield { type: 'system', subtype: 'init', session_id: 'web-1' };
      for await (const userMsg of prompt) {
        const text = userMsg.message.content[0].text;
        yield {
          type: 'assistant', session_id: 'web-1',
          message: { role: 'assistant', content: [{ type: 'text', text: `echo:${text}` }] },
        };
        yield { type: 'result', subtype: 'success', session_id: 'web-1', usage: { output_tokens: 5 } };
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
  const fn = ({ prompt }: { prompt: AsyncIterable<any>; options: any }) => {
    async function* gen() {
      yield { type: 'system', subtype: 'init', session_id: 'web-1' };
      // Pull exactly one input message off the queue, then finish without
      // looping back to ask for another — the generator just ends.
      const iterator = prompt[Symbol.asyncIterator]();
      await iterator.next();
      yield {
        type: 'assistant', session_id: 'web-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      };
      yield { type: 'result', subtype: 'success', session_id: 'web-1', usage: {} };
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
  const fn = ({ prompt }: { prompt: AsyncIterable<any>; options: any }) => {
    async function* gen() {
      try {
        yield { type: 'system', subtype: 'init', session_id: 'web-1' };
        let turn = 0;
        for await (const userMsg of prompt) {
          turn++;
          const text = userMsg.message.content[0].text;
          if (turn === 1) {
            yield {
              type: 'assistant', session_id: 'web-1',
              message: { role: 'assistant', content: [{ type: 'text', text: `echo:${text}` }] },
            };
            yield { type: 'result', subtype: 'success', session_id: 'web-1', usage: {} };
          } else {
            yield {
              type: 'assistant', session_id: 'web-1',
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

/** Fake SDK that yields a stray assistant message for an unrelated session before the real system/init. */
function fakeQueryFnStrayBeforeInit() {
  const fn = ({ prompt }: { prompt: AsyncIterable<any>; options: any }) => {
    async function* gen() {
      yield {
        type: 'assistant', session_id: 'x',
        message: { role: 'assistant', content: [{ type: 'text', text: 'stray' }] },
      };
      yield { type: 'system', subtype: 'init', session_id: 'web-1' };
      for await (const userMsg of prompt) {
        const text = userMsg.message.content[0].text;
        yield {
          type: 'assistant', session_id: 'web-1',
          message: { role: 'assistant', content: [{ type: 'text', text: `echo:${text}` }] },
        };
        yield { type: 'result', subtype: 'success', session_id: 'web-1', usage: {} };
      }
    }
    return gen() as any;
  };
  return { fn };
}

/** Fake SDK that emits a tool_use then a tool_result in the same turn, each as content index 0. */
function fakeQueryFnToolMessages() {
  const fn = ({ prompt }: { prompt: AsyncIterable<any>; options: any }) => {
    async function* gen() {
      yield { type: 'system', subtype: 'init', session_id: 'web-1' };
      for await (const _userMsg of prompt) {
        yield {
          type: 'assistant', session_id: 'web-1',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }] },
        };
        yield {
          type: 'user', session_id: 'web-1',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
        };
        yield { type: 'result', subtype: 'success', session_id: 'web-1', usage: {} };
      }
    }
    return gen() as any;
  };
  return { fn };
}

/**
 * Fake SDK whose `system/init` message is held back until the test releases
 * a manually-controlled gate — lets a test fire two `start()` calls for the
 * same resume id before either has registered in `Runner.sessions`, to
 * exercise the in-flight reservation race guard.
 */
function fakeQueryFnDelayedInit(sessionId: string) {
  let releaseInit!: () => void;
  const initGate = new Promise<void>((resolve) => { releaseInit = resolve; });
  const fn = ({ prompt }: { prompt: AsyncIterable<any>; options: any }) => {
    async function* gen() {
      await initGate;
      yield { type: 'system', subtype: 'init', session_id: sessionId };
      for await (const userMsg of prompt) {
        const text = userMsg.message.content[0].text;
        yield {
          type: 'assistant', session_id: sessionId,
          message: { role: 'assistant', content: [{ type: 'text', text: `echo:${text}` }] },
        };
        yield { type: 'result', subtype: 'success', session_id: sessionId, usage: {} };
      }
    }
    return gen() as any;
  };
  return { fn, releaseInit: () => releaseInit() };
}

describe('Runner', () => {
  it('starts a session, streams messages, and lands in needs_input after the turn', async () => {
    const hub = new Hub();
    const { fn } = fakeQueryFn();
    const runner = new Runner({ hub, queryFn: fn as any });
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

  it('start() with an empty prompt does not enqueue a first turn; waits in needs_input for send() (I6)', async () => {
    const hub = new Hub();
    const { fn } = fakeQueryFn();
    const runner = new Runner({ hub, queryFn: fn as any });
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
    const runner = new Runner({ hub, queryFn: fn as any });
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
    const runner = new Runner({ hub, queryFn: fn as any });
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
    const runner = new Runner({ hub, queryFn: fn as any });
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
    const runner = new Runner({ hub, queryFn: fn as any });
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
    const runner = new Runner({ hub, queryFn: fn as any });
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

  it('resolves start() only on the system/init message, ignoring stray early messages', async () => {
    const hub = new Hub();
    const { fn } = fakeQueryFnStrayBeforeInit();
    const runner = new Runner({ hub, queryFn: fn as any });
    const id = await runner.start({ cwd: '/p', prompt: 'hello', permissionMode: 'plan' });
    expect(id).toBe('web-1');
  });

  it('assigns distinct message ids even when messages land in the same millisecond', async () => {
    const hub = new Hub();
    const { fn } = fakeQueryFnToolMessages();
    const runner = new Runner({ hub, queryFn: fn as any });
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
    const runner = new Runner({ hub, queryFn: fn as any });
    await runner.start({ cwd: '/p', prompt: 'x', permissionMode: 'plan' });
    await expect(
      runner.start({ cwd: '/p', prompt: 'y', permissionMode: 'plan', resume: 'web-1' }),
    ).rejects.toThrow(/collision/);
  });

  it('start() with two concurrent resumes of the same not-yet-registered session: only one wins (in-flight reservation)', async () => {
    const hub = new Hub();
    const { fn, releaseInit } = fakeQueryFnDelayedInit('old-1');
    const runner = new Runner({ hub, queryFn: fn as any });

    // Fire both start() calls before the SDK's init message arrives for
    // either — neither is registered in `sessions` yet, so without the
    // in-flight reservation both would pass the `sessions.has` check.
    const p1 = runner.start({ cwd: '/p', prompt: 'x', permissionMode: 'plan', resume: 'old-1' });
    const p2 = runner.start({ cwd: '/p', prompt: 'y', permissionMode: 'plan', resume: 'old-1' });
    releaseInit();

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
    const runner = new Runner({ hub, queryFn: fn as any, idleTimeoutMs });
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
    const runner = new Runner({ hub, queryFn: fn as any, idleTimeoutMs: 15 * 60_000 });
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
