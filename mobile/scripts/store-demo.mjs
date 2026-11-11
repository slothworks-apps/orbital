#!/usr/bin/env node
/**
 * Stages the demo data the App Store screenshots and the review video are
 * taken against: a Claude directory holding invented projects and Claude
 * Code sessions, so the Mac the phone pairs with shows nothing real.
 *
 * It wipes and rewrites `<outDir>/claude`, to be served with
 * `ORBITAL_CLAUDE_DIR=<outDir>/claude`:
 *
 * - `projects/<encoded cwd>/<id>.jsonl`, transcripts in the CLI's format
 *   (`server/src/transcript/parser.ts`), stamped relative to now so every
 *   session looks fresh; one subagent's transcript beside its parent, where
 *   the CLI keeps them (`docs/domains/subagents-in-transcripts.md`);
 * - `sessions/<pid>.json`, the CLI's live registry, for the sessions that
 *   are meant to look open in a terminal. The server believes an entry only
 *   while its pid lives (`server/src/watcher/registry.ts`), so each one is
 *   held by a small idle node process this script leaves running, for
 *   `HOLD_MS`. Their pids go in `<outDir>/holders.json`; a rerun, or
 *   `--stop`, ends them.
 *
 * Session ids are fixed, so a rerun rewrites the same sessions and a server
 * already pointed at `<outDir>/data` (and a phone paired with it) keeps going.
 *
 * Usage: node mobile/scripts/store-demo.mjs <outDir> [--stop]
 */

import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

/** How long the processes holding the live sessions stay up. */
const HOLD_MS = 24 * 60 * 60 * 1000;
/** The argument that marks a holder in `ps`, so a stale pid is never killed by mistake. */
const HOLDER_MARK = 'orbital-store-demo-holder';
const CLI_VERSION = '2.1.280';
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5';
const HOME = '/Users/demo/Projects';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// ---------------------------------------------------------------------------
// Ids

/** A uuid-shaped id, stable for the same seed. */
function stableUuid(seed) {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function stableHex(seed, length) {
  return createHash('sha256').update(seed).digest('hex').slice(0, length);
}

/** The CLI's directory name for a cwd: every character outside [A-Za-z0-9] becomes `-`. */
function encodeCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

// ---------------------------------------------------------------------------
// PNG: a few procedural pictures, so the transcripts carry real images

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h * 3);
  }

  set(x, y, [r, g, b], a = 1) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    this.px[i] = this.px[i] * (1 - a) + r * a;
    this.px[i + 1] = this.px[i + 1] * (1 - a) + g * a;
    this.px[i + 2] = this.px[i + 2] * (1 - a) + b * a;
  }

  gradient(top, bottom) {
    for (let y = 0; y < this.h; y++) {
      const t = y / (this.h - 1);
      const c = top.map((v, i) => v + (bottom[i] - v) * t);
      for (let x = 0; x < this.w; x++) this.set(x, y, c);
    }
  }

  roundRect(x0, y0, w, h, r, color, a = 1) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const dx = Math.max(x0 + r - x, 0, x - (x0 + w - 1 - r));
        const dy = Math.max(y0 + r - y, 0, y - (y0 + h - 1 - r));
        const d = Math.hypot(dx, dy);
        if (d <= r) this.set(x, y, color, a * Math.min(1, r - d + 0.5));
      }
    }
  }

  circle(cx, cy, r, color, a = 1) {
    for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) {
      for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= r + 0.5) this.set(x, y, color, a * Math.min(1, r - d + 0.5));
      }
    }
  }

  line(x0, y0, x1, y1, width, color) {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      this.circle(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, width / 2, color);
    }
  }

  png() {
    const raw = Buffer.alloc((this.w * 3 + 1) * this.h);
    for (let y = 0; y < this.h; y++) {
      raw[y * (this.w * 3 + 1)] = 0;
      Buffer.from(this.px.buffer, y * this.w * 3, this.w * 3).copy(raw, y * (this.w * 3 + 1) + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0);
    ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // RGB
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64');
  }
}

const WHITE = [255, 255, 255];
const SUN = [255, 196, 61];
const CLOUD = [236, 242, 250];

