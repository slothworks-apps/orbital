/**
 * Generated views: small HTML pages an Orbital session writes and shows in
 * its transcript (spec 2026-11-18-generated-views-design). What the server,
 * the desktop and the phone agree on: the tool and its input, the limits, the
 * text of the tool's result and of a message sent from a view, how calls fold
 * into views, which hosts a page may reach, and the page's CSP.
 *
 * A view has no table of its own. It is the fold of the tool's calls in the
 * transcript: a call with `replaces` updates an earlier view, and a view's id
 * is the tool_use id of the call that first showed it.
 */

import { z } from 'zod';

/** The tool's own name on Orbital's MCP server; `VIEW_TOOL` is how the CLI writes it. */
export const VIEW_TOOL_NAME = 'show_view';
/** The tool's name as the CLI writes it into a transcript: Orbital's `orbital` MCP server, `show_view`. */
export const VIEW_TOOL = 'mcp__orbital__show_view';

/** The Labs switch, shared across a group: off, no session gets the tool and views read as tool rows. */
export const VIEWS_ENABLED_KEY = 'views_enabled';
/** The CDN hosts the user added beside the built-in ones: a JSON `CdnHost[]`, kept on the Mac. */
export const VIEWS_CDN_HOSTS_KEY = 'views_cdn_hosts';
/** Where a view's scripts and stylesheets may always load from (69f: listed first, locked). */
export const VIEW_BUILTIN_CDN_HOSTS: readonly string[] = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com', 'esm.sh'];

/** A view's height in the transcript, px: what a call may ask for is clamped to `min`–`max`, `phoneMax` on the phone. */
export const VIEW_HEIGHT = { min: 120, max: 480, phoneMax: 420, default: 320 } as const;

/** The height a view is drawn at: the asked one clamped, or the default when none or no number was asked. */
export function clampViewHeight(height: number | null | undefined, phone = false): number {
  const max = phone ? VIEW_HEIGHT.phoneMax : VIEW_HEIGHT.max;
  const asked = typeof height === 'number' && Number.isFinite(height) ? Math.round(height) : VIEW_HEIGHT.default;
  return Math.min(max, Math.max(VIEW_HEIGHT.min, asked));
}

/** The page's source (`component` or `html`) plus its inline `data`, serialised: what one call may write into the transcript. */
export const VIEW_PAGE_MAX_CHARS = 150_000;
/** The largest `dataFile` the server copies. */
export const VIEW_DATA_FILE_MAX_BYTES = 10 * 1024 * 1024;
/**
 * A `dataFile` copy up to this size rides inside the view's payload
 * (`ViewPayload.data.inline`); a larger one is fetched on its own
 * (`ViewDataSource.data`, `file_get` as `view-data` on the phone).
 */
export const VIEW_DATA_INLINE_REST_MAX = 192 * 1024;
/**
 * The most a `ViewPayload` may come to, serialised, in UTF-8 bytes: it has to
 * fit one relay frame (`MAX_FRAME_BYTES` in `remote/frame.ts`) with room for
 * the envelope. A data copy that would push it past rides outside it
 * (`data.inline` false); a page that would on its own is refused at call time.
 */
export const VIEW_PAYLOAD_MAX_BYTES = 200 * 1024;
/**
 * The most one `orbital.send` value may come to, serialised, in UTF-8 bytes
 * (`viewValueBytes`): the page refuses a larger one, and so does the Mac's
 * decision route.
 */
export const VIEW_SEND_MAX_BYTES = 64 * 1024;
/**
 * The most of a call's result a payload or a `decision_resolved` event echoes
 * back, in UTF-8 bytes (`echoViewResult`): a client shows only a line of it,
 * and the composer's words answering a waiting view have no bound of their
 * own. The agent always gets the whole of it in its tool result.
 */
export const VIEW_RESULT_ECHO_MAX_BYTES = 4 * 1024;
/** The most domains one call may ask to fetch from. */
export const VIEW_LIVE_DOMAINS_MAX = 8;
/** The longest title a view may carry. */
export const VIEW_TITLE_MAX_CHARS = 200;

// ---------------------------------------------------------------------------
// The tool's input

