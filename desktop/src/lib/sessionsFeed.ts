/**
 * The main process's own subscription to the server's WebSocket.
 *
 * It speaks the same public contract the web app does (`/ws`, `subscribe`
 * frames) rather than a private channel, so notifications cost the server
 * nothing it does not already do (spec 2026-09-16-electron-wrapper-design § 3).
 * The origin guard admits clients that send no Origin header, which is what a
 * main-process socket is.
 *
 * Node's global `WebSocket` — no dependency, and Electron's Node is new enough.
 */

/** Reconnect delay. A local socket: the server is either up or coming up. */
const RETRY_MS = 2_000;

const TOPICS = ['sessions', 'errors'] as const;

export function startSessionsFeed(opts: {
  url: string;
  onFrame: (frame: unknown) => void;
  /** Fired when a NEW socket opens — everything the last one knew is stale. */
  onReconnect: () => void;
}): { close(): void } {
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  function retry(): void {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, RETRY_MS);
  }

  function connect(): void {
    if (closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(opts.url);
    } catch {
      retry();
      return;
    }
    socket = ws;

    ws.addEventListener('open', () => {
      opts.onReconnect();
      for (const topic of TOPICS) ws.send(JSON.stringify({ type: 'subscribe', topic }));
    });

    ws.addEventListener('message', (event) => {
      try {
        opts.onFrame(JSON.parse(String(event.data)));
      } catch {
        /* not JSON: nothing we could have done with it anyway */
      }
    });

    const drop = (): void => {
      if (socket !== ws) return; // a later socket already took over
      socket = null;
      retry();
    };
    ws.addEventListener('close', drop);
    ws.addEventListener('error', drop);
  }

  connect();

  return {
    close(): void {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      socket?.close();
      socket = null;
    },
  };
}