/** The design mockup a user attaches: the current-conditions card and an hourly strip under it. */
function hourlyMockup() {
  const c = new Canvas(780, 520);
  c.gradient([74, 144, 226], [143, 196, 245]);
  // Current conditions card.
  c.roundRect(40, 40, 700, 220, 28, WHITE, 0.22);
  c.circle(170, 150, 62, SUN);
  c.circle(232, 182, 40, CLOUD);
  c.circle(196, 196, 30, CLOUD);
  c.roundRect(196, 186, 80, 40, 20, CLOUD);
  c.roundRect(360, 100, 260, 34, 17, WHITE, 0.9);
  c.roundRect(360, 156, 180, 22, 11, WHITE, 0.55);
  c.roundRect(360, 196, 220, 22, 11, WHITE, 0.55);
  // The hourly strip: six cells, an icon each, and the temperature line across them.
  const temps = [14, 16, 18, 19, 17, 15];
  temps.forEach((t, i) => {
    const x = 40 + i * 118;
    c.roundRect(x, 300, 106, 180, 22, WHITE, 0.2);
    c.roundRect(x + 33, 318, 40, 12, 6, WHITE, 0.7);
    if (i < 4) c.circle(x + 53, 372, 20, SUN);
    else {
      c.circle(x + 46, 374, 16, CLOUD);
      c.circle(x + 62, 368, 18, CLOUD);
    }
  });
  const points = temps.map((t, i) => [40 + i * 118 + 53, 470 - (t - 12) * 9]);
  for (let i = 1; i < points.length; i++) c.line(...points[i - 1], ...points[i], 5, WHITE);
  for (const [x, y] of points) c.circle(x, y, 7, SUN);
  return c.png();
}

/** The "before" screenshot: a weather icon drawn at 1x and stretched, its pixels showing. */
function blurryIconScreenshot() {
  const size = 16;
  const icon = new Canvas(size, size);
  icon.gradient([238, 244, 252], [238, 244, 252]);
  icon.circle(6, 6, 4.2, SUN);
  icon.circle(9, 10, 3.2, [176, 190, 210]);
  icon.circle(6.5, 11, 2.4, [176, 190, 210]);
  icon.roundRect(6, 10, 8, 4, 2, [176, 190, 210]);
  const scale = 24;
  const c = new Canvas(size * scale + 80, size * scale + 80);
  c.gradient([238, 244, 252], [224, 233, 246]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      const color = [icon.px[i], icon.px[i + 1], icon.px[i + 2]];
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) c.set(40 + x * scale + dx, 40 + y * scale + dy, color);
    }
  }
  return c.png();
}

// ---------------------------------------------------------------------------
// Transcripts

/**
 * One session's transcript, entry by entry, in the shape the CLI writes:
 * every entry chained to the one before it by `parentUuid`, one content
 * block per assistant entry, a tool's result in a user entry of its own.
 */
class Session {
  constructor({ key, project, startedAgo, model = OPUS, branch = 'main' }) {
    this.key = key;
    this.id = stableUuid(`session:${key}`);
    this.cwd = `${HOME}/${project}`;
    this.model = model;
    this.branch = branch;
    this.at = Date.now() - startedAgo;
    this.entries = [];
    this.parent = null;
    this.n = 0;
    this.lastAssistant = null;
    this.context = 18000;
    this.subagents = [];
  }

  /** Moves the clock on by `seconds`. */
  wait(seconds) {
    this.at += seconds * 1000;
    return this;
  }

  nextUuid() {
    return stableUuid(`${this.key}:${this.n++}`);
  }

  push(fields) {
    const uuid = this.nextUuid();
    const entry = {
      parentUuid: this.parent,
      isSidechain: false,
      ...fields,
      uuid,
      timestamp: new Date(this.at).toISOString(),
      userType: 'external',
      entrypoint: 'cli',
      cwd: this.cwd,
      sessionId: this.id,
      version: CLI_VERSION,
      gitBranch: this.branch,
    };
    this.entries.push(entry);
    this.parent = uuid;
    return entry;
  }

