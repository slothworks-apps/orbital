import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hub } from '../src/api/hub.js';
import {
  APPROVED_PLAN_MODE,
  IDLE_NEVER,
  Runner,
  contextUsedFromAssistantUsage,
  contextUsedFromCompactBoundary,
  contextUsedFromContextUsage,
  decisionKindFor,
  parseIdleTimeoutMs,
  sdkToChatMessages,
} from '../src/runner/runner.js';
import type { PermissionMode } from '../src/types.js';

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

/**
 * Fake SDK whose output stream the test writes itself, message by message.
 *
 * `fakeQueryFn` answers every input with a canned turn, which is the wrong
 * shape for anything about *when* a turn begins and ends: the CLI emits
 * frames the Runner never asked for (a background agent's task events, the
 * turn it starts by itself when one reports back), and those have to be
 * placeable exactly where the assertion needs them. `push()` hands the pump
 * one message — `session_id` is stamped on for you — and the generator waits
 * on the next one rather than ever finishing.
 */
function scriptedQueryFn() {
  const queue: any[] = [];
  let notify: (() => void) | null = null;
  let closed = false;
  let sid = 'unpinned';
  const wake = () => {
    const resume = notify;
    notify = null;
    resume?.();
  };
  const fn = ({ options }: { prompt: AsyncIterable<any>; options: any }) => {
    sid = sessionIdOf(options);
    async function* gen() {
      for (;;) {
        while (queue.length) yield { session_id: sid, ...queue.shift() };
        if (closed) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    }
    return gen() as any;
  };
  return {
    fn,
    push(msg: Record<string, unknown>) {
      queue.push(msg);
      wake();
    },
    close() {
      closed = true;
      wake();
    },
  };
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

  it('reports the resolved model from system/init', async () => {
    const hub = new Hub();
    const seen: Array<[string, string | null]> = [];
    const fn = ({ prompt, options }: any) => {
      const sid = options.sessionId ?? options.resume;
      async function* gen() {
        for await (const _m of prompt) {
          yield { type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5' };
          yield { type: 'result', subtype: 'success', session_id: sid, usage: {} };
        }
      }
      return gen() as any;
    };
    const runner = new Runner({ hub, queryFn: fn, onInit: (id, model) => seen.push([id, model]) });
    const id = await runner.start({ cwd: '/w', prompt: 'hi', permissionMode: 'acceptEdits' });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual([id, 'claude-opus-5']);
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

  it('a turn the CLI starts by itself puts the session back to working', async () => {
    const hub = new Hub();
    const script = scriptedQueryFn();
    const runner = new Runner({ hub, queryFn: script.fn as any, newSessionId: () => 'web-1' });
    await runner.start({ cwd: '/p', prompt: 'go', permissionMode: 'acceptEdits' });

    script.push({ type: 'result', subtype: 'success', usage: {} });
    await vi.waitFor(() => expect(runner.status('web-1')).toBe('needs_input'));

    // Nobody called send(): this is the CLI waking itself up — a background
    // agent reporting back, a queued message, a hook. The frame IS the turn
    // starting, and a map that keeps saying NEEDS INPUT through a whole
    // streamed answer is asking for something nobody owes it.
    script.push({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'resumed' }] },
    });
    await vi.waitFor(() => expect(runner.status('web-1')).toBe('working'));

    script.push({ type: 'result', subtype: 'success', usage: {} });
    await vi.waitFor(() => expect(runner.status('web-1')).toBe('needs_input'));
  });

  it("a subagent's own frames do not restart the main loop's turn", async () => {
    const hub = new Hub();
    const script = scriptedQueryFn();
    const runner = new Runner({ hub, queryFn: script.fn as any, newSessionId: () => 'web-1' });
    const events = subscribed(hub, 'session:web-1');
    await runner.start({ cwd: '/p', prompt: 'go', permissionMode: 'acceptEdits' });

    script.push({ type: 'result', subtype: 'success', usage: {} });
    await vi.waitFor(() => expect(runner.status('web-1')).toBe('needs_input'));

    // `parent_tool_use_id` set: this is a subagent talking, not the session's
    // own loop. Whether such a session is busy is `hasLiveSubagents`'s answer
    // (unwired here), never a stray frame's.
    script.push({
      type: 'assistant',
      parent_tool_use_id: 'toolu_1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'agent thinking' }] },
    });
    // A second `result` behind it, purely as the fence this can wait on: the
    // frame above must have been drained before the status is read.
    script.push({ type: 'result', subtype: 'success', usage: {} });
    await vi.waitFor(() =>
      expect(events.filter((e) => e.event === 'turn_result')).toHaveLength(2),
    );
    expect(runner.status('web-1')).toBe('needs_input');
  });

  it('a task event landing between send() and the CLI\'s first frame does not undo the send', async () => {
    const hub = new Hub();
    const script = scriptedQueryFn();
    const runner = new Runner({
      hub,
      queryFn: script.fn as any,
      newSessionId: () => 'web-1',
      // Answers "nothing running" — the shape that made this a bug: the
      // session's turn was over, so only `send()`'s own mark stands between
      // the user's message and a status that says nobody sent one.
      hasLiveSubagents: () => false,
    });
    const events = subscribed(hub, 'session:web-1');
    await runner.start({ cwd: '/p', prompt: 'go', permissionMode: 'acceptEdits' });
    script.push({ type: 'result', subtype: 'success', usage: {} });
    await vi.waitFor(() => expect(runner.status('web-1')).toBe('needs_input'));

    runner.send('web-1', 'next');
    expect(runner.status('web-1')).toBe('working');
    script.push({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    // The fence: a subagent's frame publishes a message and is the one kind
    // of frame that does NOT mark the turn as running, so waiting on it
    // proves the task event above has been drained without repairing the
    // status on the way through.
    script.push({
      type: 'assistant',
      parent_tool_use_id: 'toolu_1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'drained' }] },
    });
    await vi.waitFor(() =>
      expect(events.filter((e) => e.event === 'message')).toHaveLength(1),
    );
    expect(runner.status('web-1')).toBe('working');
  });

  it('a turn that ends with a background agent still running stays working until it reports back', async () => {
    const hub = new Hub();
    const script = scriptedQueryFn();
    // Stands in for `SubagentStore`: the runner reads liveness back out of
    // whatever consumed its task events, so the two see one set.
    const live = new Set<string>();
    const runner = new Runner({
      hub,
      queryFn: script.fn as any,
      newSessionId: () => 'web-1',
      onTaskEvent: (_id, msg: any) => {
        if (msg.subtype === 'task_started') live.add(msg.task_id);
        if (msg.subtype === 'task_notification') live.delete(msg.task_id);
      },
      hasLiveSubagents: () => live.size > 0,
    });
    const events = subscribed(hub, 'session:web-1');
    await runner.start({ cwd: '/p', prompt: 'go', permissionMode: 'acceptEdits' });

    script.push({
      type: 'system', subtype: 'task_started',
      task_id: 't1', task_type: 'local_agent', description: 'dig',
      is_backgrounded: true,
    });
    // `Agent` is backgrounded, so the turn that launched it ends right away.
    script.push({ type: 'result', subtype: 'success', usage: {} });
    await vi.waitFor(() =>
      expect(events.filter((e) => e.event === 'turn_result')).toHaveLength(1),
    );
    expect(runner.status('web-1')).toBe('working');

    script.push({
      type: 'system', subtype: 'task_notification',
      task_id: 't1', status: 'completed',
    });
    await vi.waitFor(() => expect(runner.status('web-1')).toBe('needs_input'));
  });

  it('interrupt() calls the SDK interrupt', async () => {
    const hub = new Hub();
    const { fn, interrupt } = fakeQueryFn();
    const runner = new Runner({ hub, queryFn: fn as any, newSessionId: () => 'web-1' });
    await runner.start({ cwd: '/p', prompt: 'x', permissionMode: 'plan' });
    await runner.interrupt('web-1');
    expect(interrupt).toHaveBeenCalled();
  });

  it('setModel forwards to the live query', async () => {
    const hub = new Hub();
    const setModel = vi.fn(async () => {});
    const fn = ({ prompt, options }: any) => {
      const sid = options.sessionId ?? options.resume;
      async function* gen() { for await (const _m of prompt) { yield { type: 'result', subtype: 'success', session_id: sid, usage: {} }; } }
      const g = gen() as any;
      g.setModel = setModel;
      return g;
    };
    const runner = new Runner({ hub, queryFn: fn });
    const id = await runner.start({ cwd: '/w', prompt: 'hi', permissionMode: 'acceptEdits' });
    await runner.setModel(id, 'haiku');
    expect(setModel).toHaveBeenCalledWith('haiku');
  });

  it('setModel throws for a session it does not run', async () => {
    const runner = new Runner({ hub: new Hub(), queryFn: fakeQueryFn().fn });
    await expect(runner.setModel('nope', 'haiku')).rejects.toThrow('not active');
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

  // The packaged app spawns the user's own CLI rather than the SDK's bundled
  // binary (spec 2026-09-16-electron-wrapper-design § 2); in dev there is no
  // path to pass and the SDK's default must stay untouched.
  it('hands the SDK an explicit claude executable when it was given one, and omits the option otherwise', async () => {
    const capture = () => {
      let captured: any;
      const fn = (args: any) => {
        captured = args.options;
        return fakeQueryFn().fn(args);
      };
      return { fn, options: () => captured };
    };

    const withPath = capture();
    const runner = new Runner({
      hub: new Hub(), queryFn: withPath.fn as any, newSessionId: () => 'web-1',
      claudeExecutablePath: '/x/claude',
    });
    await runner.start({ cwd: '/p', prompt: 'x', permissionMode: 'acceptEdits' });
    expect(withPath.options().pathToClaudeCodeExecutable).toBe('/x/claude');

    const without = capture();
    const bundled = new Runner({
      hub: new Hub(), queryFn: without.fn as any, newSessionId: () => 'web-2',
    });
    await bundled.start({ cwd: '/p', prompt: 'x', permissionMode: 'acceptEdits' });
    expect(without.options()).not.toHaveProperty('pathToClaudeCodeExecutable');
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

  it('start() pins a caller-supplied sessionId instead of minting one', async () => {
    const hub = new Hub();
    const { fn } = fakeQueryFn();
    let captured: any;
    const runner = new Runner({
      hub,
      queryFn: ((args: any) => { captured = args.options; return fn(args); }) as any,
      newSessionId: () => 'minted-and-unwanted',
    });
    // Subscribing *before* the launch is the whole point of letting the
    // caller pin one: the browser mints the id, joins `session:<id>`, and
    // only then asks for the session, so the first turn cannot publish into
    // a topic nobody is in yet.
    const received = subscribed(hub, 'session:from-the-browser');
    const id = await runner.start({
      cwd: '/p', prompt: 'hello', permissionMode: 'acceptEdits',
      sessionId: 'from-the-browser',
    });
    expect(id).toBe('from-the-browser');
    // Handed to the CLI too, not merely returned — otherwise the process
    // would run under an id nothing else agrees on.
    expect(captured.sessionId).toBe('from-the-browser');
    expect(runner.active()).toEqual(['from-the-browser']);
    await vi.waitFor(() =>
      expect(received.find((r) => r.event === 'message')?.message.text).toBe('echo:hello'),
    );
  });

  it('start() lets resume win over a supplied sessionId', async () => {
    const hub = new Hub();
    const { fn } = fakeQueryFn();
    let captured: any;
    const runner = new Runner({
      hub,
      queryFn: ((args: any) => { captured = args.options; return fn(args); }) as any,
      newSessionId: () => 'web-1',
    });
    const id = await runner.start({
      cwd: '/p', prompt: 'x', permissionMode: 'plan',
      resume: 'old-1', sessionId: 'from-the-browser',
    });
    // A resumed session's id is already fixed by its transcript, and the two
    // are mutually exclusive in the SDK — so the pin must not even reach the
    // options object.
    expect(id).toBe('old-1');
    expect(captured.resume).toBe('old-1');
    expect(captured.sessionId).toBeUndefined();
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
    expect((rejected[0]).reason.message).toMatch(/collision/);
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

  it('carries the model on assistant chat messages', () => {
    const msgs = sdkToChatMessages(
      { type: 'assistant', session_id: 's', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'hi' }] } },
      (() => { let n = 0; return () => ++n; })(),
    );
    expect(msgs[0].model).toBe('claude-opus-5');
  });

  it('sdkToChatMessages: stores live image blocks and emits refs, never base64', () => {
    const puts: string[] = [];
    const store = {
      put: (mediaType: string, base64: string) => {
        puts.push(base64);
        return { ref: `${'0'.repeat(63)}1.png`, w: 10, h: 20, bytes: 5 };
      },
    };
    const imageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'LIVEB64' } };
    const nextSeq = (() => { let n = 0; return () => ++n; })();

    const userMsgs = sdkToChatMessages(
      { type: 'user', session_id: 's', message: { role: 'user', content: [imageBlock] } },
      nextSeq, store,
    );
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0]).toMatchObject({ role: 'user', images: [{ ref: `${'0'.repeat(63)}1.png`, w: 10, h: 20 }] });

    const resultMsgs = sdkToChatMessages(
      {
        type: 'user', session_id: 's',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'shot' }, imageBlock] }] },
      },
      nextSeq, store,
    );
    expect(resultMsgs[0]).toMatchObject({ role: 'tool_result', text: 'shot' });
    expect(resultMsgs[0].images).toHaveLength(1);
    expect(JSON.stringify([userMsgs, resultMsgs])).not.toContain('LIVEB64');
    expect(puts).toEqual(['LIVEB64', 'LIVEB64']);
  });

  it('splits a live user turn\'s command expansion, same as the indexed path', () => {
    const msgs = sdkToChatMessages(
      {
        type: 'user', session_id: 's',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'go <command-name>/commit</command-name><command-contents>body</command-contents>' }],
        },
      },
      (() => { let n = 0; return () => ++n; })(),
    );
    expect(msgs[0]).toMatchObject({ role: 'user', text: 'go' });
    expect(msgs[0].command).toMatchObject({ name: '/commit', blocks: 2 });
  });

  it('marks a live failed tool_result with isError', () => {
    const msgs = sdkToChatMessages(
      { type: 'user', session_id: 's', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'boom', is_error: true }] } },
      (() => { let n = 0; return () => ++n; })(),
    );
    expect(msgs[0].isError).toBe(true);
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
      const ms = parseIdleTimeoutMs(raw);
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

