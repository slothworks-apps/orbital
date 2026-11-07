import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { BrowserBridge, OUTCOME_TIMEOUT_MS, SCREENSHOT_OUTCOME_MAX_MS, type BridgeSocket } from '../src/browser/bridge.js';
import {
  BROWSER_PAIRINGS_FILE,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_MAX_FAILURES,
  PAIRING_CODE_TTL_MS,
  normalizePairingCode,
} from '../src/browser/pairings.js';
import { parseOutcome } from '../src/browser/routes.js';
import { decodeDataUrl, fitScreenshot } from '../src/browser/image.js';
import { TOOL_IMAGE_MAX_BYTES, browserScreenshotTool, browserSessionTools } from '../src/browser/tool.js';
import { BROWSER_CLOSE, BROWSER_TOPIC } from '../src/browser/protocol.js';
import { createImageStore } from '../src/images/store.js';
import { makeTmpDir } from './tmp.js';

interface Fake {
  socket: BridgeSocket;
  frame(f: unknown): void;
  sent: Record<string, any>[];
  closedWith(): number | null;
}

function fakeSocket(): Fake {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  const sent: Record<string, any>[] = [];
  let closed: number | null = null;
  return {
    socket: {
      send: (d) => sent.push(JSON.parse(d)),
      close: (code) => {
        if (closed !== null) return;
        closed = code ?? 1000;
        for (const h of handlers.close ?? []) h();
      },
      on: (ev, cb) => (handlers[ev] ??= []).push(cb),
    },
    frame: (f) => { for (const h of handlers.message ?? []) h(Buffer.from(typeof f === 'string' ? f : JSON.stringify(f))); },
    sent,
    closedWith: () => closed,
  };
}

function makeBridge(opts: {
  dir?: string; enabled?: { on: boolean }; now?: () => number; listening?: boolean; fit?: typeof fitScreenshot;
} = {}) {
  const dir = opts.dir ?? makeTmpDir('browser');
  const enabled = opts.enabled ?? { on: true };
  const published: Record<string, any>[] = [];
  const bridge = new BrowserBridge({
    dataDir: dir,
    publish: (topic, payload) => { if (topic === BROWSER_TOPIC) published.push(payload); },
    windowsListening: () => opts.listening ?? true,
    images: createImageStore(join(dir, 'images')),
    isEnabled: () => enabled.on,
    titleOf: (id) => (id === 's1' ? 'Billing v2' : null),
    maxImageBytes: 5 * 1024 * 1024,
    port: 47823,
    now: opts.now,
    fit: opts.fit,
  });
  return { bridge, dir, enabled, published, events: () => published.filter((p) => p.type !== 'browser_status') };
}

/** A paired, authenticated socket and the token it was given. */
function paired(bridge: BrowserBridge, browser = 'Chrome'): { fake: Fake; token: string } {
  const { code } = bridge.newPairingCode()!;
  const fake = fakeSocket();
  bridge.handleSocket(fake.socket);
  fake.frame({ type: 'pair', code, browser });
  const frame = fake.sent.find((f) => f.type === 'paired');
  if (!frame) throw new Error(`not paired: ${JSON.stringify(fake.sent)}`);
  return { fake, token: frame.token };
}