/** One call of the tool, as its input carries it. */
export interface ShowViewInput {
  title: string;
  /** A React component in TSX; the usual way. Exactly one of `component` and `html`. */
  component?: string;
  /** A plain page; for what needs no React. */
  html?: string;
  data?: unknown;
  dataFile?: string;
  height?: number;
  liveDomains?: string[];
  wait?: boolean;
  replaces?: string;
}

/**
 * The tool's input schema, as the MCP server registers it. Loose on purpose:
 * the bounds are kept by `showViewRefusal`, whose refusals the agent can
 * read, rather than by the schema, whose errors it cannot. The descriptions
 * are what the agent reads about each field.
 */
export const showViewShape = {
  title: z.string().describe('One line naming the view, shown on it and in the session\'s media. Keep it the same when you update the view.'),
  component: z
    .string()
    .optional()
    .describe(
      'The view as a React component in TSX, the usual way: a module whose default export is the component; it receives the data as the `data` prop. ' +
        'Style it with Tailwind classes, which use Orbital\'s own tokens (bg-panel, text-ink-300, border-line, text-accent…). ' +
        'React is provided; other packages are imported by name (import { LineChart } from \'recharts\') and load from esm.sh. Read the data from the prop, never fetch it.',
    ),
  html: z
    .string()
    .optional()
    .describe(
      'Instead of component, for what needs no React: a plain page with its CSS and JS inline. Orbital already styles the background, text, tables, buttons and inputs in the user\'s colours; use the --color-* variables for anything else. ' +
        'Scripts and stylesheets may load from the CDNs listed in the tool\'s description, nothing else. Read the data from orbital.data, never fetch it.',
    ),
  data: z
    .unknown()
    .optional()
    .describe(`Small JSON data for the page, available as orbital.data. With the html it may come to ${VIEW_PAGE_MAX_CHARS} characters; for more, use dataFile.`),
  dataFile: z
    .string()
    .optional()
    .describe(
      'Path to a .json or .csv file with the data, for anything large: write it with a script, then pass the path. Orbital copies it when the call is made, so the view keeps working if the file changes. ' +
        'The page gets it as orbital.data (JSON parsed, CSV as text). Not together with data.',
    ),
  height: z
    .number()
    .optional()
    .describe(`The view's height in the transcript, px. Clamped to ${VIEW_HEIGHT.min}–${VIEW_HEIGHT.max}; ${VIEW_HEIGHT.default} when left out. Taller content scrolls inside the view.`),
  liveDomains: z
    .array(z.string())
    .optional()
    .describe(
      `Only when the data must be live: https hosts the page may fetch from, like api.github.com (at most ${VIEW_LIVE_DOMAINS_MAX}). The user is asked to allow them before the view loads.`,
    ),
  wait: z
    .boolean()
    .optional()
    .describe(
      'Wait for the user: the tool returns only when the page calls orbital.send(value), and returns that value. Use it for a picker or a form whose answer you need to go on. ' +
        'Without it, the tool returns at once and each orbital.send arrives as the user\'s message.',
    ),
  replaces: z
    .string()
    .optional()
    .describe(
      'The id of an earlier view of this session to update in place of showing a new one. While you iterate on a view, always update it; make a new view only when the user asks for one.',
    ),
};

const RETRY = `Nothing was shown; fix it and call ${VIEW_TOOL_NAME} again.`;

/** What the server knows of the call beyond its input. */
export interface ShowViewCheck {
  /** The `dataFile`'s size on disk; null when it cannot be read; undefined when the call names none. */
  dataFileBytes?: number | null;
}

/** The data a `dataFile` path holds by its extension, or null when it is neither JSON nor CSV. */
export function viewDataFormat(path: string): 'json' | 'csv' | null {
  const ext = /\.([a-z]+)$/i.exec(path.trim())?.[1]?.toLowerCase();
  return ext === 'json' ? 'json' : ext === 'csv' ? 'csv' : null;
}

/** `data` as it is written into the page, or how many characters it takes; 0 for none. */
function inlineDataChars(data: unknown): number {
  if (data === undefined) return 0;
  try {
    return JSON.stringify(data)?.length ?? 0;
  } catch {
    return Infinity;
  }
}