describe('Runner subagent reporting', () => {
  /** Fake SDK that runs one Task subagent and then reports its result. */
  function fakeQueryFnWithSubagent() {
    return ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
      const sid = sessionIdOf(options);
      async function* gen() {
        for await (const _userMsg of prompt) {
          yield { type: 'system', subtype: 'init', session_id: sid };
          yield {
            type: 'assistant', session_id: sid,
            message: {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 't1', name: 'Task', input: { description: 'reviewer' } },
              ],
            },
          };
          yield {
            type: 'user', session_id: sid,
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 't1', content: 'reviewed' }],
            },
          };
          yield { type: 'result', subtype: 'success', session_id: sid, usage: {} };
        }
      }
      return gen() as any;
    };
  }

  it('reports Task blocks from its own SDK stream, with no transcript watching involved', async () => {
    const hub = new Hub();
    const seen: Array<{ sessionId: string; entries: any[] }> = [];
    const runner = new Runner({
      hub,
      queryFn: fakeQueryFnWithSubagent() as any,
      onEntries: (sessionId, entries) => seen.push({ sessionId, entries }),
    });
    const id = await runner.start({ cwd: '/w', prompt: 'go', permissionMode: 'acceptEdits' });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(2), { timeout: 3000 });

    expect(seen.every((s) => s.sessionId === id)).toBe(true);
    const blocks = seen.flatMap((s) => s.entries.flatMap((e: any) => e.message.content));
    expect(blocks).toContainEqual(
      expect.objectContaining({ type: 'tool_use', id: 't1', name: 'Task' }),
    );
    expect(blocks).toContainEqual(expect.objectContaining({ type: 'tool_result', tool_use_id: 't1' }));
    await runner.end(id);
  });

  /**
   * Fake SDK that streams one agent's whole task lifecycle, mixed in with the
   * `system` subtypes that must not be mistaken for it.
   */
  function fakeQueryFnWithTaskEvents() {
    return ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
      const sid = sessionIdOf(options);
      async function* gen() {
        for await (const _userMsg of prompt) {
          yield { type: 'system', subtype: 'init', session_id: sid };
          yield { type: 'system', subtype: 'commands_changed', commands: [], session_id: sid };
          yield {
            type: 'system', subtype: 'task_started', session_id: sid,
            task_id: 'k1', tool_use_id: 't1', description: 'reviewer',
            subagent_type: 'code-reviewer', task_type: 'local_agent', is_backgrounded: true,
          };
          yield { type: 'system', subtype: 'task_progress', session_id: sid, task_id: 'k1' };
          yield {
            type: 'system', subtype: 'background_tasks_changed', session_id: sid,
            tasks: [{ task_id: 'k1', task_type: 'local_agent', description: 'reviewer' }],
          };
          // Another session's task event: the id filter must drop it.
          yield {
            type: 'system', subtype: 'task_started', session_id: 'someone-else',
            task_id: 'k9', description: 'stray', task_type: 'local_agent',
          };
          yield {
            type: 'system', subtype: 'task_notification', session_id: sid,
            task_id: 'k1', tool_use_id: 't1', status: 'completed', summary: 'done',
          };
          yield { type: 'result', subtype: 'success', session_id: sid, usage: {} };
        }
      }
      return gen() as any;
    };
  }

  it('forwards only the three task lifecycle system messages to onTaskEvent', async () => {
    const hub = new Hub();
    const seen: Array<{ sessionId: string; msg: any }> = [];
    const runner = new Runner({
      hub,
      queryFn: fakeQueryFnWithTaskEvents() as any,
      onTaskEvent: (sessionId, msg) => seen.push({ sessionId, msg }),
    });
    const id = await runner.start({ cwd: '/w', prompt: 'go', permissionMode: 'acceptEdits' });
    await vi.waitFor(() => expect(seen.length).toBe(3), { timeout: 3000 });

    expect(seen.every((s) => s.sessionId === id)).toBe(true);
    expect(seen.map((s) => s.msg.subtype)).toEqual([
      'task_started',
      'background_tasks_changed',
      'task_notification',
    ]);
    await runner.end(id);
  });
});

describe('Runner error reporting', () => {
  /**
   * Fake SDK whose generator throws instead of yielding a result — the shape
   * of every "the CLI never started" failure: ENOENT on spawn, a logged-out
   * CLI, a crash mid-turn.
   */
  function fakeQueryFnThrowing(err: unknown) {
    return ({ options }: { prompt: AsyncIterable<any>; options: any }) => {
      const sid = sessionIdOf(options);
      async function* gen() {
        yield { type: 'system', subtype: 'init', session_id: sid };
        throw err;
      }
      return gen() as any;
    };
  }

  let warn: any;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('calls onError with what was thrown and still ends the session', async () => {
    const hub = new Hub();
    const boom = new Error('spawn claude ENOENT');
    const seen: Array<{ sessionId: string; err: unknown }> = [];
    const runner = new Runner({
      hub,
      queryFn: fakeQueryFnThrowing(boom) as any,
      onError: (sessionId, err) => seen.push({ sessionId, err }),
    });
    const id = await runner.start({ cwd: '/w', prompt: 'go', permissionMode: 'acceptEdits' });

    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 3000 });
    expect(seen[0].sessionId).toBe(id);
    // The thrown value itself, not a string of it — the wiring in index.ts is
    // what decides how to render a stack.
    expect(seen[0].err).toBe(boom);

    // The session still ends the ordinary way: no new status, no stuck planet.
    await vi.waitFor(() => expect(runner.status(id)).toBe('ended'), { timeout: 3000 });
    expect(runner.active()).not.toContain(id);
    // And the terminal keeps saying it too.
    expect(warn).toHaveBeenCalledWith('orbital: runner pump error:', boom);
  });

  it('publishes the ended status even with no onError wired at all', async () => {
    const hub = new Hub();
    const received = subscribed(hub, 'session:pinned');
    const runner = new Runner({
      hub,
      queryFn: fakeQueryFnThrowing(new Error('nope')) as any,
      newSessionId: () => 'pinned',
    });
    const id = await runner.start({ cwd: '/w', prompt: 'go', permissionMode: 'acceptEdits' });
    await vi.waitFor(() => expect(runner.status(id)).toBe('ended'), { timeout: 3000 });
    expect(received).toContainEqual({
      topic: 'session:pinned', event: 'status', status: 'ended',
    });
  });

  it('a reporter that throws does not stop the session from ending', async () => {
    const hub = new Hub();
    const runner = new Runner({
      hub,
      queryFn: fakeQueryFnThrowing(new Error('first')) as any,
      onError: () => { throw new Error('the reporter itself broke'); },
    });
    const id = await runner.start({ cwd: '/w', prompt: 'go', permissionMode: 'acceptEdits' });
    await vi.waitFor(() => expect(runner.status(id)).toBe('ended'), { timeout: 3000 });
  });
});