  /** What the user typed; `images` are base64 PNGs pasted with it. */
  user(text, images = []) {
    this.wait(4);
    const content = [
      ...images.map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })),
      { type: 'text', text },
    ];
    this.push({ type: 'user', message: { role: 'user', content }, permissionMode: 'default' });
    return this;
  }

  assistantBlock(block, stopReason) {
    this.wait(block.type === 'text' ? 3 : 2);
    this.context += 900;
    const entry = this.push({
      type: 'assistant',
      message: {
        model: this.model,
        id: `msg_${stableHex(`${this.key}:msg:${this.n}`, 24)}`,
        type: 'message',
        role: 'assistant',
        content: [block],
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
          input_tokens: 4,
          cache_creation_input_tokens: 1200,
          cache_read_input_tokens: this.context,
          output_tokens: 320,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1200 },
        },
      },
      requestId: `req_${stableHex(`${this.key}:req:${this.n}`, 24)}`,
    });
    this.lastAssistant = entry.uuid;
    return entry;
  }

  /** Claude's prose; markdown is drawn as such. */
  say(text) {
    this.assistantBlock({ type: 'text', text }, 'end_turn');
    return this;
  }

  /** A tool call; `result` (text, or content blocks) answers it, or it is left running. */
  tool(name, input, result, { isError = false, toolUseResult, seconds = 2 } = {}) {
    const id = `toolu_${stableHex(`${this.key}:tool:${this.n}`, 24)}`;
    this.assistantBlock({ type: 'tool_use', id, name, input }, 'tool_use');
    if (result === undefined) return id;
    const source = this.lastAssistant;
    this.wait(seconds);
    this.push({
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: result, is_error: isError }] },
      toolUseResult: toolUseResult ?? (typeof result === 'string' ? { stdout: result, stderr: '', interrupted: false, isImage: false } : result),
      sourceToolAssistantUUID: source,
    });
    return id;
  }

  read(path, text) {
    const numbered = text.split('\n').map((line, i) => `${String(i + 1).padStart(6)}\t${line}`).join('\n');
    this.tool('Read', { file_path: `${this.cwd}/${path}` }, numbered);
    return this;
  }

  readImage(path, data) {
    this.tool('Read', { file_path: `${this.cwd}/${path}` }, [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
    ], { toolUseResult: { type: 'image', file: { type: 'image/png', originalSize: data.length } } });
    return this;
  }

  edit(path, oldString, newString) {
    this.tool('Edit', { file_path: `${this.cwd}/${path}`, old_string: oldString, new_string: newString, replace_all: false },
      `The file ${this.cwd}/${path} has been updated successfully.`);
    return this;
  }

  write(path, content) {
    this.tool('Write', { file_path: `${this.cwd}/${path}`, content }, `File created successfully at: ${this.cwd}/${path}`);
    return this;
  }

  bash(command, description, output, opts = {}) {
    this.tool('Bash', { command, description }, output, opts);
    return this;
  }

  /**
   * An `Agent` call answered by its subagent's report. The subagent's own
   * transcript goes beside the session's, as the CLI keeps it; `steps`
   * builds it on a session of its own.
   */
  agent({ description, subagentType, prompt, report, steps }) {
    const agentId = `a${stableHex(`${this.key}:agent:${this.n}`, 16)}`;
    const toolUseId = this.tool('Agent', { description, subagent_type: subagentType, prompt });
    const sub = new Session({ key: `${this.key}:${agentId}`, project: basename(this.cwd), startedAgo: 0, model: SONNET, branch: this.branch });
    sub.id = this.id;
    sub.at = this.at;
    sub.user(prompt);
    steps(sub);
    this.at = Math.max(this.at, sub.at);
    this.subagents.push({ agentId, toolUseId, description, subagentType, entries: sub.entries });
    const source = this.lastAssistant;
    this.wait(2);
    this.push({
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content: [{ type: 'text', text: report }] }] },
      toolUseResult: { status: 'completed', agentId, content: [{ type: 'text', text: report }] },
      sourceToolAssistantUUID: source,
    });
    return this;
  }
}

// ---------------------------------------------------------------------------
// The sessions

