type Socket = {
  send(data: string): void;
  on(ev: string, cb: (...args: any[]) => void): void;
};

export type HubOptions = {
  heartbeatIntervalMs?: number;
};

/**
 * How often every connected socket is sent a heartbeat frame. It has to be an
 * application-level frame rather than a WS protocol ping: browsers answer
 * protocol pings inside the implementation and page JavaScript never sees
 * them, so only a real frame can feed the client's watchdog
 * (spec: 2026-09-22-ws-reconnect-resync-design).
 */
export const WS_HEARTBEAT_INTERVAL_MS = 15_000;

export class Hub {
  private topics = new Map<string, Set<Socket>>();
  private firstCb: ((topic: string) => void) | null = null;
  private lastCb: ((topic: string) => void) | null = null;
  private heartbeatIntervalMs: number;

  constructor(opts: HubOptions = {}) {
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? WS_HEARTBEAT_INTERVAL_MS;
  }

  onFirstSubscriber(cb: (topic: string) => void): void {
    this.firstCb = cb;
  }

  onLastUnsubscriber(cb: (topic: string) => void): void {
    this.lastCb = cb;
  }

  private subscribe(socket: Socket, topic: string): void {
    let set = this.topics.get(topic);
    if (!set) {
      set = new Set();
      this.topics.set(topic, set);
    }
    const wasEmpty = set.size === 0;
    set.add(socket);
    if (wasEmpty) this.firstCb?.(topic);
  }

  private unsubscribe(socket: Socket, topic: string): void {
    const set = this.topics.get(topic);
    if (!set?.delete(socket)) return;
    if (set.size === 0) {
      this.topics.delete(topic);
      this.lastCb?.(topic);
    }
  }

  handleSocket(socket: Socket): void {
    const mine = new Set<string>();
    socket.on('message', (raw: unknown) => {
      try {
        const msg = JSON.parse(String(raw));
        if (typeof msg.topic !== 'string') return;
        if (msg.type === 'subscribe') {
          mine.add(msg.topic);
          this.subscribe(socket, msg.topic);
        } else if (msg.type === 'unsubscribe') {
          mine.delete(msg.topic);
          this.unsubscribe(socket, msg.topic);
        }
      } catch {
        /* ignore malformed */
      }
    });
    // The frame carries no `topic`, so the client's router drops it and only
    // the watchdog sees it — which is the whole job.
    const heartbeat = setInterval(() => {
      try {
        socket.send(JSON.stringify({ type: 'heartbeat' }));
      } catch {
        /* dead socket; close handler will clean up */
      }
    }, this.heartbeatIntervalMs);
    socket.on('close', () => {
      clearInterval(heartbeat);
      for (const topic of mine) this.unsubscribe(socket, topic);
    });
  }

  publish(topic: string, payload: Record<string, unknown>): void {
    const set = this.topics.get(topic);
    if (!set) return;
    const data = JSON.stringify({ topic, ...payload });
    for (const socket of set) {
      try {
        socket.send(data);
      } catch {
        /* dead socket; close handler will clean up */
      }
    }
  }

  subscriberCount(topic: string): number {
    return this.topics.get(topic)?.size ?? 0;
  }
}
