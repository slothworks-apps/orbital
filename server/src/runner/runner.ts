import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Hub } from '../api/hub.js';
import type { PermissionMode, SessionStatus, ChatMessage } from '../types.js';

export type QueryFn = (args: {
  prompt: AsyncIterable<unknown>;
  options: Record<string, unknown>;
}) => AsyncGenerator<any> & { interrupt?: () => Promise<void> };

interface ManagedSession {
  status: SessionStatus;
  queue: Array<(msg: unknown | null) => void>;
  pending: Array<unknown | null>;
  generator: (AsyncGenerator<any> & { interrupt?: () => Promise<void> }) | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Converts one SDK message into zero or more ChatMessages.
 * `nextSeq` must return a monotonically increasing number per call — callers
 * (Runner) bind it to a per-instance counter so ids can't collide when two
 * messages land in the same millisecond with the same block index.
 */
export function sdkToChatMessages(sdkMsg: any, nextSeq: () => number): ChatMessage[] {
  const content = sdkMsg.message?.content;
  if (!Array.isArray(content)) return [];
  const out: ChatMessage[] = [];
  content.forEach((block: any, i: number) => {
    const id = `${sdkMsg.session_id}:${nextSeq()}:${i}`;
    if (block.type === 'text' && block.text?.trim()) {
      out.push({ id, role: sdkMsg.type === 'user' ? 'user' : 'assistant', text: block.text });
    } else if (block.type === 'tool_use') {
      out.push({ id, role: 'tool_use', toolName: block.name, toolInput: block.input, toolUseId: block.id });
    } else if (block.type === 'tool_result') {
      out.push({
        id, role: 'tool_result', toolUseId: block.tool_use_id,
        text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
      });
    }
  });
  return out;
}

export class Runner {
  private sessions = new Map<string, ManagedSession>();
  private ended = new Set<string>();
  private seq = 0;
  private hub: Hub;
  private queryFn: QueryFn;
  private idleTimeoutMs: number;
  private onStatus?: (sessionId: string, status: SessionStatus) => void;

  constructor(deps: {
    hub: Hub;
    queryFn?: QueryFn;
    idleTimeoutMs?: number;
    onStatus?: (sessionId: string, status: SessionStatus) => void;
  }) {
    this.hub = deps.hub;
    this.queryFn = deps.queryFn ?? (query as unknown as QueryFn);
    this.idleTimeoutMs = deps.idleTimeoutMs ?? 30 * 60_000;
    this.onStatus = deps.onStatus;
  }

  private setStatus(sessionId: string, status: SessionStatus): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.status === status) return;
    s.status = status;
    this.hub.publish(`session:${sessionId}`, { event: 'status', status });
    this.onStatus?.(sessionId, status);
  }

  private userMessage(sessionId: string, text: string): unknown {
    return {
      type: 'user',
      session_id: sessionId,
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text }] },
    };
  }

  private armIdleTimer(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    const timer = setTimeout(() => void this.end(sessionId), this.idleTimeoutMs);
    // Don't let the idle timer keep the process alive (e.g. during tests).
    (timer as unknown as { unref?: () => void }).unref?.();
    s.idleTimer = timer;
  }

  /** Final state transition shared by explicit end() and natural SDK-generator completion. */
  private finish(sessionId: string): void {
    this.setStatus(sessionId, 'ended');
    this.ended.add(sessionId);
    const s = this.sessions.get(sessionId);
    if (s?.idleTimer) clearTimeout(s.idleTimer);
    this.sessions.delete(sessionId);
  }

  async start(opts: {
    cwd: string;
    prompt: string;
    permissionMode: PermissionMode;
    resume?: string;
    model?: string;
  }): Promise<string> {
    const state: ManagedSession = {
      status: 'working', queue: [], pending: [], generator: null, idleTimer: null,
    };
    // Input stream: yields queued user messages; null closes it.
    const dequeue = () =>
      new Promise<unknown | null>((resolve) => {
        if (state.pending.length) resolve(state.pending.shift()!);
        else state.queue.push(resolve);
      });
    async function* input() {
      while (true) {
        const msg = await dequeue();
        if (msg === null) return;
        yield msg;
      }
    }
    const options: Record<string, unknown> = {
      cwd: opts.cwd,
      permissionMode: opts.permissionMode,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
    };
    if (opts.resume) options.resume = opts.resume;
    if (opts.model) options.model = opts.model;

    const generator = this.queryFn({ prompt: input(), options });
    state.generator = generator;

    const sessionId = await new Promise<string>((resolve, reject) => {
      let resolved = false;
      const pump = async () => {
        try {
          for await (const msg of generator) {
            const id: string | undefined = msg?.session_id;
            if (!resolved && id && msg.type === 'system' && msg.subtype === 'init') {
              resolved = true;
              this.sessions.set(id, state);
              resolve(id);
              // First user message goes in only after the session is registered.
              this.enqueue(id, this.userMessage(id, opts.prompt));
            }
            if (!id) continue;
            if (msg.type === 'assistant' || msg.type === 'user') {
              for (const chat of sdkToChatMessages(msg, () => ++this.seq)) {
                this.hub.publish(`session:${id}`, { event: 'message', message: chat });
              }
            } else if (msg.type === 'result') {
              this.hub.publish(`session:${id}`, { event: 'turn_result', usage: msg.usage ?? {} });
              this.setStatus(id, 'needs_input');
              this.armIdleTimer(id);
            }
          }
        } catch (err) {
          console.warn('orbital: runner pump error:', err);
        }
        // Generator finished (SDK process exited, or the input stream was closed).
        if (resolved) {
          const id = [...this.sessions.entries()].find(([, s]) => s === state)?.[0];
          if (id) this.finish(id);
        } else {
          reject(new Error('SDK query ended before init'));
        }
      };
      void pump();
    });
    return sessionId;
  }

  private enqueue(sessionId: string, msg: unknown | null): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const waiter = s.queue.shift();
    if (waiter) waiter(msg);
    else s.pending.push(msg);
  }

  send(sessionId: string, text: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.status === 'ended') throw new Error(`session ${sessionId} is not active`);
    if (s.idleTimer) clearTimeout(s.idleTimer);
    this.setStatus(sessionId, 'working');
    this.enqueue(sessionId, this.userMessage(sessionId, text));
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.sessions.get(sessionId)?.generator?.interrupt?.();
    this.setStatus(sessionId, 'needs_input');
    this.armIdleTimer(sessionId);
  }

  async end(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    this.enqueue(sessionId, null); // close the input stream
    this.finish(sessionId);
  }

  status(sessionId: string): SessionStatus | undefined {
    const s = this.sessions.get(sessionId);
    if (s) return s.status;
    return this.ended.has(sessionId) ? 'ended' : undefined;
  }

  active(): string[] {
    return [...this.sessions.keys()];
  }
}