/** skycast — a weather web app. Working: writing the hourly strip, its tests running now. */
function hourlyStrip() {
  const s = new Session({ key: 'skycast-hourly', project: 'skycast', startedAgo: 6 * MINUTE, branch: 'feat/hourly-strip' });
  s.user('Add an hourly forecast strip under the current conditions card, like in this mockup', [hourlyMockup()]);
  s.say("Nice mockup. Let me see how the home screen is put together and what the forecast API already returns.");
  s.read('src/screens/Home.tsx', `import { CurrentConditions } from '../components/CurrentConditions';
import { useForecast } from '../api/forecast';

export function Home({ city }: { city: string }) {
  const { data, isLoading } = useForecast(city);
  if (isLoading || !data) return <Spinner />;

  return (
    <main className="home">
      <CurrentConditions now={data.current} />
      <DailyList days={data.daily} />
    </main>
  );
}`);
  s.read('src/api/forecast.ts', `export interface HourlyPoint {
  time: string;        // ISO 8601
  tempC: number;
  condition: Condition;
}

export interface Forecast {
  current: Current;
  hourly: HourlyPoint[]; // 48 hours ahead
  daily: DailyPoint[];
}`);
  s.say(`The API already returns \`hourly\` for 48 hours. It just isn't rendered anywhere. Plan:

1. A new **\`HourlyStrip\`** component: six cells, each with the hour, a \`WeatherIcon\` and the temperature.
2. A thin SVG line through the temperatures, so the trend reads at a glance.
3. Mount it in \`Home\` between the current card and the daily list.`);
  s.write('src/components/HourlyStrip.tsx', `import { WeatherIcon } from './WeatherIcon';
import type { HourlyPoint } from '../api/forecast';

const HOURS = 6;

export function HourlyStrip({ hours }: { hours: HourlyPoint[] }) {
  const next = hours.slice(0, HOURS);
  const temps = next.map((h) => h.tempC);
  const min = Math.min(...temps);
  const max = Math.max(...temps);
  const y = (t: number) => 40 - ((t - min) / Math.max(max - min, 1)) * 32;

  return (
    <section className="hourly" aria-label="Next 6 hours">
      <svg className="hourly__trend" viewBox={\`0 0 \${HOURS * 100} 48\`} preserveAspectRatio="none">
        <polyline points={next.map((h, i) => \`\${i * 100 + 50},\${y(h.tempC)}\`).join(' ')} />
      </svg>
      {next.map((h) => (
        <div className="hourly__cell" key={h.time}>
          <time>{formatHour(h.time)}</time>
          <WeatherIcon name={h.condition} size={32} />
          <span>{Math.round(h.tempC)}°</span>
        </div>
      ))}
    </section>
  );
}`);
  s.edit('src/screens/Home.tsx',
    `      <CurrentConditions now={data.current} />
      <DailyList days={data.daily} />`,
    `      <CurrentConditions now={data.current} />
      <HourlyStrip hours={data.hourly} />
      <DailyList days={data.daily} />`);
  s.say('Wired in. Running the component tests before I touch the styles.');
  s.wait(5);
  s.tool('Bash', { command: 'npm test -- HourlyStrip', description: 'Run the HourlyStrip tests' });
  return { session: s, live: 'busy', intended: 'working' };
}

/** skycast — ended: blurry icons on retina, fixed with an SVG sprite. */
function blurryIcons() {
  const s = new Session({ key: 'skycast-icons', project: 'skycast', startedAgo: 55 * MINUTE });
  s.user('The weather icons look blurry on retina screens, see docs/screenshots/icons-before.png');
  s.readImage('docs/screenshots/icons-before.png', blurryIconScreenshot());
  s.say("You can see the pixel grid: that icon is a **16 px raster** being stretched by the browser. Let me check how the icons are shipped.");
  s.bash('ls src/assets/icons', 'List the icon assets', `clear-day.png
clear-night.png
cloudy.png
partly-cloudy.png
rain.png
snow.png
sprite.svg
thunder.png`);
  s.read('src/components/WeatherIcon.tsx', `export function WeatherIcon({ name, size = 48 }: Props) {
  return <img src={\`/icons/\${name}.png\`} width={size} height={size} alt="" />;
}`);
  s.say("There's already a `sprite.svg` with every icon in it. It just isn't used. Switching the component to the sprite makes the icons sharp at any size and drops seven requests.");
  s.edit('src/components/WeatherIcon.tsx',
    `  return <img src={\`/icons/\${name}.png\`} width={size} height={size} alt="" />;`,
    `  return (
    <svg width={size} height={size} aria-hidden="true">
      <use href={\`/icons/sprite.svg#\${name}\`} />
    </svg>
  );`);
  s.bash('npm run build', 'Build the app', `vite v6.2.1 building for production...
✓ 214 modules transformed.
dist/index.html                  0.62 kB │ gzip:  0.38 kB
dist/assets/index-4f1c2a.css     8.91 kB │ gzip:  2.47 kB
dist/assets/index-9b3e7d.js    148.20 kB │ gzip: 47.85 kB
✓ built in 1.84s`, { seconds: 6 });
  s.bash('git rm -q src/assets/icons/*.png && git status --short', 'Remove the unused PNG icons', `D  src/assets/icons/clear-day.png
D  src/assets/icons/clear-night.png
D  src/assets/icons/cloudy.png
D  src/assets/icons/partly-cloudy.png
D  src/assets/icons/rain.png
D  src/assets/icons/snow.png
D  src/assets/icons/thunder.png
 M src/components/WeatherIcon.tsx`);
  s.say(`Fixed. The icons are now drawn from the SVG sprite, so they stay sharp on every screen density.

**What changed**
- \`WeatherIcon\` renders \`<svg><use href="sprite.svg#name"/></svg>\` instead of a PNG
- the seven unused PNGs are gone (−41 kB)
- the build is clean

One request for all icons instead of seven, too.`);
  return { session: s, intended: 'ended' };
}