describe('Runner error reporting — what the session was trying to run', () => {
  function fakeQueryFnThrowing(err: unknown) {
    return ({ options }: { prompt: AsyncIterable<any>; options: any }) => {
      const sid = sessionIdOf(options);
      async function* gen() {
        yield { type: 'system', subtype: 'init', session_id: sid };
        throw err;
      }
      return gen() as any;
    };
  }

  let warn: any;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  /**
   * The whole point of recording a spawn failure is being able to say WHICH
   * directory could not be run in. `index.ts` cannot read that off the
   * sessions row and rely on it — `POST /api/sessions` inserts the row only
   * after `start()` returns — so the Runner hands it over itself.
   */
  it('hands onError the cwd, permission mode and model the session was started with', async () => {
    const hub = new Hub();
    const seen: Array<{ attempt: unknown }> = [];
    const runner = new Runner({
      hub,
      queryFn: fakeQueryFnThrowing(new Error('spawn claude ENOENT')) as any,
      onError: (_sessionId, _err, attempt) => seen.push({ attempt }),
    });
    await runner.start({
      cwd: '/deleted/project',
      prompt: 'go',
      permissionMode: 'bypassPermissions',
      model: 'opus',
    });

    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 3000 });
    expect(seen[0].attempt).toEqual({
      cwd: '/deleted/project',
      permissionMode: 'bypassPermissions',
      model: 'opus',
    });
  });

  it('reports a null model rather than omitting it when none was asked for', async () => {
    const hub = new Hub();
    const seen: Array<{ attempt: any }> = [];
    const runner = new Runner({
      hub,
      queryFn: fakeQueryFnThrowing(new Error('nope')) as any,
      onError: (_sessionId, _err, attempt) => seen.push({ attempt }),
    });
    await runner.start({ cwd: '/w', prompt: 'go', permissionMode: 'acceptEdits' });

    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 3000 });
    expect(seen[0].attempt.model).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The composer's two additions: the session's command list, and attachments
// riding along with a prompt (spec: 2026-09-20-composer-design § Server)
// ---------------------------------------------------------------------------

/** The two rows the CLI actually answers `supportedCommands()` with. */
const COMMANDS = [
  { name: 'clear', description: 'Clear conversation history', argumentHint: '' },
  { name: 'usage', description: 'Show plan usage', argumentHint: '', aliases: ['cost', 'stats'] },
];

/**
 * Fake SDK that answers `supportedCommands()` and counts the asks, so the
 * per-session cache is observable. Its generator parks rather than ending, the
 * way a live session's does — a session whose query has finished has no live
 * query to ask.
 */
function fakeQueryFnWithCommands(commands: unknown[] = COMMANDS) {
  const asks = { count: 0 };
  const fn = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
    const sid = sessionIdOf(options);
    async function* gen() {
      for await (const _msg of prompt) {
        yield { type: 'result', subtype: 'success', session_id: sid, usage: {} };
      }
    }
    const g = gen() as any;
    g.supportedCommands = async () => {
      asks.count += 1;
      return commands;
    };
    return g;
  };
  return { fn, asks };
}

describe('Runner commands', () => {
  it('answers the live query\'s supportedCommands, shaped for the popup', async () => {
    const runner = new Runner({
      hub: new Hub(), queryFn: fakeQueryFnWithCommands().fn as any, newSessionId: () => 'web-1',
    });
    await runner.start({ cwd: '/w', prompt: 'hi', permissionMode: 'plan' });

    expect(await runner.commands('web-1')).toEqual([
      { name: 'clear', description: 'Clear conversation history' },
      { name: 'usage', description: 'Show plan usage', aliases: ['cost', 'stats'] },
    ]);
  });

  it('keeps an argument hint when the CLI gives one', async () => {
    const { fn } = fakeQueryFnWithCommands([
      { name: 'add-dir', description: 'Add a directory', argumentHint: '<path>' },
    ]);
    const runner = new Runner({ hub: new Hub(), queryFn: fn as any, newSessionId: () => 'web-1' });
    await runner.start({ cwd: '/w', prompt: 'hi', permissionMode: 'plan' });

    expect(await runner.commands('web-1')).toEqual([
      { name: 'add-dir', description: 'Add a directory', argumentHint: '<path>' },
    ]);
  });

  it('asks the CLI once and serves the cache after that', async () => {
    const { fn, asks } = fakeQueryFnWithCommands();
    const runner = new Runner({ hub: new Hub(), queryFn: fn as any, newSessionId: () => 'web-1' });
    await runner.start({ cwd: '/w', prompt: 'hi', permissionMode: 'plan' });

    await runner.commands('web-1');
    await runner.commands('web-1');
    expect(asks.count).toBe(1);
  });

  it('null for a session it does not run, and for one that has ended', async () => {
    const { fn } = fakeQueryFnWithCommands();
    const runner = new Runner({ hub: new Hub(), queryFn: fn as any, newSessionId: () => 'web-1' });
    expect(await runner.commands('never-heard-of-it')).toBeNull();

    await runner.start({ cwd: '/w', prompt: 'hi', permissionMode: 'plan' });
    await runner.end('web-1');
    expect(await runner.commands('web-1')).toBeNull();
  });

  it('a fresh session after an end does not inherit the ended one\'s cache', async () => {
    let commands = [{ name: 'first', description: 'one', argumentHint: '' }];
    const fn = ({ prompt, options }: any) => {
      const sid = sessionIdOf(options);
      async function* gen() { for await (const _m of prompt) yield { type: 'result', session_id: sid, usage: {} }; }
      const g = gen() as any;
      g.supportedCommands = async () => commands;
      return g;
    };
    const runner = new Runner({ hub: new Hub(), queryFn: fn as any, newSessionId: () => 'web-1' });
    await runner.start({ cwd: '/w', prompt: 'hi', permissionMode: 'plan' });
    expect((await runner.commands('web-1'))!.map((c) => c.name)).toEqual(['first']);
    await runner.end('web-1');

    commands = [{ name: 'second', description: 'two', argumentHint: '' }];
    await runner.start({ cwd: '/w', prompt: 'hi', permissionMode: 'plan', sessionId: 'web-1' });
    expect((await runner.commands('web-1'))!.map((c) => c.name)).toEqual(['second']);
  });

  it('null rather than a crash when the CLI cannot answer at all', async () => {
    // A CLI too old to know the control request, and one whose answer fails:
    // both are "unknown", which is the route's cue to fall back to the scan.
    const older = ({ prompt, options }: any) => {
      const sid = sessionIdOf(options);
      async function* gen() { for await (const _m of prompt) yield { type: 'result', session_id: sid, usage: {} }; }
      return gen() as any;
    };
    const runner = new Runner({ hub: new Hub(), queryFn: older as any, newSessionId: () => 'web-1' });
    await runner.start({ cwd: '/w', prompt: 'hi', permissionMode: 'plan' });
    expect(await runner.commands('web-1')).toBeNull();

    const failing = ({ prompt, options }: any) => {
      const sid = sessionIdOf(options);
      async function* gen() { for await (const _m of prompt) yield { type: 'result', session_id: sid, usage: {} }; }
      const g = gen() as any;
      g.supportedCommands = async () => { throw new Error('control request failed'); };
      return g;
    };
    const runner2 = new Runner({ hub: new Hub(), queryFn: failing as any, newSessionId: () => 'web-2' });
    await runner2.start({ cwd: '/w', prompt: 'hi', permissionMode: 'plan' });
    expect(await runner2.commands('web-2')).toBeNull();
  });

  it('replaces the cache when the CLI pushes a changed list mid-session', async () => {
    // `system/commands_changed` is a fire-and-forget push the SDK documents as
    // "REPLACE your cached list with this" — a skill discovered as the agent
    // moves into a subdirectory shows up without anyone re-asking.
    let pushed!: () => void;
    const pushGate = new Promise<void>((resolve) => { pushed = resolve; });
    const asks = { count: 0 };
    const fn = ({ prompt, options }: any) => {
      const sid = sessionIdOf(options);
      async function* gen() {
        for await (const _m of prompt) {
          yield { type: 'result', subtype: 'success', session_id: sid, usage: {} };
          yield {
            type: 'system', subtype: 'commands_changed', session_id: sid,
            commands: [{ name: 'brand-new', description: 'just discovered', argumentHint: '' }],
          };
          pushed();
        }
      }
      const g = gen() as any;
      g.supportedCommands = async () => { asks.count += 1; return COMMANDS; };
      return g;
    };
    const runner = new Runner({ hub: new Hub(), queryFn: fn as any, newSessionId: () => 'web-1' });
    await runner.start({ cwd: '/w', prompt: 'hi', permissionMode: 'plan' });
    await pushGate;

    await vi.waitFor(async () =>
      expect((await runner.commands('web-1'))!.map((c) => c.name)).toEqual(['brand-new']),
    );
    // The push filled the cache, so nothing had to be asked for.
    expect(asks.count).toBe(0);
  });
});

/** Collects the user messages a fake SDK is handed, content arrays included. */
function capturingQueryFn() {
  const sent: any[] = [];
  const fn = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
    const sid = sessionIdOf(options);
    async function* gen() {
      for await (const userMsg of prompt) {
        sent.push(userMsg);
        yield { type: 'result', subtype: 'success', session_id: sid, usage: {} };
      }
    }
    return gen() as any;
  };
  return { fn, sent };
}

/** An image store that answers `read` for the refs it was seeded with. */
function fakeImages(seed: Record<string, { mediaType: string; base64: string }>) {
  return {
    put: () => null,
    putBytes: () => null,
    read: (ref: string) => seed[ref] ?? null,
  } as any;
}

const REF_PNG = `${'a'.repeat(64)}.png`;
const REF_JPG = `${'b'.repeat(64)}.jpg`;