/**
 * Why a call may not be shown, or null when it may: what the input alone
 * says (sizes, the data file, the domains). What depends on the session — the
 * Labs switch, a subagent, a `replaces` that names no view of the session, a
 * view still waiting — the server checks itself.
 */
export function showViewRefusal(input: ShowViewInput, check: ShowViewCheck = {}): string | null {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title === '') return `Give the view a \`title\`: one line the user reads. ${RETRY}`;
  if (title.length > VIEW_TITLE_MAX_CHARS) return `Keep \`title\` to one short line, at most ${VIEW_TITLE_MAX_CHARS} characters. ${RETRY}`;
  const hasComponent = typeof input.component === 'string' && input.component.trim() !== '';
  const hasHtml = typeof input.html === 'string' && input.html.trim() !== '';
  if (hasComponent && hasHtml) return `Send either \`component\` or \`html\`, not both. ${RETRY}`;
  if (!hasComponent && !hasHtml) return `Send the view: a React \`component\` in TSX, or a plain \`html\` page. ${RETRY}`;
  if (input.height !== undefined && (typeof input.height !== 'number' || !Number.isFinite(input.height))) {
    return `\`height\` is a number of px, or left out. ${RETRY}`;
  }

  const hasFile = typeof input.dataFile === 'string' && input.dataFile.trim() !== '';
  if (hasFile && input.data !== undefined) return `Pass the data either inline as \`data\` or as \`dataFile\`, not both. ${RETRY}`;
  const chars = (hasComponent ? input.component! : input.html!).length + inlineDataChars(input.data);
  if (chars > VIEW_PAGE_MAX_CHARS) {
    return (
      `The view's source and its inline data come to ${chars} characters; the most is ${VIEW_PAGE_MAX_CHARS}. ` +
      `Write the data to a .json or .csv file with a script and pass its path as \`dataFile\`, and keep the page small. ${RETRY}`
    );
  }
  if (hasFile) {
    const path = input.dataFile!.trim();
    if (viewDataFormat(path) === null) return `\`dataFile\` must be a .json or .csv file; ${path} is neither. ${RETRY}`;
    if (check.dataFileBytes === null) return `\`dataFile\` ${path} cannot be read. ${RETRY}`;
    if (check.dataFileBytes !== undefined && check.dataFileBytes > VIEW_DATA_FILE_MAX_BYTES) {
      return `\`dataFile\` ${path} is ${check.dataFileBytes} bytes; the most is ${VIEW_DATA_FILE_MAX_BYTES}. Aggregate the data first. ${RETRY}`;
    }
  }

  if (input.liveDomains !== undefined) {
    if (!Array.isArray(input.liveDomains)) return `\`liveDomains\` is a list of hosts, like ["api.github.com"]. ${RETRY}`;
    if (input.liveDomains.length > VIEW_LIVE_DOMAINS_MAX) {
      return `Ask for at most ${VIEW_LIVE_DOMAINS_MAX} \`liveDomains\`; pass the rest of the data with the call. ${RETRY}`;
    }
    const bad = input.liveDomains.filter((raw) => typeof raw !== 'string' || normaliseLiveDomain(raw) === null);
    if (bad.length > 0) {
      return (
        `\`liveDomains\` takes https hosts only, like api.github.com: no http, port, path, wildcard, IP address or local name. ` +
        `Not: ${bad.map((raw) => JSON.stringify(raw)).join(', ')}. ${RETRY}`
      );
    }
  }
  return null;
}

/** A non-blank string, trimmed, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * A `tool_use` input read as a call, or null when it is not one: a title and
 * a component or html are needed. Tolerant, because a transcript is written by whatever CLI
 * ran: a field of the wrong type is left out.
 */
export function readShowView(input: unknown): ShowViewInput | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const component = typeof raw.component === 'string' ? raw.component : undefined;
  const html = typeof raw.html === 'string' ? raw.html : undefined;
  if (typeof raw.title !== 'string' || (component === undefined && html === undefined)) return null;
  const dataFile = text(raw.dataFile);
  const replaces = text(raw.replaces);
  return {
    title: raw.title,
    ...(component !== undefined ? { component } : { html }),
    ...(raw.data !== undefined ? { data: raw.data } : {}),
    ...(dataFile !== undefined ? { dataFile } : {}),
    ...(typeof raw.height === 'number' && Number.isFinite(raw.height) ? { height: raw.height } : {}),
    ...(Array.isArray(raw.liveDomains) ? { liveDomains: raw.liveDomains.filter((d): d is string => typeof d === 'string') } : {}),
    ...(raw.wait === true ? { wait: true } : {}),
    ...(replaces !== undefined ? { replaces } : {}),
  };
}