/** ledger-api — open in a terminal, waiting on an AskUserQuestion answer. */
function webhookRetries() {
  const s = new Session({ key: 'ledger-webhooks', project: 'ledger-api', startedAgo: 9 * MINUTE, branch: 'feat/webhook-retries' });
  s.user('Retry failed webhook deliveries with exponential backoff');
  s.bash('rg -n "deliverWebhook" src', 'Find where webhooks are delivered', `src/webhooks/deliver.ts:12:export async function deliverWebhook(event: WebhookEvent, endpoint: Endpoint) {
src/payments/capture.ts:88:  await deliverWebhook(event, merchant.webhook);
src/refunds/service.ts:61:  await deliverWebhook(event, merchant.webhook);`);
  s.read('src/webhooks/deliver.ts', `export async function deliverWebhook(event: WebhookEvent, endpoint: Endpoint) {
  const body = JSON.stringify(event);
  const res = await fetch(endpoint.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'ledger-signature': sign(body, endpoint.secret) },
    body,
  });
  if (!res.ok) logger.warn({ event: event.id, status: res.status }, 'webhook delivery failed');
}`);
  s.say(`Confirmed: one attempt, and a failure is only logged. Here's what I'd build:

- a \`webhook_deliveries\` table, one row per attempt
- a worker that retries with **exponential backoff and jitter**: 30 s, 2 min, 8 min, 32 min… up to **8 attempts** (about 36 hours)
- delivery stays signed and idempotent: the same \`event.id\` on every attempt

One thing I need from you first.`);
  s.wait(2);
  s.tool('AskUserQuestion', {
    questions: [{
      question: 'What should happen to a delivery that still fails after the last retry?',
      header: 'After retries',
      multiSelect: false,
      options: [
        { label: 'Dead-letter it (Recommended)', description: 'Keep it in a dead-letter table the merchant can replay from the dashboard.' },
        { label: 'Disable the endpoint', description: 'Mark the webhook endpoint disabled and email the merchant.' },
        { label: 'Drop it', description: 'Log it and move on, as today.' },
      ],
    }],
  });
  return { session: s, live: 'waiting', intended: 'needs input' };
}