async function png(): Promise<string> {
  const bytes = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#336699' } }).png().toBuffer();
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('pairing', () => {
  it('makes codes from an alphabet without 0/O or 1/I', () => {
    expect(PAIRING_CODE_ALPHABET).not.toMatch(/[0O1I]/);
    const { bridge } = makeBridge();
    for (let i = 0; i < 50; i++) {
      const { code } = bridge.newPairingCode()!;
      expect(code).toHaveLength(PAIRING_CODE_LENGTH);
      expect([...code].every((c) => PAIRING_CODE_ALPHABET.includes(c))).toBe(true);
    }
  });

  it('takes a code typed in lower case or with a space or dash between its halves', () => {
    expect(normalizePairingCode(' k7q 4md ')).toBe('K7Q4MD');
    expect(normalizePairingCode('k7q-4Md')).toBe('K7Q4MD');
    const { bridge } = makeBridge();
    const { code } = bridge.newPairingCode()!;
    const fake = fakeSocket();
    bridge.handleSocket(fake.socket);
    fake.frame({ type: 'pair', code: `${code.slice(0, 3).toLowerCase()} ${code.slice(3).toLowerCase()}`, browser: 'Arc' });
    expect(fake.sent[0]).toMatchObject({ type: 'paired' });
  });

  it('remembers when a paired browser was last connected', () => {
    let now = 1_000;
    const { bridge, dir } = makeBridge({ now: () => now });
    const { fake } = paired(bridge);
    expect(bridge.status()).toMatchObject({ port: 47823, pairings: [{ connected: true, lastSeenAt: 1_000 }] });
    now = 5_000;
    fake.socket.close();
    expect(bridge.status().pairings).toMatchObject([{ connected: false, lastSeenAt: 5_000 }]);
    // Kept across a restart.
    expect(makeBridge({ dir }).bridge.status().pairings).toMatchObject([{ lastSeenAt: 5_000 }]);
  });

  it('spends a code once', () => {
    const { bridge } = makeBridge();
    const { code } = bridge.newPairingCode()!;
    const first = fakeSocket();
    bridge.handleSocket(first.socket);
    first.frame({ type: 'pair', code, browser: 'Arc' });
    expect(first.sent[0]).toMatchObject({ type: 'paired' });
    const second = fakeSocket();
    bridge.handleSocket(second.socket);
    second.frame({ type: 'pair', code, browser: 'Arc' });
    expect(second.sent[0]).toMatchObject({ type: 'pair_failed' });
    expect(bridge.status().pairings).toMatchObject([{ browser: 'Arc', connected: true }]);
  });

  it('refuses a wrong code and leaves the socket open, until too many wrong ones end the code', () => {
    const { bridge } = makeBridge();
    const { code } = bridge.newPairingCode()!;
    // 0 is not in the alphabet, so this is never the code.
    const wrong = '000000';
    const fake = fakeSocket();
    bridge.handleSocket(fake.socket);
    for (let i = 0; i < PAIRING_CODE_MAX_FAILURES; i++) fake.frame({ type: 'pair', code: wrong, browser: 'Chrome' });
    expect(fake.sent.every((f) => f.type === 'pair_failed')).toBe(true);
    expect(fake.closedWith()).toBeNull();
    fake.frame({ type: 'pair', code, browser: 'Chrome' });
    expect(fake.sent.at(-1)).toMatchObject({ type: 'pair_failed' });
    expect(bridge.status().pairings).toEqual([]);
  });

  it('tells Settings when wrong tries end the code', () => {
    const { bridge, published } = makeBridge();
    const { expiresAt } = bridge.newPairingCode()!;
    expect(published.at(-1)).toMatchObject({ type: 'browser_status', status: { codeExpiresAt: expiresAt } });
    const fake = fakeSocket();
    bridge.handleSocket(fake.socket);
    for (let i = 0; i < PAIRING_CODE_MAX_FAILURES - 1; i++) fake.frame({ type: 'pair', code: '000000', browser: 'Chrome' });
    const before = published.length;
    fake.frame({ type: 'pair', code: '000000', browser: 'Chrome' });
    expect(published.slice(before)).toEqual([{ type: 'browser_status', status: expect.objectContaining({ codeExpiresAt: null }) }]);
    // With no code open, a wrong try changes nothing Settings shows.
    fake.frame({ type: 'pair', code: '000000', browser: 'Chrome' });
    expect(published).toHaveLength(before + 1);
  });

  it('cancels the open code, so it pairs nothing after', () => {
    const { bridge, published } = makeBridge();
    const { code } = bridge.newPairingCode()!;
    bridge.cancelPairingCode();
    expect(bridge.status().codeExpiresAt).toBeNull();
    expect(published.at(-1)).toMatchObject({ type: 'browser_status', status: { codeExpiresAt: null } });
    const fake = fakeSocket();
    bridge.handleSocket(fake.socket);
    fake.frame({ type: 'pair', code, browser: 'Chrome' });
    expect(fake.sent[0]).toMatchObject({ type: 'pair_failed' });
  });

  it('refuses a code past its lifetime', () => {
    let now = 1_000;
    const { bridge } = makeBridge({ now: () => now });
    const { code, expiresAt } = bridge.newPairingCode()!;
    expect(expiresAt).toBe(1_000 + PAIRING_CODE_TTL_MS);
    expect(bridge.status().codeExpiresAt).toBe(expiresAt);
    now = expiresAt;
    expect(bridge.status().codeExpiresAt).toBeNull();
    const fake = fakeSocket();
    bridge.handleSocket(fake.socket);
    fake.frame({ type: 'pair', code, browser: 'Chrome' });
    expect(fake.sent[0]).toMatchObject({ type: 'pair_failed' });
  });

  it('keeps only a hash of the token, owner-only, across a restart', () => {
    const { bridge, dir } = makeBridge();
    const { token } = paired(bridge);
    const file = join(dir, BROWSER_PAIRINGS_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).not.toContain(token);

    const again = makeBridge({ dir }).bridge;
    const fake = fakeSocket();
    again.handleSocket(fake.socket);
    fake.frame({ type: 'hello', token, browser: 'Chrome' });
    expect(fake.sent).toEqual([{ type: 'welcome' }]);
  });
});

describe('the socket', () => {
  it('closes on an unknown token with unauthorized', () => {
    const { bridge } = makeBridge();
    const fake = fakeSocket();
    bridge.handleSocket(fake.socket);
    fake.frame({ type: 'hello', token: 'nope', browser: 'Chrome' });
    expect(fake.closedWith()).toBe(BROWSER_CLOSE.unauthorized);
  });

  it('closes when the first frame is neither pair nor hello, or does not come', () => {
    vi.useFakeTimers();
    const { bridge } = makeBridge();
    const early = fakeSocket();
    bridge.handleSocket(early.socket);
    early.frame({ type: 'selection', eventId: 'e1', text: 'x', url: '', title: '' });
    expect(early.closedWith()).toBe(1008);
    const silent = fakeSocket();
    bridge.handleSocket(silent.socket);
    vi.advanceTimersByTime(5_000);
    expect(silent.closedWith()).toBe(1008);
  });

  it('revoking a pairing drops its live socket and refuses its token after', () => {
    const { bridge } = makeBridge();
    const { fake, token } = paired(bridge);
    const id = bridge.status().pairings[0].id;
    expect(bridge.revoke(id)).toBe(true);
    expect(fake.closedWith()).toBe(BROWSER_CLOSE.unauthorized);
    const again = fakeSocket();
    bridge.handleSocket(again.socket);
    again.frame({ type: 'hello', token, browser: 'Chrome' });
    expect(again.closedWith()).toBe(BROWSER_CLOSE.unauthorized);
    expect(bridge.revoke(id)).toBe(false);
  });

  it('with the switch off, closes a new socket and drops the connected ones', () => {
    const { bridge, enabled } = makeBridge();
    const { fake } = paired(bridge);
    enabled.on = false;
    bridge.settingsChanged();
    expect(fake.closedWith()).toBe(BROWSER_CLOSE.disabled);
    const late = fakeSocket();
    bridge.handleSocket(late.socket);
    expect(late.closedWith()).toBe(BROWSER_CLOSE.disabled);
    expect(bridge.newPairingCode()).toBeNull();
  });

  it('answers a ping', () => {
    const { bridge } = makeBridge();
    const { fake } = paired(bridge);
    fake.frame({ type: 'ping' });
    expect(fake.sent.at(-1)).toEqual({ type: 'pong' });
  });
});

describe('events and their outcome', () => {
  it('publishes a selection and passes the window\'s outcome on, with the session title', () => {
    const { bridge, events } = makeBridge();
    const { fake } = paired(bridge);
    fake.frame({ type: 'selection', eventId: 'e1', text: 'hello', url: 'https://x.test/', title: 'X' });
    expect(events()).toMatchObject([{ type: 'browser_selection', eventId: 'e1', text: 'hello', url: 'https://x.test/', title: 'X' }]);
    bridge.outcome({ eventId: 'e1', delivered: true, sessionId: 's1' });
    expect(fake.sent.at(-1)).toEqual({ type: 'outcome', eventId: 'e1', delivered: true, sessionTitle: 'Billing v2' });
    // One answer per event: a second window's is ignored.
    bridge.outcome({ eventId: 'e1', delivered: false, reason: 'no-session' });
    expect(fake.sent.filter((f) => f.type === 'outcome')).toHaveLength(1);
  });

  it('reads silence as no window', () => {
    vi.useFakeTimers();
    const { bridge } = makeBridge();
    const { fake } = paired(bridge);
    fake.frame({ type: 'selection', eventId: 'e1', text: 'hello', url: '', title: '' });
    vi.advanceTimersByTime(2_999);
    expect(fake.sent.some((f) => f.type === 'outcome')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(fake.sent.at(-1)).toEqual({ type: 'outcome', eventId: 'e1', delivered: false, reason: 'no-window' });
  });

  it('answers no window at once when no window listens', () => {
    const { bridge, events } = makeBridge({ listening: false });
    const { fake } = paired(bridge);
    fake.frame({ type: 'selection', eventId: 'e1', text: 'hello', url: '', title: '' });
    expect(events()).toEqual([]);
    expect(fake.sent.at(-1)).toMatchObject({ type: 'outcome', delivered: false, reason: 'no-window' });
  });

  it('stores a screenshot and publishes its ref', async () => {
    const { bridge, events, dir } = makeBridge();
    const { fake } = paired(bridge);
    fake.frame({ type: 'screenshot', eventId: 'e2', dataUrl: await png(), url: 'https://x.test/', title: 'X' });
    await vi.waitFor(() => expect(events()).toHaveLength(1));
    const [event] = events();
    expect(event).toMatchObject({ type: 'browser_screenshot', eventId: 'e2', url: 'https://x.test/', title: 'X', w: 4, h: 3 });
    expect(event.bytes).toBeGreaterThan(0);
    expect(event.ref).toMatch(/^[a-f0-9]{64}\.png$/);
    expect(createImageStore(join(dir, 'images')).entry(event.ref)).toMatchObject({ w: 4, h: 3 });
  });

  it('answers a screenshot it cannot read with a dropped outcome', async () => {
    const { bridge, events } = makeBridge();
    const { fake } = paired(bridge);
    fake.frame({ type: 'screenshot', eventId: 'e3', dataUrl: 'data:text/html;base64,PGI+', url: '', title: '' });
    await vi.waitFor(() => expect(fake.sent.at(-1)).toEqual({ type: 'outcome', eventId: 'e3', delivered: false, reason: 'unreadable' }));
    expect(events()).toEqual([]);
  });

  /** A shrink that takes as long as the test says. */
  function slowFit() {
    let finish: () => void = () => {};
    const fit: typeof fitScreenshot = (shot) => new Promise((resolve) => { finish = () => resolve(shot); });
    return { fit, finish: () => finish() };
  }

  it('counts a screenshot\'s wait from its arrival, the shrink included, up to the cap', async () => {
    vi.useFakeTimers();
    const slow = slowFit();
    const { bridge, events } = makeBridge({ fit: slow.fit });
    const { fake } = paired(bridge);
    const outcomes = () => fake.sent.filter((f) => f.type === 'outcome');
    fake.frame({ type: 'screenshot', eventId: 'e4', dataUrl: await png(), url: '', title: '' });
    // A long shrink: once it is done, a window still has its full wait.
    await vi.advanceTimersByTimeAsync(SCREENSHOT_OUTCOME_MAX_MS - OUTCOME_TIMEOUT_MS - 1_000);
    slow.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(events()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(OUTCOME_TIMEOUT_MS - 1);
    expect(outcomes()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(outcomes()).toEqual([{ type: 'outcome', eventId: 'e4', delivered: false, reason: 'no-window' }]);

    // Published late, a window gets what is left of the cap, not a full wait.
    fake.frame({ type: 'screenshot', eventId: 'e5', dataUrl: await png(), url: '', title: '' });
    await vi.advanceTimersByTimeAsync(SCREENSHOT_OUTCOME_MAX_MS - 1_000);
    slow.finish();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(outcomes().at(-1)).toEqual({ type: 'outcome', eventId: 'e5', delivered: false, reason: 'no-window' });
  });

  it('answers a screenshot still shrinking at the cap as unreadable, and never publishes it', async () => {
    vi.useFakeTimers();
    const slow = slowFit();
    const { bridge, events } = makeBridge({ fit: slow.fit });
    const { fake } = paired(bridge);
    fake.frame({ type: 'screenshot', eventId: 'e6', dataUrl: await png(), url: '', title: '' });
    await vi.advanceTimersByTimeAsync(SCREENSHOT_OUTCOME_MAX_MS);
    expect(fake.sent.at(-1)).toEqual({ type: 'outcome', eventId: 'e6', delivered: false, reason: 'unreadable' });
    slow.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(events()).toEqual([]);
    expect(fake.sent.filter((f) => f.type === 'outcome')).toHaveLength(1);
  });
});

describe('the agent\'s capture', () => {
  it('asks the extension that sent the latest event', async () => {
    let now = 1;
    const { bridge } = makeBridge({ now: () => now });
    const chrome = paired(bridge, 'Chrome').fake;
    now = 2;
    const arc = paired(bridge, 'Arc').fake;
    now = 3;
    chrome.frame({ type: 'selection', eventId: 'e1', text: 'x', url: '', title: '' });
    const capture = bridge.capture();
    const ask = chrome.sent.find((f) => f.type === 'capture');
    expect(ask).toBeDefined();
    expect(arc.sent.some((f) => f.type === 'capture')).toBe(false);
    // Another extension cannot answer a request it was not sent.
    arc.frame({ type: 'captured', requestId: ask!.requestId, dataUrl: await png(), url: 'https://evil.test/', title: '' });
    chrome.frame({ type: 'captured', requestId: ask!.requestId, dataUrl: await png(), url: 'https://x.test/', title: 'X' });
    expect(await capture).toMatchObject({ ok: true, url: 'https://x.test/', title: 'X' });
  });

  it('says so when no extension is connected, the browser refuses, it leaves or time runs out', async () => {
    vi.useFakeTimers();
    const { bridge } = makeBridge();
    expect(await bridge.capture()).toEqual({ ok: false, reason: 'no-extension' });

    const { fake } = paired(bridge);
    const refused = bridge.capture();
    fake.frame({ type: 'capture_failed', requestId: fake.sent.at(-1)!.requestId, reason: 'Cannot access a chrome:// URL' });
    expect(await refused).toEqual({ ok: false, reason: 'failed', detail: 'Cannot access a chrome:// URL' });

    const late = bridge.capture();
    vi.advanceTimersByTime(10_000);
    expect(await late).toEqual({ ok: false, reason: 'timeout' });

    const gone = bridge.capture();
    fake.socket.close();
    expect(await gone).toMatchObject({ ok: false, reason: 'failed' });
  });
});

describe('parseOutcome', () => {
  it('takes a well-formed outcome and refuses the rest', () => {
    expect(parseOutcome({ eventId: 'e', delivered: true, sessionId: 's1' })).toEqual({ eventId: 'e', delivered: true, sessionId: 's1' });
    expect(parseOutcome({ eventId: 'e', delivered: false, reason: 'composer-full' })).toEqual({ eventId: 'e', delivered: false, reason: 'composer-full' });
    expect(parseOutcome({ eventId: 'e', delivered: false, reason: 'read-only' })).toEqual({ eventId: 'e', delivered: false, reason: 'read-only' });
    for (const bad of [null, 'x', {}, { eventId: '', delivered: true }, { eventId: 'e', delivered: 'yes' }, { eventId: 'e', delivered: false, reason: 'bored' }, { eventId: 'e', delivered: true, sessionId: 1 }]) {
      expect(parseOutcome(bad)).toBeNull();
    }
  });
});

describe('fitScreenshot', () => {
  /** Noise compresses worst: a PNG of it is the case the ceiling is for. */
  async function noise(width: number, height: number): Promise<Buffer> {
    const raw = Buffer.alloc(width * height * 3);
    let x = 2463534242;
    for (let i = 0; i < raw.length; i++) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      raw[i] = x & 0xff;
    }
    return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
  }

  it('leaves one that fits as it came', async () => {
    const shot = decodeDataUrl(await png())!;
    expect(await fitScreenshot(shot, { maxBytes: 1_000_000 })).toBe(shot);
  });

  it('brings one too big under the ceiling, and one too wide under the edge', async () => {
    const bytes = await noise(800, 600);
    const big = await fitScreenshot({ mediaType: 'image/png', bytes }, { maxBytes: Math.floor(bytes.length / 4) });
    expect(big).not.toBeNull();
    expect(big!.bytes.length).toBeLessThanOrEqual(bytes.length / 4);
    const wide = await fitScreenshot({ mediaType: 'image/png', bytes }, { maxBytes: 10 * bytes.length, maxEdge: 200 });
    const meta = await sharp(wide!.bytes).metadata();
    expect(Math.max(meta.width, meta.height)).toBe(200);
  });

  it('reads only an image data URL', () => {
    expect(decodeDataUrl('data:image/png;base64,')).toBeNull();
    expect(decodeDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
    expect(decodeDataUrl(42)).toBeNull();
  });
});

describe('browser_screenshot', () => {
  it('is there only while the switch is on, and never skips the permission card', () => {
    const { bridge, enabled } = makeBridge();
    expect(browserSessionTools(bridge)).toMatchObject({ allowedTools: [] });
    expect(browserSessionTools(bridge)!.tools.map((t) => t.name)).toEqual(['browser_screenshot']);
    enabled.on = false;
    expect(browserSessionTools(bridge)).toBeUndefined();
  });

  it('returns the image and its page, or says in words why not', async () => {
    const shot = decodeDataUrl(await png())!;
    const ok = await browserScreenshotTool({ capture: async () => ({ ok: true, shot, url: 'https://x.test/', title: 'X' }) })
      .handler({}, {});
    expect(ok.isError).toBeUndefined();
    expect(ok.content[0]).toEqual({ type: 'image', data: shot.bytes.toString('base64'), mimeType: 'image/png' });
    expect(ok.content[1]).toMatchObject({ type: 'text', text: expect.stringContaining('https://x.test/') });

    const none = await browserScreenshotTool({ capture: async () => ({ ok: false, reason: 'no-extension' }) }).handler({}, {});
    // Not a failure: nothing went wrong, there is just no browser to look at.
    expect(none.isError).toBeUndefined();
    expect(none.content).toEqual([{ type: 'text', text: 'No browser is connected to Orbital. The user can open the Orbital extension in their browser, or pair one in Settings → Labs → Browser bridge.' }]);
  });

  // Spec § browser_screenshot: a tab that cannot be captured is said in words, not an error that ends the turn.
  it('says in plain words when the tab cannot be captured or the browser is slow', async () => {
    const failed = await browserScreenshotTool({ capture: async () => ({ ok: false, reason: 'failed', detail: 'Cannot access a chrome:// URL' }) }).handler({}, {});
    expect(failed.isError).toBeUndefined();
    expect(failed.content).toEqual([{ type: 'text', text: 'The browser could not take the screenshot: Cannot access a chrome:// URL. Pages such as chrome:// and the extension store cannot be captured.' }]);
    const stopped = await browserScreenshotTool({ capture: async () => ({ ok: false, reason: 'failed', detail: 'Tab closed.' }) }).handler({}, {});
    expect(stopped.content[0]).toMatchObject({ text: expect.stringContaining('Tab closed. Pages') });
    const late = await browserScreenshotTool({ capture: async () => ({ ok: false, reason: 'timeout' }) }).handler({}, {});
    expect(late.isError).toBeUndefined();
  });

  it('keeps the image under the API\'s ceiling once it is base64', async () => {
    // Noise at the tool's edge compresses worst: the PNG is over the budget.
    const width = 1568;
    const height = 1000;
    const raw = Buffer.alloc(width * height * 3);
    let x = 88172645;
    for (let i = 0; i < raw.length; i++) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      raw[i] = x & 0xff;
    }
    const bytes = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
    expect(bytes.length).toBeGreaterThan(TOOL_IMAGE_MAX_BYTES);
    const result = await browserScreenshotTool({ capture: async () => ({ ok: true, shot: { mediaType: 'image/png', bytes }, url: '', title: '' }) })
      .handler({}, {});
    const image = result.content[0] as { data: string };
    expect(image.data.length).toBeLessThanOrEqual(5 * 1024 * 1024);
  });
});