describe('Runner attachments', () => {
  it('puts one image block per ref before the text block', async () => {
    const { fn, sent } = capturingQueryFn();
    const runner = new Runner({
      hub: new Hub(), queryFn: fn as any, newSessionId: () => 'web-1',
      images: fakeImages({
        [REF_PNG]: { mediaType: 'image/png', base64: 'PNGDATA' },
        [REF_JPG]: { mediaType: 'image/jpeg', base64: 'JPGDATA' },
      }),
    });
    await runner.start({ cwd: '/w', prompt: 'hi', permissionMode: 'plan' });
    await vi.waitFor(() => expect(runner.status('web-1')).toBe('needs_input'));
    runner.send('web-1', 'look at these', [REF_PNG, REF_JPG]);

    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1].message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'PNGDATA' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'JPGDATA' } },
      { type: 'text', text: 'look at these' },
    ]);
  });

  it('a text-only turn is unchanged — one text block, no image blocks', async () => {
    const { fn, sent } = capturingQueryFn();
    const runner = new Runner({ hub: new Hub(), queryFn: fn as any, newSessionId: () => 'web-1' });
    await runner.start({ cwd: '/w', prompt: 'just words', permissionMode: 'plan' });

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].message.content).toEqual([{ type: 'text', text: 'just words' }]);
  });

  it('an image-only turn carries no empty text block', async () => {
    const { fn, sent } = capturingQueryFn();
    const runner = new Runner({
      hub: new Hub(), queryFn: fn as any, newSessionId: () => 'web-1',
      images: fakeImages({ [REF_PNG]: { mediaType: 'image/png', base64: 'PNGDATA' } }),
    });
    await runner.start({ cwd: '/w', prompt: '', permissionMode: 'plan', attachments: [REF_PNG] });

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'PNGDATA' } },
    ]);
  });

  it('empty text and no attachments enqueues nothing, and parks in needs_input', async () => {
    const { fn, sent } = capturingQueryFn();
    const runner = new Runner({ hub: new Hub(), queryFn: fn as any, newSessionId: () => 'web-1' });
    await runner.start({ cwd: '/w', prompt: '', permissionMode: 'plan' });
    expect(runner.status('web-1')).toBe('needs_input');
    // And the same on the send path — nothing to say, nothing sent, and the
    // session is not left claiming to be working on it.
    runner.send('web-1', '');
    runner.send('web-1', '', []);
    expect(sent).toEqual([]);
    expect(runner.status('web-1')).toBe('needs_input');
  });

  it('skips a pruned ref silently rather than failing the turn', async () => {
    const { fn, sent } = capturingQueryFn();
    const runner = new Runner({
      hub: new Hub(), queryFn: fn as any, newSessionId: () => 'web-1',
      images: fakeImages({ [REF_PNG]: { mediaType: 'image/png', base64: 'PNGDATA' } }),
    });
    await runner.start({
      cwd: '/w', prompt: 'both of them', permissionMode: 'plan',
      attachments: [REF_PNG, `${'c'.repeat(64)}.png`],
    });

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'PNGDATA' } },
      { type: 'text', text: 'both of them' },
    ]);
  });

  it('a turn of nothing but pruned refs enqueues nothing', async () => {
    const { fn, sent } = capturingQueryFn();
    const runner = new Runner({
      hub: new Hub(), queryFn: fn as any, newSessionId: () => 'web-1',
      images: fakeImages({}),
    });
    await runner.start({ cwd: '/w', prompt: '', permissionMode: 'plan', attachments: [REF_PNG] });
    expect(sent).toEqual([]);
    expect(runner.status('web-1')).toBe('needs_input');
  });

  it('a revive carries its attachments too (start with resume)', async () => {
    const { fn, sent } = capturingQueryFn();
    const runner = new Runner({
      hub: new Hub(), queryFn: fn as any,
      images: fakeImages({ [REF_PNG]: { mediaType: 'image/png', base64: 'PNGDATA' } }),
    });
    await runner.start({
      cwd: '/w', prompt: 'again', permissionMode: 'plan',
      resume: 'old-1', attachments: [REF_PNG],
    });

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].session_id).toBe('old-1');
    expect(sent[0].message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'PNGDATA' } },
      { type: 'text', text: 'again' },
    ]);
  });

  it('drops attachments when there is no image store at all', async () => {
    const { fn, sent } = capturingQueryFn();
    const runner = new Runner({ hub: new Hub(), queryFn: fn as any, newSessionId: () => 'web-1' });
    await runner.start({ cwd: '/w', prompt: 'words', permissionMode: 'plan', attachments: [REF_PNG] });

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].message.content).toEqual([{ type: 'text', text: 'words' }]);
  });
});

// ---------------------------------------------------------------------------
// Interactive decisions: the canUseTool channel
// (spec: 2026-09-20-interactive-decisions-design)
// ---------------------------------------------------------------------------

/**
 * Fake SDK that hands its `canUseTool` back to the test — the callback is the
 * whole channel, and nothing else about the query exercises it. Its generator
 * takes each turn and answers nothing, so the session stays `working` the way
 * it is while the CLI is inside a tool call, and `ask()` blocks exactly like
 * the real one: a promise with no park deadline.
 */
function fakeQueryFnAsking() {
  const sent: any[] = [];
  const controller = new AbortController();
  /** Every mode the CLI was asked to switch to, in order. */
  const modes: string[] = [];
  let options: any;
  const fn = ({ prompt, options: o }: { prompt: AsyncIterable<any>; options: any }) => {
    options = o;
    async function* gen(): AsyncGenerator<any> {
      for await (const userMsg of prompt) sent.push(userMsg);
    }
    const g = gen() as any;
    g.setPermissionMode = async (mode: string) => {
      modes.push(mode);
    };
    return g;
  };
  const ask = (
    input: unknown,
    toolUseID = 'tu-1',
    toolName = 'AskUserQuestion',
    extra: Record<string, unknown> = {},
  ): Promise<any> =>
    options.canUseTool(toolName, input, {
      signal: controller.signal, toolUseID, requestId: 'req-1', ...extra,
    });
  return { fn, ask, sent, modes, abort: () => controller.abort() };
}

const ONE_QUESTION = {
  questions: [
    {
      question: 'Which library should we use?',
      header: 'Library',
      options: [
        { label: 'date-fns', description: 'small' },
        { label: 'luxon', description: 'complete' },
      ],
      multiSelect: false,
    },
  ],
};

const TWO_QUESTIONS = {
  questions: [
    ...ONE_QUESTION.questions,
    {
      question: 'Ship it behind a flag?',
      header: 'Rollout',
      options: [
        { label: 'Yes', description: 'safer' },
        { label: 'No', description: 'simpler' },
      ],
      multiSelect: false,
    },
  ],
};

/** A runner parked on `ONE_QUESTION`, with the hub traffic it produced. */
async function parked(input: unknown = ONE_QUESTION) {
  const hub = new Hub();
  const { fn, ask, sent, abort } = fakeQueryFnAsking();
  const runner = new Runner({ hub, queryFn: fn as any, newSessionId: () => 'web-1' });
  const received = subscribed(hub, 'session:web-1');
  const id = await runner.start({ cwd: '/w', prompt: 'go', permissionMode: 'plan' });
  const decision = ask(input);
  return { runner, id, received, decision, sent, abort, ask };
}

/**
 * A runner parked on a `permission` or `plan` ask — the two kinds that settle
 * with a verdict rather than with answers.
 */
async function parkedOn(
  toolName: string,
  input: Record<string, unknown>,
  permissionMode: PermissionMode = 'plan',
) {
  const hub = new Hub();
  const { fn, ask, sent, modes, abort } = fakeQueryFnAsking();
  const modeEdges: Array<[string, string]> = [];
  const runner = new Runner({
    hub, queryFn: fn as any, newSessionId: () => 'web-1',
    onPermissionMode: (sessionId, mode) => modeEdges.push([sessionId, mode]),
  });
  const received = subscribed(hub, 'session:web-1');
  const id = await runner.start({ cwd: '/w', prompt: 'go', permissionMode });
  const decision = ask(input, 'tu-1', toolName);
  return { runner, id, received, decision, sent, modes, modeEdges, abort, ask };
}

describe('Runner decisions', () => {
  it('parks an AskUserQuestion, announces it, and waits in needs_input', async () => {
    const { runner, id, received } = await parked();
    expect(runner.status(id)).toBe('needs_input');
    expect(received).toContainEqual({
      topic: 'session:web-1',
      event: 'decision_pending',
      decision: { id: 'tu-1', kind: 'question', input: ONE_QUESTION, createdAt: expect.any(Number) },
    });
    // The same decision is on the snapshot, which is what a reloaded page
    // recovers the question from.
    expect(runner.pendingDecision(id)).toMatchObject({ id: 'tu-1', kind: 'question' });
  });

  it('arms no idle timer for a parked question, whatever the setting says', async () => {
    vi.useFakeTimers();
    try {
      const hub = new Hub();
      const { fn, ask } = fakeQueryFnAsking();
      const runner = new Runner({
        hub, queryFn: fn as any, idleTimeoutMs: 15 * 60_000, newSessionId: () => 'web-1',
      });
      const id = await runner.start({ cwd: '/w', prompt: 'go', permissionMode: 'plan' });
      void ask(ONE_QUESTION);
      expect(runner.status(id)).toBe('needs_input');
      expect(vi.getTimerCount()).toBe(0);
      // Not even a live setting change hands it one: an unanswered question
      // has no deadline, mirroring the SDK's own promise.
      runner.setIdleTimeoutMs(5 * 60_000);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(60 * 60_000);
      expect(runner.status(id)).toBe('needs_input');
    } finally {
      vi.useRealTimers();
    }
  });

  it('answerDecision allows with the answers merged into the tool input', async () => {
    const { runner, id, received, decision } = await parked();
    expect(runner.answerDecision(id, 'tu-1', { 'Which library should we use?': 'luxon' })).toBe(true);

    expect(await decision).toEqual({
      behavior: 'allow',
      updatedInput: { ...ONE_QUESTION, answers: { 'Which library should we use?': 'luxon' } },
    });
    expect(received).toContainEqual({
      topic: 'session:web-1', event: 'decision_resolved', decisionId: 'tu-1',
    });
    expect(runner.pendingDecision(id)).toBeNull();
    expect(runner.status(id)).toBe('working');
  });

  it('announces both edges of a park to whoever has to republish the snapshot', async () => {
    const hub = new Hub();
    const { fn, ask } = fakeQueryFnAsking();
    const edges: string[] = [];
    const runner = new Runner({
      hub, queryFn: fn as any, newSessionId: () => 'web-1',
      onDecision: (sessionId) => edges.push(sessionId),
    });
    const id = await runner.start({ cwd: '/w', prompt: 'go', permissionMode: 'plan' });
    void ask(ONE_QUESTION);
    // The `decision_pending` event alone reaches only a client that has this
    // session SELECTED. The map has nothing selected and still has to tell a
    // parked question (NEEDS INPUT) from a finished turn (DONE), and the
    // status is `needs_input` for both — so the snapshot must be resent.
    expect(edges).toEqual([id]);
    runner.answerDecision(id, 'tu-1', { 'Which library should we use?': 'luxon' });
    expect(edges).toEqual([id, id]);
  });

  it('rejects an answer that names a decision that is not the parked one', async () => {
    const { runner, id, decision } = await parked();
    expect(runner.answerDecision(id, 'some-other-tool-use', { a: 'b' })).toBe(false);
    expect(runner.answerDecision('never-heard-of-it', 'tu-1', { a: 'b' })).toBe(false);
    // Still parked, and still the only thing that can settle it.
    expect(runner.pendingDecision(id)).not.toBeNull();

    expect(runner.answerDecision(id, 'tu-1', { 'Which library should we use?': 'luxon' })).toBe(true);
    await decision;
    // The loser of two open windows: right id, already settled.
    expect(runner.answerDecision(id, 'tu-1', { 'Which library should we use?': 'date-fns' })).toBe(false);
  });

  it('send() while parked answers every question with the typed text and enqueues nothing', async () => {
    const { runner, id, decision, sent } = await parked(TWO_QUESTIONS);
    await vi.waitFor(() => expect(sent).toHaveLength(1)); // the starting prompt
    runner.send(id, 'neither, use the stdlib');

    expect(await decision).toEqual({
      behavior: 'allow',
      updatedInput: {
        ...TWO_QUESTIONS,
        answers: {
          'Which library should we use?': 'neither, use the stdlib',
          'Ship it behind a flag?': 'neither, use the stdlib',
        },
      },
    });
    // The text answered the question instead of becoming a turn of its own.
    expect(sent).toHaveLength(1);
    expect(runner.status(id)).toBe('working');
    expect(runner.pendingDecision(id)).toBeNull();
  });

  it('interrupt() settles a parked question as deny', async () => {
    const { runner, id, received, decision } = await parked();
    await runner.interrupt(id);
    expect(await decision).toMatchObject({ behavior: 'deny' });
    expect(received).toContainEqual({
      topic: 'session:web-1', event: 'decision_resolved', decisionId: 'tu-1',
    });
    expect(runner.pendingDecision(id)).toBeNull();
  });

  it('end() settles a parked question as deny — no promise outlives its session', async () => {
    const { runner, id, received, decision } = await parked();
    await runner.end(id);
    expect(await decision).toMatchObject({ behavior: 'deny' });
    expect(received).toContainEqual({
      topic: 'session:web-1', event: 'decision_resolved', decisionId: 'tu-1',
    });
    expect(runner.pendingDecision(id)).toBeNull();
  });

  it('an aborted request drops the decision and tells every client', async () => {
    const { runner, id, received, decision, abort } = await parked();
    abort();
    // The SDK ignores the late result; what matters is that nothing stays
    // parked and no card is left waiting.
    expect(await decision).toMatchObject({ behavior: 'deny' });
    expect(runner.pendingDecision(id)).toBeNull();
    expect(received).toContainEqual({
      topic: 'session:web-1', event: 'decision_resolved', decisionId: 'tu-1',
    });
  });

  it('a second question while one is parked settles the first rather than dropping it', async () => {
    // Defensive: the model is blocked on the first, so this should not happen.
    // If it does, an overwritten resolver would block that tool call forever.
    const { runner, id, decision, ask } = await parked();
    const second = ask(TWO_QUESTIONS, 'tu-2');
    expect(await decision).toMatchObject({ behavior: 'deny' });
    expect(runner.pendingDecision(id)).toMatchObject({ id: 'tu-2' });
    await runner.end(id);
    expect(await second).toMatchObject({ behavior: 'deny' });
  });
});