/** ledger-api — ended: a 500 on partial refunds, found and fixed. */
function partialRefunds() {
  const s = new Session({ key: 'ledger-refunds', project: 'ledger-api', startedAgo: 2 * HOUR + 20 * MINUTE });
  s.user('POST /refunds returns 500 for partial refunds. Full refunds work fine.');
  s.bash('npm test -- refunds', 'Run the refund tests', `FAIL  test/refunds.test.ts
  ✓ refunds a captured charge in full (41 ms)
  ✕ refunds part of a captured charge (12 ms)

  ● refunds part of a captured charge
    expected 201 "Created", got 500 "Internal Server Error"

    RefundExceedsChargeError: refund of 2500 exceeds remaining 0
      at assertRefundable (src/refunds/service.ts:42:11)

Tests: 1 failed, 1 passed, 2 total`, { isError: true, seconds: 5 });
  s.read('src/refunds/service.ts', `export function remainingOf(charge: Charge): number {
  const refunded = charge.refunds.reduce((sum, r) => sum + r.amount, 0);
  return charge.amount - refunded - charge.amount;
}

export function assertRefundable(charge: Charge, amount: number) {
  const remaining = remainingOf(charge);
  if (amount > remaining) throw new RefundExceedsChargeError(amount, remaining);
}`);
  s.say(`Found it. \`remainingOf\` subtracts \`charge.amount\` **twice**, so the remaining balance of any charge is always ≤ 0. A full refund only worked because it takes a different path (\`refundInFull\`) that never calls this check.`);
  s.edit('src/refunds/service.ts',
    `  return charge.amount - refunded - charge.amount;`,
    `  return charge.amount - refunded;`);
  s.say("And a regression test for a second partial refund, which is where this would bite next:");
  s.edit('test/refunds.test.ts',
    `  it('refunds part of a captured charge', async () => {`,
    `  it('refunds a charge in two parts, then refuses a third', async () => {
    const charge = await captured(10_000);
    await refund(charge, 6_000).expect(201);
    await refund(charge, 4_000).expect(201);
    await refund(charge, 1).expect(422);
  });

  it('refunds part of a captured charge', async () => {`);
  s.bash('npm test -- refunds', 'Run the refund tests again', `PASS  test/refunds.test.ts
  ✓ refunds a captured charge in full (38 ms)
  ✓ refunds a charge in two parts, then refuses a third (27 ms)
  ✓ refunds part of a captured charge (11 ms)

Tests: 3 passed, 3 total`, { seconds: 5 });
  s.say(`Fixed: partial refunds go through again.

| | before | after |
|---|---|---|
| remaining on a fresh 100.00 charge | −0.00 | 100.00 |
| partial refund of 25.00 | 500 | 201 |
| refund past the balance | 500 | 422 |

The bug came in with the multi-currency refactor last week; full refunds hid it because they skip this check.`);
  return { session: s, intended: 'ended' };
}

/** fieldnotes — a blog. Ended: RSS feed and reading time, with an Explore subagent. */
function rssFeed() {
  const s = new Session({ key: 'fieldnotes-rss', project: 'fieldnotes', startedAgo: 5 * HOUR, model: SONNET });
  s.user('Add an RSS feed and a reading-time estimate to the blog posts.');
  s.agent({
    description: 'Survey post frontmatter',
    subagentType: 'Explore',
    prompt: 'List the frontmatter fields used across src/content/posts/*.md and note any post missing a date or description.',
    report: `28 posts. Every post has \`title\`, \`date\` and \`tags\`. Three have no \`description\`:
- 2024-03-hello-world.md
- 2024-07-notes-on-sourdough.md
- 2025-01-year-in-review.md
No post has a reading-time field.`,
    steps: (sub) => {
      sub.bash('ls src/content/posts | wc -l', 'Count the posts', '28');
      sub.bash('grep -L "^description:" src/content/posts/*.md', 'Find posts without a description', `src/content/posts/2024-03-hello-world.md
src/content/posts/2024-07-notes-on-sourdough.md
src/content/posts/2025-01-year-in-review.md`);
      sub.say('28 posts; three lack a description. No reading-time field anywhere.');
    },
  });
  s.say("Three posts have no description, so the feed falls back to the first paragraph for those. Adding the RSS integration:");
  s.bash('npm install @astrojs/rss', 'Install the RSS integration', `added 3 packages, and audited 412 packages in 2s
found 0 vulnerabilities`, { seconds: 4 });
  s.write('src/pages/rss.xml.ts', `import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';

export async function GET(context) {
  const posts = (await getCollection('posts')).sort((a, b) => +b.data.date - +a.data.date);
  return rss({
    title: 'Field Notes',
    description: 'Writing about software, slowly.',
    site: context.site,
    items: posts.map((post) => ({
      title: post.data.title,
      pubDate: post.data.date,
      description: post.data.description ?? excerpt(post.body),
      link: \`/posts/\${post.slug}/\`,
    })),
  });
}`);
  s.edit('src/layouts/Post.astro',
    `<time datetime={date.toISOString()}>{formatDate(date)}</time>`,
    `<time datetime={date.toISOString()}>{formatDate(date)}</time>
<span class="reading-time">{Math.max(1, Math.round(wordCount(body) / 230))} min read</span>`);
  s.bash('npm run build', 'Build the site', `12:41:07 [build] 28 page(s) built in 3.12s
12:41:07 [build] /rss.xml
12:41:07 [build] Complete!`, { seconds: 6 });
  s.say(`Done. The feed is at **/rss.xml** and every post shows its reading time under the date.

- feed: newest first, all 28 posts, excerpt as fallback description
- reading time: words ÷ 230, never below 1 min
- three posts still have no \`description\`; worth writing one each for nicer feed previews`);
  return { session: s, intended: 'ended' };
}