// ---------------------------------------------------------------------------
// Views from calls

/** The id of the view a call shows: the view it replaces, or the call itself. */
export function viewIdOf(input: { replaces?: unknown } | null | undefined, toolUseId: string): string {
  return text(input?.replaces) ?? toolUseId;
}

/** One call of the tool in transcript order; `isError` when its result refused it. */
export interface ViewCall {
  toolUseId: string;
  input: unknown;
  isError?: boolean;
}

export interface ViewFold {
  /** Each shown call's view id. A refused call is no view and is not here. */
  viewOf: Map<string, string>;
  /** Each view's newest call: the one drawn. */
  latest: Map<string, string>;
  /** Calls a later call of their view replaced: each keeps one line, "updated below". */
  superseded: Set<string>;
}

/**
 * The calls folded into views. A `replaces` that names a later call of a view
 * resolves to the view's id, the call that first showed it. One that names
 * no call seen here (the call is outside what was folded) is taken as the
 * view id it names.
 */
export function foldViews(calls: readonly ViewCall[]): ViewFold {
  const viewOf = new Map<string, string>();
  const latest = new Map<string, string>();
  const superseded = new Set<string>();
  for (const call of calls) {
    if (call.isError === true) continue;
    const named = text((call.input as { replaces?: unknown } | null | undefined)?.replaces);
    const viewId = named === undefined ? call.toolUseId : (viewOf.get(named) ?? named);
    viewOf.set(call.toolUseId, viewId);
    const before = latest.get(viewId);
    if (before !== undefined) superseded.add(before);
    latest.set(viewId, call.toolUseId);
  }
  return { viewOf, latest, superseded };
}

// ---------------------------------------------------------------------------
// The tool's result

/**
 * What a call came to. `shown`: the view is up and the tool returned at
 * once. With `wait`: `sent`, the page sent `value`; `answered`, the user
 * typed `text` in the composer instead; `cancelled`, the wait ended without
 * either (the turn was stopped, the session ended).
 */
export type ViewResult =
  | { viewId: string; outcome: 'shown' }
  | { viewId: string; outcome: 'sent'; value: unknown }
  | { viewId: string; outcome: 'answered'; text: string }
  | { viewId: string; outcome: 'cancelled'; reason: string };

/** The first line of each outcome after `View <id>: `; the parsing contract of `readViewResult`. */
const RESULT_LINES = {
  shown: 'shown.',
  sent: 'the user sent this from the view.',
  answered: 'the user answered in words instead of in the view.',
  cancelled: 'cancelled; nothing was sent from it.',
} as const;

/** A fence longer than the longest run of backticks in the body, as the editor's selection block has. */
function fenceFor(body: string): string {
  let longest = 2;
  for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(longest + 1);
}

function json(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value, null, 2);
}

/** The tool result's text: a fixed first line, then what the outcome carries. */
export function viewResultText(result: ViewResult): string {
  const head = `View ${result.viewId}: ${RESULT_LINES[result.outcome]}`;
  switch (result.outcome) {
    case 'shown':
      return (
        `${head}\nTo change it, call ${VIEW_TOOL_NAME} again with replaces: "${result.viewId}". ` +
        'What the user sends from it arrives as their message.'
      );
    case 'sent': {
      const body = json(result.value);
      const fence = fenceFor(body);
      return `${head}\n\n${fence}json\n${body}\n${fence}`;
    }
    case 'answered':
      return `${head}\n\n${result.text}`;
    case 'cancelled':
      return result.reason ? `${head}\n\n${result.reason}` : head;
  }
}