// ---------------------------------------------------------------------------
// Permission prompts and plan approval: the other two kinds on the same
// envelope (spec: 2026-09-23-permission-and-plan-decisions-design)
// ---------------------------------------------------------------------------

const BASH_INPUT = { command: 'rm -rf build', description: 'Clear the build directory' };
const PLAN_INPUT = { plan: '# Plan\n\n1. Do the thing' };

describe('decisionKindFor', () => {
  it('routes the two named tools and treats everything else as a permission ask', () => {
    expect(decisionKindFor('AskUserQuestion')).toBe('question');
    expect(decisionKindFor('ExitPlanMode')).toBe('plan');
    // Total on purpose: a tool this build has never heard of still gets a
    // surface rather than the synthetic denial that used to be the answer.
    for (const tool of ['Bash', 'Write', 'mcp__linear__create_issue', 'SomeFutureTool']) {
      expect(decisionKindFor(tool)).toBe('permission');
    }
  });
});

describe('Runner permission decisions', () => {
  it('parks an ordinary tool with the bridge copy the CLI sent', async () => {
    const hub = new Hub();
    const { fn, ask } = fakeQueryFnAsking();
    const runner = new Runner({ hub, queryFn: fn as any, newSessionId: () => 'web-1' });
    const received = subscribed(hub, 'session:web-1');
    const id = await runner.start({ cwd: '/w', prompt: 'go', permissionMode: 'acceptEdits' });
    void ask(BASH_INPUT, 'tu-9', 'Bash', {
      title: 'Claude wants to run rm -rf build',
      displayName: 'Run command',
      description: 'Deletes the build directory',
      defaultToNo: true,
    });

    expect(runner.status(id)).toBe('needs_input');
    expect(runner.pendingDecision(id)).toEqual({
      id: 'tu-9',
      kind: 'permission',
      toolName: 'Bash',
      input: BASH_INPUT,
      title: 'Claude wants to run rm -rf build',
      displayName: 'Run command',
      description: 'Deletes the build directory',
      defaultToNo: true,
      createdAt: expect.any(Number),
    });
    expect(received).toContainEqual({
      topic: 'session:web-1',
      event: 'decision_pending',
      decision: expect.objectContaining({ id: 'tu-9', kind: 'permission' }),
    });
  });

  it('carries only the bridge fields the CLI actually sent', async () => {
    // An older CLI sends none of them; an absent field must stay absent
    // rather than travel as an empty string the browser then has to test for.
    const { runner, id } = await parkedOn('Bash', BASH_INPUT, 'acceptEdits');
    expect(runner.pendingDecision(id)).toEqual({
      id: 'tu-1', kind: 'permission', toolName: 'Bash',
      input: BASH_INPUT, createdAt: expect.any(Number),
    });
  });

  it('approving allows the tool with its input untouched', async () => {
    const { runner, id, received, decision } = await parkedOn('Bash', BASH_INPUT, 'acceptEdits');
    expect(runner.answerDecision(id, 'tu-1', { approved: true })).toBe(true);

    // No `updatedInput`: approving a tool must not rewrite what it was asked
    // to do, which is exactly what the question path's `answers` merge does.
    expect(await decision).toEqual({
      behavior: 'allow',
      decisionClassification: 'user_temporary',
    });
    expect(received).toContainEqual({
      topic: 'session:web-1', event: 'decision_resolved', decisionId: 'tu-1',
    });
    expect(runner.pendingDecision(id)).toBeNull();
    expect(runner.status(id)).toBe('working');
  });

  it('declining denies with the reason, and the turn carries on', async () => {
    const { runner, id, decision } = await parkedOn('Bash', BASH_INPUT, 'acceptEdits');
    expect(
      runner.answerDecision(id, 'tu-1', { approved: false, message: 'use git clean instead' }),
    ).toBe(true);
    expect(await decision).toMatchObject({
      behavior: 'deny',
      message: 'use git clean instead',
    });
    // A refused tool is not the end of the turn — the model reads the refusal
    // as this tool's result and picks another route.
    expect(runner.status(id)).toBe('working');
  });

  it('declining without a reason still says something to the model', async () => {
    const { runner, id, decision } = await parkedOn('Bash', BASH_INPUT, 'acceptEdits');
    runner.answerDecision(id, 'tu-1', { approved: false, message: '   ' });
    const result = await decision;
    expect(result.behavior).toBe('deny');
    expect(result.message).toBeTruthy();
  });

  it('refuses a payload that does not fit the parked kind', async () => {
    const { runner, id, decision } = await parkedOn('Bash', BASH_INPUT, 'acceptEdits');
    // Question answers at a permission prompt: merging them would both
    // corrupt the command and approve it.
    expect(runner.answerDecision(id, 'tu-1', { 'Which library?': 'luxon' })).toBe(false);
    expect(runner.pendingDecision(id)).not.toBeNull();

    // And the mirror: a verdict at a parked question.
    const q = await parked();
    expect(q.runner.answerDecision(q.id, 'tu-1', { approved: true })).toBe(false);
    expect(q.runner.pendingDecision(q.id)).not.toBeNull();

    await runner.end(id);
    await decision;
    await q.runner.end(q.id);
    await q.decision;
  });

  it('does not prompt in bypassPermissions — the mode the user chose to avoid asks', async () => {
    const hub = new Hub();
    const { fn, ask } = fakeQueryFnAsking();
    const runner = new Runner({ hub, queryFn: fn as any, newSessionId: () => 'web-1' });
    const id = await runner.start({
      cwd: '/w', prompt: 'go', permissionMode: 'bypassPermissions',
    });

    expect(await ask(BASH_INPUT, 'tu-2', 'Bash')).toEqual({ behavior: 'allow' });
    expect(runner.pendingDecision(id)).toBeNull();
    expect(runner.status(id)).toBe('working');
  });

  it('still parks a question in bypassPermissions — no mode answers for the human', async () => {
    const hub = new Hub();
    const { fn, ask } = fakeQueryFnAsking();
    const runner = new Runner({ hub, queryFn: fn as any, newSessionId: () => 'web-1' });
    const id = await runner.start({
      cwd: '/w', prompt: 'go', permissionMode: 'bypassPermissions',
    });
    void ask(ONE_QUESTION);
    expect(runner.pendingDecision(id)).toMatchObject({ kind: 'question' });
  });

  it('keeps the bridge copy off a question envelope, where nothing reads it', async () => {
    const hub = new Hub();
    const { fn, ask } = fakeQueryFnAsking();
    const runner = new Runner({ hub, queryFn: fn as any, newSessionId: () => 'web-1' });
    const id = await runner.start({ cwd: '/w', prompt: 'go', permissionMode: 'plan' });
    void ask(ONE_QUESTION, 'tu-1', 'AskUserQuestion', {
      title: 'Claude has a question', displayName: 'Ask', defaultToNo: true,
    });
    expect(runner.pendingDecision(id)).toEqual({
      id: 'tu-1', kind: 'question', input: ONE_QUESTION, createdAt: expect.any(Number),
    });
  });

  it('interrupt and end settle a parked permission exactly once', async () => {
    const { runner, id, decision } = await parkedOn('Bash', BASH_INPUT, 'acceptEdits');
    await runner.interrupt(id);
    expect(await decision).toMatchObject({ behavior: 'deny' });
    expect(runner.pendingDecision(id)).toBeNull();
    // Settled already: a second settle path finds nothing left, which is what
    // makes calling it from every exit harmless.
    expect(runner.answerDecision(id, 'tu-1', { approved: true })).toBe(false);
    await runner.end(id);
  });

  it('composer text declines a permission with the text as the reason', async () => {
    const { runner, id, decision, sent } = await parkedOn('Bash', BASH_INPUT, 'acceptEdits');
    await vi.waitFor(() => expect(sent).toHaveLength(1)); // the starting prompt
    runner.send(id, 'no, run the tests first');

    expect(await decision).toMatchObject({
      behavior: 'deny',
      message: 'no, run the tests first',
    });
    // The text settled the ask instead of becoming a turn of its own — and it
    // did NOT reach the tool's input, which would have approved it.
    expect(sent).toHaveLength(1);
    expect(runner.status(id)).toBe('working');
    expect(runner.pendingDecision(id)).toBeNull();
  });
});