/** fieldnotes — open in a terminal, waiting on a permission prompt for the deploy. */
function brokenLinks() {
  const s = new Session({ key: 'fieldnotes-links', project: 'fieldnotes', startedAgo: 4 * MINUTE, model: SONNET });
  s.user('Fix the broken links the link checker found, then deploy.');
  s.bash('npm run check:links', 'Run the link checker', `✗ /posts/notes-on-sourdough/  →  https://example.org/old-recipe (404)
✗ /posts/year-in-review/      →  /posts/hello-wrld/ (404)
✗ /about/                     →  /assets/cv.pdf (404)

3 broken links in 28 pages`, { isError: true, seconds: 8 });
  s.edit('src/content/posts/2025-01-year-in-review.md', '[my first post](/posts/hello-wrld/)', '[my first post](/posts/hello-world/)');
  s.edit('src/content/posts/2024-07-notes-on-sourdough.md', '(https://example.org/old-recipe)', '(https://web.archive.org/web/2023/https://example.org/old-recipe)');
  s.edit('src/pages/about.astro', '<a href="/assets/cv.pdf">CV</a>', '<a href="/assets/cv-2025.pdf">CV</a>');
  s.bash('npm run check:links', 'Run the link checker again', '✓ 0 broken links in 28 pages', { seconds: 8 });
  s.say('All three fixed: a typo, a dead external page (now pointing at the archived copy) and a renamed PDF. Deploying.');
  s.wait(2);
  s.tool('Bash', { command: 'npm run deploy', description: 'Deploy the site to production' });
  return { session: s, live: 'waiting', intended: 'needs input' };
}

/** pocketbudget — an iOS app. Ended yesterday: Face ID lock. */
function faceIdLock() {
  const s = new Session({ key: 'pocketbudget-faceid', project: 'pocketbudget', startedAgo: 26 * HOUR });
  s.user('Lock the app behind Face ID whenever it comes back from the background.');
  s.read('PocketBudget/PocketBudgetApp.swift', `@main
struct PocketBudgetApp: App {
    @StateObject private var store = BudgetStore()

    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(store)
        }
    }
}`);
  s.write('PocketBudget/Security/BiometricLock.swift', `import LocalAuthentication
import SwiftUI

@MainActor
final class BiometricLock: ObservableObject {
    @Published private(set) var isLocked = true

    func unlock() async {
        let context = LAContext()
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else { return }
        isLocked = !((try? await context.evaluatePolicy(
            .deviceOwnerAuthentication,
            localizedReason: "Unlock your budget"
        )) ?? false)
    }

    func lock() { isLocked = true }
}`);
  s.edit('PocketBudget/PocketBudgetApp.swift',
    `            RootView().environmentObject(store)
        }`,
    `            RootView()
                .environmentObject(store)
                .overlay { if lock.isLocked { LockScreen(lock: lock) } }
                .task { await lock.unlock() }
        }
        .onChange(of: phase) { _, new in if new == .background { lock.lock() } }`);
  s.edit('PocketBudget/Info.plist',
    `	<key>UILaunchScreen</key>`,
    `	<key>NSFaceIDUsageDescription</key>
	<string>PocketBudget uses Face ID to keep your finances private.</string>
	<key>UILaunchScreen</key>`);
  s.bash('xcodebuild test -scheme PocketBudget -destination "platform=iOS Simulator,name=iPhone 17" -quiet', 'Run the unit tests on the simulator', `Test Suite 'All tests' passed at 2026-11-10 14:02:51.
	 Executed 46 tests, with 0 failures (0 unexpected) in 3.871 seconds
** TEST SUCCEEDED **`, { seconds: 40 });
  s.say(`The app now locks itself when it goes to the background and asks for Face ID when it comes back.

- **\`BiometricLock\`** wraps \`LAContext\`; it falls back to the passcode if Face ID fails
- the lock screen covers the content *before* the app snapshot is taken, so the app switcher never shows balances
- \`NSFaceIDUsageDescription\` added to Info.plist (the system prompt fails without it)

All 46 tests pass.`);
  return { session: s, intended: 'ended' };
}

