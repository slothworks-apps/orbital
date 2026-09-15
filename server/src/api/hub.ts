type Socket = {
  send(data: string): void;
  on(ev: string, cb: (...args: any[]) => void): void;
};

export class Hub {
  private topics = new Map<string, Set<Socket>>();
  private firstCb: ((topic: string) => void) | null = null;
  private lastCb: ((topic: string) => void) | null = null;

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
    socket.on('close', () => {
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