describe('Runner plan approval', () => {
  it('parks ExitPlanMode as its own kind, carrying the plan', async () => {
    const { runner, id } = await parkedOn('ExitPlanMode', PLAN_INPUT);
    expect(runner.pendingDecision(id)).toMatchObject({
      id: 'tu-1', kind: 'plan', toolName: 'ExitPlanMode', input: PLAN_INPUT,
    });
    expect(runner.status(id)).toBe('needs_input');
  });

  it('approving leaves plan mode before it unblocks the tool', async () => {
    const { runner, id, decision, modes, modeEdges } = await parkedOn('ExitPlanMode', PLAN_INPUT);
    expect(runner.answerDecision(id, 'tu-1', { approved: true })).toBe(true);

    // The control request is what actually takes the session out of plan
    // mode; allowing the tool alone would leave it read-only and the approved
    // plan unable to run a single step of itself.
    expect(modes).toEqual([APPROVED_PLAN_MODE]);
    expect(modeEdges).toEqual([[id, APPROVED_PLAN_MODE]]);
    expect(await decision).toMatchObject({ behavior: 'allow' });
  });

  it('declining keeps the session in plan mode', async () => {
    const { runner, id, decision, modes, modeEdges } = await parkedOn('ExitPlanMode', PLAN_INPUT);
    runner.answerDecision(id, 'tu-1', { approved: false, message: 'cover the migration too' });
    expect(await decision).toMatchObject({
      behavior: 'deny', message: 'cover the migration too',
    });
    expect(modes).toEqual([]);
    expect(modeEdges).toEqual([]);
  });

  it('does not rewrite the mode of a session that was never planning', async () => {
    // A model can call the tool from any mode. Approving it there is approving
    // nothing, and must not quietly downgrade an `auto` session.
    const { runner, id, decision, modes } = await parkedOn('ExitPlanMode', PLAN_INPUT, 'auto');
    runner.answerDecision(id, 'tu-1', { approved: true });
    expect(modes).toEqual([]);
    expect(await decision).toMatchObject({ behavior: 'allow' });
  });

  it('survives a CLI that cannot answer the mode control request', async () => {
    const hub = new Hub();
    const sent: any[] = [];
    const controller = new AbortController();
    let options: any;
    // No `setPermissionMode` at all — a CLI too old to know the request.
    const fn = ({ prompt, options: o }: any) => {
      options = o;
      async function* gen(): AsyncGenerator<any> {
        for await (const m of prompt) sent.push(m);
      }
      return gen() as any;
    };
    const runner = new Runner({ hub, queryFn: fn as any, newSessionId: () => 'web-1' });
    const id = await runner.start({ cwd: '/w', prompt: 'go', permissionMode: 'plan' });
    const decision = options.canUseTool('ExitPlanMode', PLAN_INPUT, {
      signal: controller.signal, toolUseID: 'tu-1', requestId: 'req-1',
    });
    expect(runner.answerDecision(id, 'tu-1', { approved: true })).toBe(true);
    expect(await decision).toMatchObject({ behavior: 'allow' });
  });
});

// ---------------------------------------------------------------------------
// The editor as a second route to one verdict
// (spec: 2026-09-23-ide-bridge-design § Talking back to the editor)
// ---------------------------------------------------------------------------

const EDIT_INPUT = { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' };

/**
 * A scripted `IdeApprovals` whose `review()` is resolved by the test — which
 * is what makes every failure mode in the spec reachable without an editor:
 * an editor that quits is `finish(null)`, one that never answers is never
 * finishing at all, and the browser winning the race is the abort arriving
 * before `finish`.
 */
function fakeApprovals(opts: { offers?: boolean } = {}) {
  const reviews: any[] = [];
  const finish: Array<(v: any) => void> = [];
  /** Which reviews were abandoned — the abort a settle fires. */
  const aborted: boolean[] = [];
  const ide = {
    offers: () => opts.offers ?? true,
    review: (req: any) => {
      const index = reviews.length;
      reviews.push(req);
      aborted.push(false);
      req.signal.addEventListener('abort', () => {
        aborted[index] = true;
        finish[index]?.(null);
      });
      return new Promise((resolve) => {
        finish[index] = resolve;
      });
    },
  };
  return {
    ide,
    reviews,
    aborted,
    /** The editor answers one review. A microtask turn lets the Runner act. */
    async answer(verdict: any, index = reviews.length - 1) {
      finish[index]?.(verdict);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

/** A runner parked on an edit ask, with an editor showing it as a diff. */
async function parkedWithEditor(
  toolName = 'Edit',
  input: Record<string, unknown> = EDIT_INPUT,
  opts: { offers?: boolean } = {},
) {
  const hub = new Hub();
  const editor = fakeApprovals(opts);
  const { fn, ask, abort } = fakeQueryFnAsking();
  const runner = new Runner({
    hub, queryFn: fn as any, newSessionId: () => 'web-1', ide: editor.ide as any,
  });
  const received = subscribed(hub, 'session:web-1');
  const id = await runner.start({ cwd: '/w', prompt: 'go', permissionMode: 'auto' });
  const decision = ask(input, 'tu-1', toolName);
  // The review is opened off the park, so it is one microtask behind it.
  await Promise.resolve();
  return { runner, id, received, decision, editor, abort };
}

/** How many times the hub was told this decision was settled. */
function resolvedCount(received: any[], decisionId = 'tu-1'): number {
  return received.filter((m) => m.event === 'decision_resolved' && m.decisionId === decisionId)
    .length;
}

describe('Runner decisions — the editor as a second route', () => {
  it('parks the browser card first and opens the diff beside it', async () => {
    const { runner, id, received, editor } = await parkedWithEditor();
    // The card is what owns the decision; the diff is extra. A session with
    // no editor is this same state minus the review.
    expect(runner.pendingDecision(id)).toMatchObject({ id: 'tu-1', kind: 'permission' });
    expect(runner.status(id)).toBe('needs_input');
    expect(received.some((m) => m.event === 'decision_pending')).toBe(true);
    expect(editor.reviews).toHaveLength(1);
    expect(editor.reviews[0]).toMatchObject({ cwd: '/w', toolName: 'Edit', decisionId: 'tu-1' });
  });

  it('opens no diff for a question, a plan, or an editor that cannot show one', async () => {
    const question = await parkedWithEditor('AskUserQuestion', ONE_QUESTION);
    expect(question.editor.reviews).toHaveLength(0);
    const plan = await parkedWithEditor('ExitPlanMode', PLAN_INPUT);
    expect(plan.editor.reviews).toHaveLength(0);
    const unsupported = await parkedWithEditor('Edit', EDIT_INPUT, { offers: false });
    expect(unsupported.editor.reviews).toHaveLength(0);
  });

  it('accepting in the editor allows the tool, with its input untouched', async () => {
    const { runner, id, received, decision, editor } = await parkedWithEditor();
    await editor.answer({ approved: true });
    expect(await decision).toEqual({
      behavior: 'allow', decisionClassification: 'user_temporary',
    });
    expect(runner.status(id)).toBe('working');
    expect(runner.pendingDecision(id)).toBeNull();
    expect(resolvedCount(received)).toBe(1);
  });

  it('carries a hand-edit through as the tool input that reproduces it', async () => {
    const { decision, editor } = await parkedWithEditor();
    const updatedInput = { file_path: '/w/a.ts', old_string: 'a', new_string: 'c' };
    await editor.answer({ approved: true, updatedInput });
    expect(await decision).toMatchObject({ behavior: 'allow', updatedInput });
  });

  it('rejecting in the editor denies the tool and leaves the session working', async () => {
    const { runner, id, decision, editor, received } = await parkedWithEditor();
    await editor.answer({ approved: false, message: 'not like that' });
    expect(await decision).toMatchObject({ behavior: 'deny', message: 'not like that' });
    expect(runner.status(id)).toBe('working');
    expect(resolvedCount(received)).toBe(1);
  });

  // The failure modes, each of which must leave exactly one verdict and no
  // orphaned tab.

  it('the browser answering first wins, and the editor’s later verdict is ignored', async () => {
    const { runner, id, received, decision, editor } = await parkedWithEditor();
    expect(runner.answerDecision(id, 'tu-1', { approved: false, message: 'no' })).toBe(true);
    // Settling abandons the review, which is also what drops the tab.
    expect(editor.aborted[0]).toBe(true);
    // The editor answering afterwards finds nothing parked under that id.
    await editor.answer({ approved: true });
    expect(await decision).toMatchObject({ behavior: 'deny', message: 'no' });
    expect(resolvedCount(received)).toBe(1);
    expect(runner.answerDecision(id, 'tu-1', { approved: true })).toBe(false);
  });

  it('a verdict for a decision that is no longer parked settles nothing', async () => {
    const { runner, id, received, decision, editor, abort } = await parkedWithEditor();
    // The first ask goes away on its own, and a second one parks behind it.
    abort();
    expect(await decision).toMatchObject({ behavior: 'deny' });
    const later = secondAsk(runner, id);
    await Promise.resolve();
    expect(runner.pendingDecision(id)).toMatchObject({ id: 'tu-2' });

    // The FIRST review's verdict arrives late. It names `tu-1`, which is no
    // longer what is parked — so it must answer nothing, least of all `tu-2`.
    // This is the one way two routes could settle one decision wrongly.
    await editor.answer({ approved: true }, 0);
    expect(runner.pendingDecision(id)).toMatchObject({ id: 'tu-2' });
    expect(resolvedCount(received, 'tu-2')).toBe(0);

    runner.answerDecision(id, 'tu-2', { approved: false });
    expect(await later).toMatchObject({ behavior: 'deny' });
    expect(resolvedCount(received, 'tu-2')).toBe(1);
  });

  it('an editor that quits mid-diff leaves the decision parked for the browser', async () => {
    const { runner, id, received, decision, editor } = await parkedWithEditor();
    // The socket went away: the review answers with no verdict at all.
    await editor.answer(null);
    expect(runner.pendingDecision(id)).toMatchObject({ id: 'tu-1' });
    expect(runner.status(id)).toBe('needs_input');
    expect(resolvedCount(received)).toBe(0);
    // And the browser can still answer it, which is the whole point.
    expect(runner.answerDecision(id, 'tu-1', { approved: true })).toBe(true);
    expect(await decision).toMatchObject({ behavior: 'allow' });
    expect(resolvedCount(received)).toBe(1);
  });

  it('a closed tab is not a verdict', async () => {
    // `TAB_CLOSED` reaches the Runner as a null review for the same reason an
    // editor that quit does: neither said yes and neither said no.
    const { runner, id, decision, editor } = await parkedWithEditor();
    await editor.answer(null);
    expect(runner.pendingDecision(id)).not.toBeNull();
    runner.answerDecision(id, 'tu-1', { approved: true });
    expect(await decision).toMatchObject({ behavior: 'allow' });
  });

  it('aborting the request settles once and drops the tab', async () => {
    const { runner, id, received, decision, editor, abort } = await parkedWithEditor();
    abort();
    expect(await decision).toMatchObject({
      behavior: 'deny', message: 'The request was aborted.',
    });
    expect(editor.aborted[0]).toBe(true);
    expect(resolvedCount(received)).toBe(1);
    expect(runner.pendingDecision(id)).toBeNull();
  });

  it('ending the session settles once and drops the tab', async () => {
    const { runner, id, received, decision, editor } = await parkedWithEditor();
    await runner.end(id);
    expect(await decision).toMatchObject({ behavior: 'deny', message: 'The session ended.' });
    expect(editor.aborted[0]).toBe(true);
    expect(resolvedCount(received)).toBe(1);
  });

  it('a review that never answers blocks nothing', async () => {
    // `openDiff` has no deadline on purpose. The promise simply stays
    // pending; the decision is the browser's the whole time.
    const { runner, id, decision, editor } = await parkedWithEditor();
    expect(runner.status(id)).toBe('needs_input');
    expect(runner.answerDecision(id, 'tu-1', { approved: true })).toBe(true);
    expect(await decision).toMatchObject({ behavior: 'allow' });
    expect(editor.aborted[0]).toBe(true);
  });

  it('a review that throws cannot fail the session', async () => {
    const hub = new Hub();
    const { fn, ask } = fakeQueryFnAsking();
    const runner = new Runner({
      hub, queryFn: fn as any, newSessionId: () => 'web-1',
      ide: {
        offers: () => true,
        review: () => Promise.reject(new Error('the socket went away')),
      } as any,
    });
    const id = await runner.start({ cwd: '/w', prompt: 'go', permissionMode: 'auto' });
    const decision = ask(EDIT_INPUT, 'tu-1', 'Edit');
    await Promise.resolve();
    await Promise.resolve();
    expect(runner.pendingDecision(id)).toMatchObject({ id: 'tu-1' });
    runner.answerDecision(id, 'tu-1', { approved: true });
    expect(await decision).toMatchObject({ behavior: 'allow' });
  });
});

/**
 * A second ask on a session whose first one is over — the setup the
 * late-verdict test needs. `decide` is what `canUseTool` is bound to, so
 * calling it directly is the same park the SDK would have made.
 */
function secondAsk(runner: Runner, sessionId: string): Promise<any> {
  return (runner as any).decide(sessionId, 'Edit', EDIT_INPUT, {
    signal: new AbortController().signal, toolUseID: 'tu-2', requestId: 'req-2',
  });
}

// Slash commands the CLI answers by itself (adr:
// notice-rows-are-their-own-kind-of-turn)
// ---------------------------------------------------------------------------

describe('Runner local command output', () => {
  /**
   * Recorded from CLI 2.1.278: a synthetic assistant frame, `<synthetic>` in
   * place of a model, zero usage, and the answer in both the text blocks and
   * the `local_command_source` sibling.
   */
  const SYNTHETIC = {
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      model: '<synthetic>',
      content: [{ type: 'text', text: '## Context Usage\n\n| Messages | 1.3k |' }],
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    local_command_source: '<local-command-stdout>## Context Usage\n\n| Messages | 1.3k |</local-command-stdout>',
    local_command_run: { command: 'context', args: '' },
  };

  it('publishes the answer as a notice, never as an assistant turn', async () => {
    const hub = new Hub();
    const script = scriptedQueryFn();
    const entries: any[] = [];
    const runner = new Runner({
      hub, queryFn: script.fn as any, newSessionId: () => 'web-1',
      onEntries: (_id, e) => entries.push(...e),
    });
    const events = subscribed(hub, 'session:web-1');
    await runner.start({ cwd: '/p', prompt: '/context', permissionMode: 'acceptEdits' });

    script.push(SYNTHETIC);
    script.push({ type: 'result', subtype: 'success', usage: {} });
    await vi.waitFor(() => expect(events.some((e) => e.event === 'turn_result')).toBe(true));

    const messages = events.filter((e) => e.event === 'message').map((e) => e.message);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'notice',
      text: '## Context Usage\n\n| Messages | 1.3k |',
      notice: { level: 'notice', command: '/context' },
    });
    // `<synthetic>` is not a model, and a page of `/context` output is not
    // material for the auto-titler.
    expect(messages[0].model).toBeUndefined();
    expect(entries).toEqual([]);
  });

  it('does not let the frame`s zero usage stand in as the turn`s context reading', async () => {
    const hub = new Hub();
    const script = scriptedQueryFn();
    const used: Array<number | null> = [];
    const runner = new Runner({
      hub, queryFn: script.fn as any, newSessionId: () => 'web-1',
      onContextUsed: (_id, tokens) => used.push(tokens),
    });
    await runner.start({ cwd: '/p', prompt: 'go', permissionMode: 'acceptEdits' });

    // A real call first, so the turn HAS a reading to lose.
    script.push({
      type: 'assistant', parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 9_000 } },
    });
    script.push(SYNTHETIC);
    script.push({ type: 'result', subtype: 'success', usage: {} });

    await vi.waitFor(() => expect(used).toHaveLength(1));
    expect(used[0]).toBe(9_000);
  });

  it('surfaces the system subtypes that carry text, and still ignores the rest', async () => {
    const hub = new Hub();
    const script = scriptedQueryFn();
    const runner = new Runner({ hub, queryFn: script.fn as any, newSessionId: () => 'web-1' });
    const events = subscribed(hub, 'session:web-1');
    await runner.start({ cwd: '/p', prompt: 'go', permissionMode: 'acceptEdits' });

    script.push({ type: 'system', subtype: 'local_command_output', content: 'recording started' });
    script.push({ type: 'system', subtype: 'informational', content: 'a hook blocked it', level: 'warning' });
    script.push({ type: 'system', subtype: 'thinking_tokens', tokens: 5 });
    script.push({ type: 'result', subtype: 'success', usage: {} });
    await vi.waitFor(() => expect(events.some((e) => e.event === 'turn_result')).toBe(true));

    const messages = events.filter((e) => e.event === 'message').map((e) => e.message);
    expect(messages.map((m) => m.text)).toEqual(['recording started', 'a hook blocked it']);
    expect(messages.map((m) => m.notice.level)).toEqual(['notice', 'warning']);
  });
});