const SESSIONS = [hourlyStrip, webhookRetries, brokenLinks, blurryIcons, partialRefunds, rssFeed, faceIdLock];

// ---------------------------------------------------------------------------
// Writing it out

const lines = (entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

function writeTranscript(projectsDir, s) {
  const dir = join(projectsDir, encodeCwd(s.cwd));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${s.id}.jsonl`);
  writeFileSync(path, lines(s.entries));
  const last = new Date(s.at);
  utimesSync(path, last, last);
  for (const agent of s.subagents) {
    const subDir = join(dir, s.id, 'subagents');
    mkdirSync(subDir, { recursive: true });
    const entries = agent.entries.map((e) => ({ ...e, isSidechain: true, agentId: agent.agentId }));
    writeFileSync(join(subDir, `agent-${agent.agentId}.jsonl`), lines(entries));
    writeFileSync(join(subDir, `agent-${agent.agentId}.meta.json`), JSON.stringify({
      agentType: agent.subagentType, description: agent.description, toolUseId: agent.toolUseId,
    }));
  }
}

/** A process that does nothing for `HOLD_MS`; its pid vouches for one live registry entry. */
function spawnHolder() {
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${HOLD_MS})`, HOLDER_MARK], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child.pid;
}

function stopHolders(holdersPath) {
  if (!existsSync(holdersPath)) return 0;
  let stopped = 0;
  for (const pid of JSON.parse(readFileSync(holdersPath, 'utf8'))) {
    let command;
    try {
      command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    } catch {
      continue; // already gone
    }
    if (!command.includes(HOLDER_MARK)) continue;
    process.kill(pid);
    stopped++;
  }
  rmSync(holdersPath, { force: true });
  return stopped;
}

function main() {
  const args = process.argv.slice(2);
  const outArg = args.find((a) => !a.startsWith('--'));
  if (!outArg) {
    console.error('usage: node mobile/scripts/store-demo.mjs <outDir> [--stop]');
    process.exit(1);
  }
  const outDir = resolve(outArg);
  const holdersPath = join(outDir, 'holders.json');
  const stopped = stopHolders(holdersPath);
  if (args.includes('--stop')) {
    console.log(`stopped ${stopped} holder process(es)`);
    return;
  }

  const claudeDir = join(outDir, 'claude');
  rmSync(claudeDir, { recursive: true, force: true });
  const projectsDir = join(claudeDir, 'projects');
  const sessionsDir = join(claudeDir, 'sessions');
  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });

  const holders = [];
  const summary = [];
  for (const build of SESSIONS) {
    const { session: s, live, intended } = build();
    writeTranscript(projectsDir, s);
    if (live) {
      const pid = spawnHolder();
      holders.push(pid);
      writeFileSync(join(sessionsDir, `${pid}.json`), JSON.stringify({
        pid,
        sessionId: s.id,
        cwd: s.cwd,
        startedAt: s.entries[0] ? Date.parse(s.entries[0].timestamp) : Date.now(),
        version: CLI_VERSION,
        kind: 'interactive',
        entrypoint: 'cli',
        name: basename(s.cwd),
        status: live,
        updatedAt: Date.now(),
      }));
    }
    const prompt = s.entries[0].message.content.find((b) => b.type === 'text').text;
    summary.push(`  ${basename(s.cwd).padEnd(13)} ${intended.padEnd(12)} ${s.id}  ${prompt}`);
  }
  writeFileSync(holdersPath, JSON.stringify(holders));

  console.log(`wrote ${SESSIONS.length} sessions to ${claudeDir}`);
  console.log(summary.join('\n'));
  console.log(`\n${holders.length} live session(s) held for ${HOLD_MS / HOUR} h; end them with --stop.`);
  // Unset: a shell opened from an Orbital session inherits the desktop server's own paths.
  console.log(`\nServe it with:\n  env -u ORBITAL_MIGRATIONS_DIR -u ORBITAL_STATIC_DIR -u ORBITAL_RESOLVE_PATH ` +
    `ORBITAL_CLAUDE_DIR=${claudeDir} ORBITAL_DATA_DIR=${join(outDir, 'data')} npm run dev -w server`);
}

main();