/** A string's size in UTF-8 bytes. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** A value's size as `orbital.send` serialises it, in UTF-8 bytes; null for one JSON cannot carry. */
export function viewValueBytes(value: unknown): number | null {
  let text: string | undefined;
  try {
    text = JSON.stringify(value === undefined ? null : value);
  } catch {
    return null;
  }
  return typeof text === 'string' ? utf8Bytes(text) : null;
}

/** The longest start of `text` that, with a closing `…`, fits `maxBytes` UTF-8 bytes; `text` itself when it fits. */
function cutToBytes(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  const room = maxBytes - 3;
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const size = utf8Bytes(ch);
    if (bytes + size > room) break;
    bytes += size;
    end += ch.length;
  }
  return `${text.slice(0, end)}…`;
}

/**
 * A result as a client is handed it back (`ViewPayload.result`, the
 * `decision_resolved` event): what the user sent or typed cut to
 * `maxBytes`. A sent value too large is replaced by the start of its JSON,
 * as a string — the client shows a summary line of it, nothing more.
 */
export function echoViewResult(result: ViewResult, maxBytes = VIEW_RESULT_ECHO_MAX_BYTES): ViewResult {
  switch (result.outcome) {
    case 'sent': {
      const bytes = viewValueBytes(result.value);
      if (bytes !== null && bytes <= maxBytes) return result;
      let text: string;
      try {
        text = JSON.stringify(result.value === undefined ? null : result.value) ?? 'null';
      } catch {
        text = '';
      }
      // Serialised again, the string is quoted, and each quote or backslash in it
      // doubled (the JSON text has no control characters left to escape).
      return { ...result, value: cutToBytes(text, Math.floor((maxBytes - 2) / 2)) };
    }
    case 'answered':
      return { ...result, text: cutToBytes(result.text, maxBytes) };
    case 'cancelled':
      return { ...result, reason: cutToBytes(result.reason, maxBytes) };
    case 'shown':
      return result;
  }
}