// ---------------------------------------------------------------------------
// How full the context is: the arc's numerator (spec: context-fill-arc)
// ---------------------------------------------------------------------------

describe('contextUsedFromAssistantUsage', () => {
  it('sums every field that occupies the window, cache reads included', () => {
    // The four fields one API request is billed on: the prompt it carried
    // (fresh, cache-written and cache-read alike) plus what it wrote back.
    expect(
      contextUsedFromAssistantUsage({
        input_tokens: 1_000,
        cache_read_input_tokens: 120_000,
        cache_creation_input_tokens: 3_000,
        output_tokens: 400,
      }),
    ).toBe(124_400);
  });

  it('counts a missing field as zero rather than giving up on the message', () => {
    // A turn that read nothing from cache simply has no such key.
    expect(contextUsedFromAssistantUsage({ input_tokens: 10, output_tokens: 5 })).toBe(15);
    expect(contextUsedFromAssistantUsage({ cache_read_input_tokens: 7 })).toBe(7);
    // Fields Orbital does not add must not sneak into the total.
    expect(
      contextUsedFromAssistantUsage({ input_tokens: 10, server_tool_use: { web_search_requests: 99 } }),
    ).toBe(10);
  });

  it('is null — not zero — when there is no usage to read', () => {
    // `0` would draw an empty arc on a session whose size is simply unknown,
    // and would erase a real reading from the turn before.
    expect(contextUsedFromAssistantUsage(undefined)).toBeNull();
    expect(contextUsedFromAssistantUsage(null)).toBeNull();
    expect(contextUsedFromAssistantUsage({})).toBeNull();
    expect(contextUsedFromAssistantUsage('123')).toBeNull();
    expect(contextUsedFromAssistantUsage({ input_tokens: '1000' })).toBeNull();
    expect(contextUsedFromAssistantUsage({ input_tokens: NaN })).toBeNull();
  });
});

describe('contextUsedFromContextUsage', () => {
  it("reads the CLI's own total, which is the answer whenever it is available", () => {
    // The shape `getContextUsage()` actually resolves to: flat and
    // camelCase (`SDKControlGetContextUsageResponse`).
    expect(
      contextUsedFromContextUsage({
        model: 'claude-fable-5', totalTokens: 222_559,
        maxTokens: 200_000, rawMaxTokens: 200_000, percentage: 111,
        categories: [{ name: 'Messages', tokens: 180_000, color: '#fff', kind: 'used' }],
      }),
    ).toBe(222_559);
  });

  it('takes the total unclamped, so an over-window session reads as one', () => {
    // The read-out quotes the measurement — only the bar clamps
    // (adr: context-usage-has-one-source).
    expect(contextUsedFromContextUsage({ totalTokens: 260_000, rawMaxTokens: 200_000 })).toBe(260_000);
  });

  it('is null when the CLI answered with nothing usable', () => {
    // A CLI too old to answer the control request, or one that answered
    // without a total: the caller falls back rather than inventing a number.
    expect(contextUsedFromContextUsage(undefined)).toBeNull();
    expect(contextUsedFromContextUsage(null)).toBeNull();
    expect(contextUsedFromContextUsage({})).toBeNull();
    expect(contextUsedFromContextUsage({ totalTokens: 'lots' })).toBeNull();
    expect(contextUsedFromContextUsage({ totalTokens: NaN })).toBeNull();
    // The `/context` result's snake_case twin is a different message and
    // must not be mistaken for this one.
    expect(contextUsedFromContextUsage({ context_usage: { total_tokens: 99 } })).toBeNull();
  });
});

describe('contextUsedFromCompactBoundary', () => {
  it('reads what the compaction left behind', () => {
    expect(
      contextUsedFromCompactBoundary({
        type: 'system', subtype: 'compact_boundary',
        compact_metadata: { trigger: 'manual', pre_tokens: 180_000, post_tokens: 24_000 },
      }),
    ).toBe(24_000);
  });

  it('is null when the boundary does not say how much survived', () => {
    // `post_tokens` is optional in the SDK type; the pre-compaction reading
    // must not be the answer, or the arc stays full after a /compact.
    expect(
      contextUsedFromCompactBoundary({
        type: 'system', subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto', pre_tokens: 180_000 },
      }),
    ).toBeNull();
    expect(contextUsedFromCompactBoundary({ type: 'system', subtype: 'compact_boundary' })).toBeNull();
    expect(contextUsedFromCompactBoundary(null)).toBeNull();
  });
});

describe('Runner context reporting', () => {
  /**
   * One API call's worth of assistant message, with the usage the API
   * returned for it. The real CLI emits one of these per completed content
   * block while a response streams, all sharing `message.id` — hence the
   * explicit id, so a test can re-emit a call the way the CLI does.
   */
  function assistant(sid: string, id: string, usage: Record<string, number>) {
    return {
      type: 'assistant', session_id: sid, parent_tool_use_id: null,
      message: { id, role: 'assistant', content: [{ type: 'text', text: 'x' }], usage },
    };
  }

  /** One API call whose prompt was `ctx` tokens and which wrote `out` back. */
  function call(sid: string, id: string, ctx: number, out: number) {
    return assistant(sid, id, { input_tokens: 2, cache_read_input_tokens: ctx - out - 2, output_tokens: out });
  }

  function fakeQueryFnYielding(messages: (sid: string) => any[], contextUsage?: () => Promise<unknown>) {
    return ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
      const sid = sessionIdOf(options);
      async function* gen() {
        for await (const _m of prompt) {
          for (const msg of messages(sid)) yield msg;
        }
      }
      const g = gen() as any;
      if (contextUsage) g.getContextUsage = contextUsage;
      return g;
    };
  }

  let calls = 0;
  beforeEach(() => { calls = 0; });

  /** Starts a session on `fn` and collects every `onContextUsed` report. */
  async function reporting(fn: any) {
    const seen: Array<[string, number | null]> = [];
    const runner = new Runner({
      hub: new Hub(), queryFn: fn, newSessionId: () => 'web-1',
      onContextUsed: (sessionId, used) => seen.push([sessionId, used]),
    });
    const id = await runner.start({ cwd: '/w', prompt: 'go', permissionMode: 'plan' });
    return { runner, id, seen };
  }

  it("asks the CLI how full the window is, and reports what it says", async () => {
    const { id, seen } = await reporting(
      fakeQueryFnYielding(
        (sid) => [
          call(sid, 'm1', 40_000, 300),
          { type: 'result', subtype: 'success', session_id: sid, usage: { input_tokens: 40_000 } },
        ],
        async () => ({ totalTokens: 41_200, maxTokens: 200_000, rawMaxTokens: 200_000 }),
      ),
    );
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    // The CLI's own figure, not anything derived from the messages: it
    // counts what is queued for the next request, which is the question.
    expect(seen[0]).toEqual([id, 41_200]);
  });

  it("falls back to the turn's last API call when the CLI cannot answer", async () => {
    // A CLI too old for the control request, or one that threw on it. The
    // last call's prompt is still the best evidence of the window's state.
    const { id, seen } = await reporting(
      fakeQueryFnYielding(
        (sid) => [
          call(sid, 'm1', 40_000, 300),
          call(sid, 'm2', 41_500, 200),
          { type: 'result', subtype: 'success', session_id: sid, usage: { input_tokens: 81_500 } },
        ],
        async () => { throw new Error('unknown control request'); },
      ),
    );
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual([id, 41_500]);
  });

  it('does not sum the turn — the regression that read 1.5M into a 200k window', async () => {
    // Session 056a9b26's final turn, verbatim: seven API calls whose
    // per-call usages sum to 1_513_619 because every one of them re-counts
    // the cache read of the whole conversation. The window held 222_559.
    const { id, seen } = await reporting(
      fakeQueryFnYielding((sid) => [
        assistant(sid, 'a1', { input_tokens: 2, cache_read_input_tokens: 209_292, cache_creation_input_tokens: 958, output_tokens: 795 }),
        assistant(sid, 'a2', { input_tokens: 2, cache_read_input_tokens: 210_250, cache_creation_input_tokens: 976, output_tokens: 170 }),
        assistant(sid, 'a3', { input_tokens: 2, cache_read_input_tokens: 211_226, cache_creation_input_tokens: 292, output_tokens: 257 }),
        assistant(sid, 'a4', { input_tokens: 2, cache_read_input_tokens: 211_518, cache_creation_input_tokens: 288, output_tokens: 2_008 }),
        assistant(sid, 'a5', { input_tokens: 2, cache_read_input_tokens: 211_806, cache_creation_input_tokens: 6_467, output_tokens: 2_697 }),
        assistant(sid, 'a6', { input_tokens: 2, cache_read_input_tokens: 218_273, cache_creation_input_tokens: 2_728, output_tokens: 1_047 }),
        assistant(sid, 'a7', { input_tokens: 2, cache_read_input_tokens: 221_001, cache_creation_input_tokens: 1_165, output_tokens: 391 }),
        // What the SDK puts on the result: the turn's total, which is a
        // billing figure and was never a window reading.
        {
          type: 'result', subtype: 'success', session_id: sid,
          usage: { input_tokens: 14, cache_read_input_tokens: 1_493_366, cache_creation_input_tokens: 12_874, output_tokens: 7_365 },
        },
      ]),
    );
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual([id, 222_559]);
    expect(seen[0][1]).not.toBe(1_513_619);
  });

  it('counts one API call once however many blocks the CLI streams it in', async () => {
    // Consecutive assistant messages sharing a `message.id` are the SAME
    // request; adding them would double-count its prompt.
    const { id, seen } = await reporting(
      fakeQueryFnYielding((sid) => [
        assistant(sid, 'm1', { cache_read_input_tokens: 90_000, output_tokens: 40 }),
        assistant(sid, 'm1', { cache_read_input_tokens: 90_000, output_tokens: 900 }),
        { type: 'result', subtype: 'success', session_id: sid, usage: { input_tokens: 1 } },
      ]),
    );
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    // The last emission of that id wins: its usage is the final one.
    expect(seen[0]).toEqual([id, 90_900]);
  });

  it("ignores a subagent's calls, which run in their own window", async () => {
    // `parent_tool_use_id` non-null means the message came from inside a
    // Task subagent. Its context is not this session's context.
    const { id, seen } = await reporting(
      fakeQueryFnYielding((sid) => [
        assistant(sid, 'main', { cache_read_input_tokens: 50_000, output_tokens: 100 }),
        {
          type: 'assistant', session_id: sid, parent_tool_use_id: 'toolu_1',
          message: { id: 'sub', role: 'assistant', content: [], usage: { cache_read_input_tokens: 700_000, output_tokens: 9 } },
        },
        { type: 'result', subtype: 'success', session_id: sid, usage: { input_tokens: 1 } },
      ]),
    );
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual([id, 50_100]);
  });

  it('measures each turn on its own, rather than accumulating across turns', async () => {
    // Two turns, the second reading a bigger window than the first. If the
    // fallback ever added turns together the second would report 100_020.
    const { runner, seen } = await reporting(
      fakeQueryFnYielding((sid) => [
        assistant(sid, 'm' + (++calls), { cache_read_input_tokens: calls * 50_000, output_tokens: 10 }),
        { type: 'result', subtype: 'success', session_id: sid, usage: { input_tokens: 1 } },
      ]),
    );
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    runner.send('web-1', 'again');
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen.map(([, used]) => used)).toEqual([50_010, 100_010]);
  });

  it("reports a compaction's post_tokens, which is what shrinks the arc", async () => {
    const { seen } = await reporting(
      fakeQueryFnYielding((sid) => [
        assistant(sid, 'm1', { cache_read_input_tokens: 180_000, output_tokens: 0 }),
        { type: 'result', subtype: 'success', session_id: sid, usage: { input_tokens: 180_000 } },
        {
          type: 'system', subtype: 'compact_boundary', session_id: sid,
          compact_metadata: { trigger: 'manual', pre_tokens: 180_000, post_tokens: 24_000 },
        },
      ]),
    );
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen.map(([, used]) => used)).toEqual([180_000, 24_000]);
  });

  it('clears the reading when a compaction does not say how much survived', async () => {
    const { seen } = await reporting(
      fakeQueryFnYielding((sid) => [
        assistant(sid, 'm1', { cache_read_input_tokens: 180_000, output_tokens: 0 }),
        { type: 'result', subtype: 'success', session_id: sid, usage: { input_tokens: 180_000 } },
        {
          type: 'system', subtype: 'compact_boundary', session_id: sid,
          compact_metadata: { trigger: 'auto', pre_tokens: 180_000 },
        },
      ]),
    );
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1][1]).toBeNull();
  });

  it('says nothing at all for a turn nothing could measure', async () => {
    // Silence, not null: an unreadable turn is not evidence that the
    // context emptied, so the stored reading must survive it.
    const { runner, seen } = await reporting(
      fakeQueryFnYielding((sid) => [{ type: 'result', subtype: 'success', session_id: sid }]),
    );
    await vi.waitFor(() => expect(runner.status('web-1')).toBe('needs_input'));
    expect(seen).toEqual([]);
  });

  it('ignores a compact boundary belonging to another session', async () => {
    const { seen } = await reporting(
      fakeQueryFnYielding((sid) => [
        {
          type: 'system', subtype: 'compact_boundary', session_id: 'someone-else',
          compact_metadata: { trigger: 'manual', pre_tokens: 9, post_tokens: 1 },
        },
        assistant(sid, 'm1', { input_tokens: 5 }),
        { type: 'result', subtype: 'success', session_id: sid, usage: { input_tokens: 5 } },
      ]),
    );
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0][1]).toBe(5);
  });
});

describe('Runner ownership reporting', () => {
  /** Records every `onOwnership` call as `[sessionId, status]`. */
  function owning() {
    const seen: Array<[string, string | null]> = [];
    const { fn } = fakeQueryFn();
    const hub = new Hub();
    const runner = new Runner({
      hub, queryFn: fn as any, newSessionId: () => 'web-1',
      onOwnership: (id, status) => seen.push([id, status]),
    });
    return { runner, seen };
  }

  it('claims a session the moment start() takes it, before any turn ends', async () => {
    const { runner, seen } = owning();
    await runner.start({ cwd: '/p', prompt: 'hello', permissionMode: 'acceptEdits' });
    // The claim has to land synchronously with start(): a restart most often
    // lands in exactly this window, and `onStatus` cannot report it — a fresh
    // session's state is constructed already at 'working', so the guarded
    // setStatus never fires for the initial transition.
    expect(seen[0]).toEqual(['web-1', 'working']);
  });

  it('reports a session started with no prompt as waiting, not working', async () => {
    const { runner, seen } = owning();
    await runner.start({ cwd: '/p', prompt: '', permissionMode: 'acceptEdits' });
    await vi.waitFor(() => expect(runner.status('web-1')).toBe('needs_input'));
    expect(seen.at(-1)).toEqual(['web-1', 'needs_input']);
  });

  it('follows the session through its turns', async () => {
    const { runner, seen } = owning();
    await runner.start({ cwd: '/p', prompt: 'one', permissionMode: 'plan' });
    await vi.waitFor(() => expect(runner.status('web-1')).toBe('needs_input'));
    runner.send('web-1', 'two');
    await vi.waitFor(() => expect(runner.status('web-1')).toBe('needs_input'));
    expect(seen.map(([, s]) => s)).toEqual(['working', 'needs_input', 'working', 'needs_input']);
  });

  it('releases the session when it ends, so a later boot does not heal it', async () => {
    const { runner, seen } = owning();
    await runner.start({ cwd: '/p', prompt: 'one', permissionMode: 'plan' });
    await vi.waitFor(() => expect(runner.status('web-1')).toBe('needs_input'));
    await runner.end('web-1');
    expect(seen.at(-1)).toEqual(['web-1', null]);
  });

  it('releases a session whose SDK generator ends on its own', async () => {
    const seen: Array<[string, string | null]> = [];
    const { fn } = fakeQueryFnSelfEnding();
    const runner = new Runner({
      hub: new Hub(), queryFn: fn as any, newSessionId: () => 'web-1',
      onOwnership: (id, status) => seen.push([id, status]),
    });
    await runner.start({ cwd: '/p', prompt: 'one', permissionMode: 'plan' });
    await vi.waitFor(() => expect(runner.status('web-1')).toBe('ended'));
    expect(seen.at(-1)).toEqual(['web-1', null]);
  });
});