const RESULT_HEAD = /^View (\S+): ([^\n]*)/;
const SENT_BLOCK = /^(`{3,})json\n([\s\S]*)\n\1$/;

/** A tool result's text read back, or null when it is not one `viewResultText` wrote. */
export function readViewResult(text: string): ViewResult | null {
  const head = RESULT_HEAD.exec(text);
  if (!head) return null;
  const [line, viewId, phrase] = head;
  const outcome = (Object.keys(RESULT_LINES) as (keyof typeof RESULT_LINES)[]).find((key) => RESULT_LINES[key] === phrase);
  if (!outcome) return null;
  const rest = text.slice(line.length).startsWith('\n\n') ? text.slice(line.length + 2) : '';
  switch (outcome) {
    case 'shown':
      return { viewId, outcome };
    case 'sent': {
      const block = SENT_BLOCK.exec(rest.trimEnd());
      if (!block) return null;
      try {
        return { viewId, outcome, value: JSON.parse(block[2]) as unknown };
      } catch {
        return null;
      }
    }
    case 'answered':
      return { viewId, outcome, text: rest };
    case 'cancelled':
      return { viewId, outcome, reason: rest };
  }
}

// ---------------------------------------------------------------------------
// Messages sent from a view

/**
 * A message from a view is the user's message, in the transcript as plain
 * text: a head line naming the view, then the value or the error in a fence
 * longer than any backtick run inside it, as the browser selection block
 * (`promptWithBrowserSelection` in `web/src/lib/browserBridge.ts`). The
 * wording is a parsing contract with `parseViewMessage` and with `cleanTitle`
 * in `server/src/transcript/parser.ts` (through `VIEW_MESSAGE_BLOCK`).
 */
const VALUE_HEAD = 'Sent from the view';
const ERROR_HEAD = 'The view';

/** A title or an id as the head line carries it: one line. */
function headTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim() || 'Untitled';
}
function headId(viewId: string): string {
  return viewId.replace(/\s/g, '') || 'view';
}

function block(head: string, body: string): string {
  const fence = fenceFor(body);
  return `${head}\n\n${fence}\n${body}\n${fence}`;
}

/** The message `orbital.send` sends from a view that does not wait. */
export function viewMessageText(message: { viewId: string; title: string; value: unknown }): string {
  return block(`${VALUE_HEAD} ${headTitle(message.title)} (${headId(message.viewId)}):`, json(message.value));
}

/** The message Send the error to the session sends from a failed view. */
export function viewErrorText(message: { viewId: string; title: string; error: string }): string {
  return block(`${ERROR_HEAD} ${headTitle(message.title)} (${headId(message.viewId)}) failed:`, message.error);
}

/** A message from a view, read back out of its own text. */
export interface ViewMessage {
  viewId: string;
  title: string;
  kind: 'value' | 'error';
  /** What the fence holds: the value as JSON, or the error. */
  body: string;
  /** What followed the block, if anything. */
  text: string;
}

// The title is greedy and the id has no spaces, so a title that carries
// "(…)" of its own still ends at the last " (" on the line.
const VALUE_RE = new RegExp(`^${VALUE_HEAD} ([^\\n]*) \\((\\S+)\\):\\n\\n(\`{3,})\\n`);
const ERROR_RE = new RegExp(`^${ERROR_HEAD} ([^\\n]*) \\((\\S+)\\) failed:\\n\\n(\`{3,})\\n`);

/** The view a message came from, or null for a message that does not open with the block. */
export function parseViewMessage(text: string | null | undefined): ViewMessage | null {
  if (!text) return null;
  const value = VALUE_RE.exec(text);
  const head = value ?? ERROR_RE.exec(text);
  if (!head) return null;
  const [matched, title, viewId, fence] = head;
  const close = text.indexOf(`\n${fence}`, matched.length);
  if (close === -1) return null;
  const after = close + 1 + fence.length;
  if (after < text.length && text[after] !== '\n') return null;
  return {
    viewId,
    title,
    kind: value ? 'value' : 'error',
    body: text.slice(matched.length, close),
    text: text.slice(after).replace(/^\n+/, ''),
  };
}

/** The block of a message from a view, for `cleanTitle`: a message from a view is not what a session is about. */
export const VIEW_MESSAGE_BLOCK = /^(?:Sent from the view [^\n]* \(\S+\):|The view [^\n]* \(\S+\) failed:)\n\n(`{3,})\n(?:[\s\S]*?\n)?\1(?:\n|$)/;

// ---------------------------------------------------------------------------
// Hosts

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
/** Names that never leave the machine or its network. */
const LOCAL_TLDS = new Set(['localhost', 'local', 'localdomain', 'internal', 'arpa']);

/**
 * A public host name, lower case: dot-separated labels and a top-level domain
 * of letters, so no IP address, port, path, wildcard, user or local name.
 */
function isPublicHost(host: string): boolean {
  if (host.length > 253) return false;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return false;
  const tld = labels[labels.length - 1];
  return TLD.test(tld) && !LOCAL_TLDS.has(tld);
}

/**
 * A domain a view asks to fetch from, as the CSP and the approval store
 * carry it (lower case, no scheme), or null when it is not an https host:
 * `https://` and a trailing `/` are taken off; http, any other scheme, a
 * port, a path, a wildcard, an IP address, localhost and `.local` names are
 * refused.
 */
export function normaliseLiveDomain(raw: string): string | null {
  let host = raw.trim().toLowerCase();
  if (host.startsWith('https://')) host = host.slice('https://'.length);
  else if (/^[a-z][a-z0-9+.-]*:/.test(host)) return null;
  if (host.endsWith('/')) host = host.slice(0, -1);
  return isPublicHost(host) ? host : null;
}

/** A CDN host the user added, and when (ms). */
export interface CdnHost {
  host: string;
  addedAt: number;
}

/**
 * A host typed into Settings → Labs → Views (69f): a host only, no scheme
 * and no path. `bad` carries what to type instead when one can be read out
 * of it; `dup` when it is built in or already added.
 */
export function checkCdnHost(raw: string, existing: readonly CdnHost[]): { host: string } | { error: 'bad' | 'dup'; suggestion?: string } {
  const typed = raw.trim().toLowerCase();
  const taken = (host: string) => VIEW_BUILTIN_CDN_HOSTS.includes(host) || existing.some((entry) => entry.host === host);
  if (!isPublicHost(typed)) {
    const suggestion = typed.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].replace(/:\d*$/, '');
    return isPublicHost(suggestion) && !taken(suggestion) ? { error: 'bad', suggestion } : { error: 'bad' };
  }
  return taken(typed) ? { error: 'dup' } : { host: typed };
}

/** The stored `VIEWS_CDN_HOSTS_KEY` value read leniently: only valid hosts, each once, none built in. */
export function readCdnHosts(stored?: string | null): CdnHost[] {
  if (!stored) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: CdnHost[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { host, addedAt } = entry as Record<string, unknown>;
    if (typeof host !== 'string' || typeof addedAt !== 'number' || !Number.isFinite(addedAt)) continue;
    const name = host.trim().toLowerCase();
    if (!isPublicHost(name) || VIEW_BUILTIN_CDN_HOSTS.includes(name) || out.some((h) => h.host === name)) continue;
    out.push({ host: name, addedAt });
  }
  return out;
}

/**
 * The page's Content-Security-Policy. `cdnHosts`: where scripts, styles,
 * fonts and images may load from; the built-in hosts are always in.
 * `connect`: the approved domains the page may fetch from, `'none'` when
 * none. Every host is checked again here, so nothing stored or sent can add
 * a directive of its own.
 *
 * `data:` is among the script sources: a React view's React packages and its
 * component are modules the import map serves as data: URLs, and Chromium
 * checks a module's URL against `script-src`. It adds nothing a page could
 * not already do with `'unsafe-inline'` and `'unsafe-eval'` in a sandboxed
 * frame.
 */
export function viewCsp({ cdnHosts, connect }: { cdnHosts: readonly string[]; connect: readonly string[] }): string {
  const origins = (hosts: Iterable<string>) => [...new Set(hosts)].map((host) => `https://${host}`);
  const cdn = origins([...VIEW_BUILTIN_CDN_HOSTS, ...cdnHosts].map((host) => host.trim().toLowerCase()).filter(isPublicHost));
  const live = origins(connect.map(normaliseLiveDomain).filter((host): host is string => host !== null));
  const list = (...parts: string[][]) => parts.flat().join(' ');
  return [
    `default-src 'none'`,
    `script-src ${list(["'unsafe-inline'", "'unsafe-eval'", 'data:'], cdn)}`,
    `style-src ${list(["'unsafe-inline'"], cdn)}`,
    `img-src ${list(['data:', 'blob:'], cdn, live)}`,
    `font-src ${list(['data:'], cdn)}`,
    `media-src data: blob:`,
    `connect-src ${live.length > 0 ? live.join(' ') : "'none'"}`,
    `form-action 'none'`,
    `base-uri 'none'`,
  ].join('; ');
}

// ---------------------------------------------------------------------------
// What the server hands a client to draw a view

export interface ViewPayload {
  viewId: string;
  /** The call drawn: the view's newest. */
  toolUseId: string;
  title: string;
  /**
   * `react`: `script` is the component compiled by the Mac to an ES module
   * (JSX and types gone, imports left as written); `html`: `html` is the page.
   */
  kind: 'react' | 'html';
  script?: string;
  html?: string;
  /** Clamped for the desktop; the phone clamps `VIEW_HEIGHT.phoneMax` on top. */
  height: number;
  wait: boolean;
  liveDomains: string[];
  /**
   * The view's data, null for none. `inline` data rides in `value` (JSON:
   * `inline` and `json`) or `text` (`csv`); otherwise it is fetched with
   * `ViewDataSource.data`. `bytes`: its size, serialised.
   */
  data: { format: 'inline' | 'json' | 'csv'; bytes: number; value?: unknown; text?: string; inline: boolean } | null;
  /** Of `liveDomains`, those the session has allowed. */
  approvedDomains: string[];
  /** Every CDN host the page may load from, the built-in ones first. */
  cdnHosts: string[];
  /** The call waits on the user and nothing has answered it yet. */
  waiting: boolean;
  /** What the call came to, null while it waits. */
  result: ViewResult | null;
}

/** The hub event that a session's allowed domains changed. */
export const VIEW_DOMAINS_EVENT = 'view_domains';
export interface ViewDomainsEvent {
  event: typeof VIEW_DOMAINS_EVENT;
  /** Every domain the session has allowed now. */
  domains: string[];
}
