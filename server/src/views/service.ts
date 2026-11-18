/**
 * Generated views on the Mac (spec 2026-11-18-generated-views-design): the
 * `show_view` tool an Orbital session is given while the Labs switch is on,
 * the rules it keeps beyond `showViewRefusal`, the component it compiles,
 * the data copy it makes, and the payload a client draws a view from.
 *
 * A view has no table: it is the fold of the tool's calls in the session's
 * transcript (`foldViews`). What the transcript cannot hold yet — a call the
 * CLI has not written, the compiled script, the data copy — is kept here, in
 * memory and under `<dataDir>/views/<sessionId>/`.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { tool, type HookInput, type HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { transform } from 'sucrase';
import { TOKENS } from '@orbital/shared/colourTokens';
import { viewMediaId, type MediaItem } from '@orbital/shared/media';
import {
  VIEW_BUILTIN_CDN_HOSTS, VIEW_DATA_INLINE_REST_MAX, VIEW_PAYLOAD_MAX_BYTES, VIEW_RESULT_ECHO_MAX_BYTES, VIEW_TOOL, VIEW_TOOL_NAME, clampViewHeight, echoViewResult, foldViews,
  normaliseLiveDomain, readShowView, readViewResult, showViewRefusal, showViewShape, viewDataFormat, viewIdOf,
  viewResultText, type ShowViewCheck, type ShowViewInput, type ViewCall, type ViewPayload, type ViewResult,
} from '@orbital/shared/views';
import type { PendingDecision, Runner, SessionTools } from '../runner/runner.js';
import { liveBranch } from '../transcript/liveBranch.js';
import { parseTranscript, type TranscriptEntry } from '../transcript/parser.js';
import { StampedCache, fileStamp } from '../transcript/stampedCache.js';
import { expandHome } from '../paths.js';
import type { ChatMessage } from '../types.js';

/** Where the views' files live under the data directory. */
export const VIEWS_DIR = 'views';

/**
 * A session id or a tool_use id as a file name: the alphabet both are written
 * in. Anything else names no file here, so no request can climb out of the
 * views directory.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The key the CLI puts a tool call's tool_use id under in the MCP request's `_meta`. */
const TOOL_USE_ID_META = 'claudecode/toolUseId';

/**
 * What a payload carries beside its page, its inline data and its result —
 * ids, title, domains, CDN hosts — kept free of `VIEW_PAYLOAD_MAX_BYTES`
 * when a call is checked. The result has room of its own: the payload echoes
 * at most `VIEW_RESULT_ECHO_MAX_BYTES` of it.
 */
const PAYLOAD_METADATA_BYTES = 16 * 1024;

/** A value's size serialised, in UTF-8 bytes. */
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '');
}

/**
 * Why a page is too large for its payload, or null when it fits: the compiled
 * script or the html, with the inline `data`, measured as the payload carries
 * them, against `VIEW_PAYLOAD_MAX_BYTES` less the room metadata and the
 * echoed result need. A `dataFile` is not counted: it rides outside when it does not fit.
 */
export function viewPageTooLarge(page: { script?: string; html?: string; data?: unknown }): string | null {
  const room = VIEW_PAYLOAD_MAX_BYTES - PAYLOAD_METADATA_BYTES - VIEW_RESULT_ECHO_MAX_BYTES;
  const bytes = jsonBytes({ script: page.script, html: page.html, data: page.data });
  if (bytes <= room) return null;
  return (
    `The view comes to ${bytes} bytes${page.script !== undefined ? ' compiled' : ''} with its inline data; the most is ${room}. ` +
    `Write the data to a .json or .csv file and pass it as \`dataFile\`, and keep the page smaller. ${RETRY}`
  );
}

/** Transcripts whose calls are kept read, by path and stamp. */
const TRANSCRIPT_ENTRIES = 64;
/** Calls kept in memory per session; past it the oldest go — the transcript holds them by then. */
const MEMORY_CALLS = 32;

const RETRY = `Nothing was shown; fix it and call ${VIEW_TOOL_NAME} again.`;

/** Answered to every call once the Labs switch is off. */
export const VIEWS_OFF_REFUSAL = 'Views are turned off in Orbital (Settings → Labs). Show the result another way.';
/** Answered to a subagent's call: a waiting view could never be answered. */
export const SUBAGENT_REFUSAL = `${VIEW_TOOL_NAME} is for the main session only. Report back, and let the main session show the view.`;

const DESCRIPTION = [
  'Show the user a view in the Orbital transcript: a small page you write for one purpose — a chart, a table to filter, a picker or form quicker to use than to describe. Use it when seeing beats reading.',
  'The usual way is `component`: a React component in TSX whose default export is the view and which receives the data as its `data` prop. React is provided. Style it with Tailwind classes, which carry Orbital\'s own colours: ' +
    `bg-<token>, text-<token>, border-<token> for the tokens ${TOKENS.join(', ')}. ` +
    'Import other packages by name (import { LineChart } from \'recharts\'); they load from esm.sh.',
  '`html` is for what needs no React — a plain SVG, a canvas: one page with its CSS and JS inline, already styled in the user\'s colours. ' +
    `Its CSS can use the variables ${TOKENS.map((t) => `--color-${t}`).join(', ')}, --font-sans, --font-mono and --text-scale.`,
  `Scripts and stylesheets may load only from ${VIEW_BUILTIN_CDN_HOSTS.join(', ')} and hosts the user added. The page has no network otherwise.`,
  'Inside the page, `orbital.data` is the data passed with the call, `orbital.onTheme(fn)` is told when the user\'s colours change, and `orbital.send(value)` sends a JSON value back — only from a user gesture (a click, a submit); a call outside one is dropped.',
  'Pass the data with the call (`data`, or `dataFile` for anything large); never fetch it. Use `liveDomains` only when the data must be live.',
  'While you iterate on a view, update it with `replaces` and its id; make a new view only when the user asks for one.',
  'With `wait`, the call returns only when the user sends from the view or answers in words. Only one view may wait at a time.',
].join(' ');

/** What the tool answers a call with. */
interface CallToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** One call of the tool as the transcript or this process knows it. */
export interface ViewCallRecord extends ViewCall {
  /** The text of its tool_result, when one was written. */
  resultText?: string;
}

/** A tool_result's content as text. */
function resultTextOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) => {
      const { type, text } = (part ?? {}) as { type?: unknown; text?: unknown };
      return type === 'text' && typeof text === 'string' ? text : '';
    })
    .join('');
}

/**
 * The tool's calls in a transcript's live branch, in order, each with its
 * result once written. A subagent's entries do not count: it is refused the
 * tool.
 */
export function viewCallsOf(entries: readonly TranscriptEntry[]): ViewCallRecord[] {
  const calls: ViewCallRecord[] = [];
  const byId = new Map<string, ViewCallRecord>();
  for (const entry of liveBranch(entries)) {
    if (entry.isSidechain === true) continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (entry.type === 'assistant' && block.type === 'tool_use' && block.name === VIEW_TOOL && typeof block.id === 'string') {
        const call: ViewCallRecord = { toolUseId: block.id, input: block.input };
        calls.push(call);
        byId.set(block.id, call);
      } else if (entry.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const call = byId.get(block.tool_use_id);
        if (!call) continue;
        call.resultText = resultTextOf(block.content);
        if (block.is_error === true) call.isError = true;
      }
    }
  }
  return calls;
}

/** The same calls, out of the messages the transcript panel shows (`ChatMessage`), with the message each was made in. */
function viewCallsOfMessages(messages: readonly ChatMessage[]): Array<ViewCallRecord & { message: ChatMessage }> {
  const calls: Array<ViewCallRecord & { message: ChatMessage }> = [];
  const byId = new Map<string, ViewCallRecord>();
  for (const m of messages) {
    if (m.role === 'tool_use' && m.toolName === VIEW_TOOL && m.toolUseId) {
      const call = { toolUseId: m.toolUseId, input: m.toolInput, message: m };
      calls.push(call);
      byId.set(m.toolUseId, call);
    } else if (m.role === 'tool_result' && m.toolUseId) {
      const call = byId.get(m.toolUseId);
      if (call && m.isError === true) call.isError = true;
    }
  }
  return calls;
}

/**
 * A session's views as media items (spec § Media), one per view however often
 * it was updated, at the newest call: its message and time, its title. Only
 * for a client that says it reads them (`?views=1`).
 */
export function viewMediaItems(messages: readonly ChatMessage[]): MediaItem[] {
  const calls = viewCallsOfMessages(messages);
  if (calls.length === 0) return [];
  const fold = foldViews(calls);
  const byId = new Map(calls.map((c) => [c.toolUseId, c]));
  const items: MediaItem[] = [];
  for (const [viewId, toolUseId] of fold.latest) {
    const call = byId.get(toolUseId);
    const input = call ? readShowView(call.input) : null;
    if (!call || !input) continue;
    items.push({
      id: viewMediaId(viewId),
      kind: 'view',
      source: 'view',
      messageId: call.message.id,
      ts: call.message.timestamp ?? '',
      view: { id: viewId, toolUseId, title: input.title.trim() },
    });
  }
  // In the order their newest calls were made, as every other list is.
  const order = new Map(calls.map((c, i) => [c.toolUseId, i]));
  return items.sort((a, b) => (order.get(a.view!.toolUseId) ?? 0) - (order.get(b.view!.toolUseId) ?? 0));
}

/** JSON with its object keys sorted, so two spellings of one input compare equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );
}

/** A compiled component, or why it did not compile. */
export type CompiledView = { ok: true; script: string } | { ok: false; error: string };

/**
 * A view's component compiled to an ES module (spec § React and Tailwind):
 * types and JSX out, the automatic runtime's `react/jsx-runtime` import in,
 * every other import left as written for the page's import map. A syntax
 * error comes back with its line and column and the line itself, so the
 * agent can fix it.
 */
export function compileViewComponent(source: string): CompiledView {
  if (!/\bexport\s+default\b|\bas\s+default\b/.test(source)) {
    return { ok: false, error: 'The component has no default export: export the view as `export default function View({ data }) { … }`.' };
  }
  try {
    const { code } = transform(source, { transforms: ['typescript', 'jsx'], jsxRuntime: 'automatic', production: true });
    return { ok: true, script: code };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const loc = (err as { loc?: { line?: unknown; column?: unknown } }).loc;
    const line = typeof loc?.line === 'number' ? loc.line : null;
    const column = typeof loc?.column === 'number' ? loc.column : null;
    if (line === null) return { ok: false, error: `The component does not compile: ${message}` };
    const text = source.split('\n')[line - 1] ?? '';
    return {
      ok: false,
      error: `The component does not compile at line ${line}${column !== null ? `, column ${column + 1}` : ''}: ${message}\n    ${text.trim().slice(0, 200)}`,
    };
  }
}

/** The directory a session's view files are kept in, or null for an id that names no file. */
export function viewSessionDir(dataDir: string, sessionId: string): string | null {
  return SAFE_ID.test(sessionId) ? join(dataDir, VIEWS_DIR, sessionId) : null;
}

/** A call's data copy on disk and its format, or null for none (or an id that names no file). */
export function viewDataCopy(dataDir: string, sessionId: string, toolUseId: string): { path: string; format: 'json' | 'csv' } | null {
  const dir = viewSessionDir(dataDir, sessionId);
  if (!dir || !SAFE_ID.test(toolUseId)) return null;
  for (const format of ['json', 'csv'] as const) {
    const path = join(dir, `${toolUseId}.${format}`);
    if (existsSync(path)) return { path, format };
  }
  return null;
}

/** Media types of a data copy, by its format. */
export const VIEW_DATA_MEDIA_TYPES = { json: 'application/json; charset=utf-8', csv: 'text/csv; charset=utf-8' } as const;

/** Every view file of these sessions removed: the retention sweep took their rows. */
export function removeViewFiles(dataDir: string, sessionIds: readonly string[]): void {
  for (const id of sessionIds) {
    const dir = viewSessionDir(dataDir, id);
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/** A call this process accepted, kept until the transcript holds it. */
interface MemoryCall {
  input: ShowViewInput;
  /** The call's result once it has one; null while it waits. */
  result: ViewResult | null;
}

export interface ViewsDeps {
  /** The `VIEWS_ENABLED_KEY` setting, read at the point of use. */
  isEnabled(): boolean;
  dataDir: string;
  /** The session's main transcript, or null without a row. */
  transcriptPathOf(sessionId: string): string | null;
  /** The directory a relative `dataFile` resolves against: where the session works now. */
  cwdOf(sessionId: string): string | null;
  /** The runner that parks a waiting view; late-bound, built after this. */
  runner(): Pick<Runner, 'parkView' | 'pendingDecision'>;
}

/** What the payload adds from outside the call: the session's approvals and the Mac's CDN list. */
export interface PayloadExtras {
  approvedDomains: readonly string[];
  cdnHosts: readonly string[];
}

export class ViewsService {
  /** Calls accepted here, per session, by tool_use id, in the order they were made. */
  private memory = new Map<string, Map<string, MemoryCall>>();
  /** Calls the `PreToolUse` hook saw, by their input, for a CLI that sends no tool_use id with the call. */
  private seen = new Map<string, Array<{ key: string; toolUseId: string }>>();
  private transcripts = new StampedCache<ViewCallRecord[]>(TRANSCRIPT_ENTRIES);

  constructor(private readonly deps: ViewsDeps) {}

  /**
   * What a starting session gets while the Labs switch is on: the tool, its
   * card skipped, and the hook that refuses it to subagents. Nothing while
   * it is off: the tool is given at start, and the handler refuses a call
   * made after the switch was turned off since.
   */
  sessionTools(sessionId: string): SessionTools | undefined {
    if (!this.deps.isEnabled()) return undefined;
    return {
      tools: [this.showTool(sessionId)],
      allowedTools: [VIEW_TOOL],
      preToolUse: [{ matcher: VIEW_TOOL, hooks: [(input: HookInput) => this.preToolUse(sessionId, input)] }],
    };
  }

  /**
   * Refuses a subagent's call, and notes the main session's tool_use id
   * against its input, for a CLI that does not send the id with the call.
   */
  private preToolUse(sessionId: string, input: HookInput): Promise<HookJSONOutput> {
    if (input.hook_event_name !== 'PreToolUse') return Promise.resolve({});
    if (input.agent_id) {
      return Promise.resolve({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: SUBAGENT_REFUSAL },
      });
    }
    const list = this.seen.get(sessionId) ?? [];
    list.push({ key: canonical(input.tool_input), toolUseId: input.tool_use_id });
    if (list.length > MEMORY_CALLS) list.shift();
    this.seen.set(sessionId, list);
    return Promise.resolve({});
  }

  /** The call's tool_use id: from the request's `_meta`, else the hook's note of the same input. */
  private toolUseIdOf(sessionId: string, args: unknown, extra: unknown): string | null {
    const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta;
    const fromMeta = meta?.[TOOL_USE_ID_META];
    const list = this.seen.get(sessionId);
    if (typeof fromMeta === 'string' && fromMeta !== '') {
      const at = list?.findIndex((s) => s.toolUseId === fromMeta) ?? -1;
      if (at >= 0) list!.splice(at, 1);
      return fromMeta;
    }
    const key = canonical(args);
    const at = list?.findIndex((s) => s.key === key) ?? -1;
    if (at < 0) return null;
    return list!.splice(at, 1)[0].toolUseId;
  }

  private showTool(sessionId: string) {
    return tool(
      VIEW_TOOL_NAME,
      DESCRIPTION,
      showViewShape,
      (args, extra) => this.show(sessionId, args, extra),
      // Deferred behind ToolSearch, the agent would have to go looking for it first.
      { alwaysLoad: true },
    );
  }

  /** The session's calls as the transcript has them, then the ones it has not written yet. */
  calls(sessionId: string): ViewCallRecord[] {
    const path = this.deps.transcriptPathOf(sessionId);
    const stamp = path ? fileStamp(path) : null;
    const written = path && stamp
      ? this.transcripts.get(path, stamp, () => {
          let text: string;
          try {
            text = readFileSync(path, 'utf8');
          } catch {
            return [];
          }
          return text.includes(VIEW_TOOL) ? viewCallsOf(parseTranscript(text)) : [];
        })
      : [];
    const memory = this.memory.get(sessionId);
    if (!memory || memory.size === 0) return written;
    const known = new Set(written.map((c) => c.toolUseId));
    const pending: ViewCallRecord[] = [];
    for (const [toolUseId, call] of memory) if (!known.has(toolUseId)) pending.push({ toolUseId, input: call.input });
    return pending.length > 0 ? [...written, ...pending] : written;
  }

  private remember(sessionId: string, toolUseId: string, call: MemoryCall): void {
    let calls = this.memory.get(sessionId);
    if (!calls) this.memory.set(sessionId, (calls = new Map()));
    calls.set(toolUseId, call);
    while (calls.size > MEMORY_CALLS) calls.delete(calls.keys().next().value as string);
  }

  /** The waiting view's decision on this session, or null. */
  private waitingDecision(sessionId: string): PendingDecision | null {
    const pending = this.deps.runner().pendingDecision(sessionId);
    return pending?.kind === 'view' ? pending : null;
  }

  /** One call, from refusal to result. */
  async show(sessionId: string, args: unknown, extra: unknown): Promise<CallToolResult> {
    const refuse = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });
    const toolUseId = this.toolUseIdOf(sessionId, args, extra);
    if (!this.deps.isEnabled()) return refuse(VIEWS_OFF_REFUSAL);
    if (!toolUseId || !SAFE_ID.test(toolUseId)) return refuse(`Orbital could not tell this call apart. ${RETRY}`);
    const raw = (args ?? {}) as ShowViewInput;

    // The data file, read where the session works.
    const check: ShowViewCheck = {};
    let dataPath: string | null = null;
    if (typeof raw.dataFile === 'string' && raw.dataFile.trim() !== '') {
      const named = expandHome(raw.dataFile.trim());
      const cwd = this.deps.cwdOf(sessionId);
      dataPath = isAbsolute(named) ? named : cwd ? resolve(cwd, named) : null;
      check.dataFileBytes = null;
      if (dataPath) {
        try {
          const st = statSync(dataPath);
          if (st.isFile()) check.dataFileBytes = st.size;
        } catch {
          // Unreadable: `dataFileBytes` stays null and the call is refused for it.
        }
      }
    }
    const refusal = showViewRefusal(raw, check);
    if (refusal) return refuse(refusal);
    const input = readShowView(raw);
    if (!input) return refuse(`The call could not be read. ${RETRY}`);

    // What the session knows: the view `replaces` names, and the one waiting.
    const waiting = this.waitingDecision(sessionId);
    let viewId = toolUseId;
    if (input.replaces !== undefined) {
      const fold = foldViews(this.calls(sessionId));
      const known = fold.viewOf.get(input.replaces);
      if (known === undefined) {
        return refuse(`This session has no view ${input.replaces} to replace. Use the id a ${VIEW_TOOL_NAME} result named, or leave out \`replaces\` for a new view. ${RETRY}`);
      }
      viewId = known;
      if (waiting && (waiting.input as { viewId?: unknown }).viewId === viewId) {
        return refuse(`View ${viewId} is waiting for the user and cannot be updated until they answer it.`);
      }
    }
    if (input.wait === true && waiting) {
      return refuse(`Another view is waiting for the user; only one view may wait at a time. Show this one without \`wait\`, or wait for the user's answer first.`);
    }

    // The component compiled, the data copied: nothing is written before every check has passed.
    let script: string | null = null;
    if (input.component !== undefined) {
      const compiled = compileViewComponent(input.component);
      if (!compiled.ok) return refuse(`${compiled.error}\n${RETRY}`);
      script = compiled.script;
    }
    // The payload has to fit one relay frame for the phone (spec § Phone).
    const tooLarge = viewPageTooLarge({ ...(script !== null ? { script } : { html: input.html }), data: input.data });
    if (tooLarge) return refuse(tooLarge);
    let dataText: string | null = null;
    const format = dataPath ? viewDataFormat(dataPath) : null;
    if (dataPath && format === 'json') {
      try {
        dataText = readFileSync(dataPath, 'utf8');
        JSON.parse(dataText);
      } catch (err) {
        return refuse(`\`dataFile\` ${input.dataFile} is not valid JSON: ${err instanceof Error ? err.message : String(err)}. ${RETRY}`);
      }
    }
    const dir = viewSessionDir(this.deps.dataDir, sessionId);
    if ((script !== null || dataPath) && !dir) return refuse(`Orbital could not store this view. ${RETRY}`);
    try {
      if (dir) mkdirSync(dir, { recursive: true });
      if (script !== null) writeFileSync(join(dir!, `${toolUseId}.js`), script);
      if (dataPath && format) {
        const copy = join(dir!, `${toolUseId}.${format}`);
        if (dataText !== null) writeFileSync(copy, dataText);
        else copyFileSync(dataPath, copy);
      }
    } catch (err) {
      return refuse(`Orbital could not store this view: ${err instanceof Error ? err.message : String(err)}. ${RETRY}`);
    }

    const call: MemoryCall = { input, result: null };
    this.remember(sessionId, toolUseId, call);
    if (input.wait !== true) {
      call.result = { viewId, outcome: 'shown' };
      return { content: [{ type: 'text', text: viewResultText(call.result) }] };
    }
    const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
    call.result = await this.deps.runner().parkView(sessionId, toolUseId, { viewId, title: input.title.trim() }, signal);
    return { content: [{ type: 'text', text: viewResultText(call.result) }] };
  }

  /** A compiled script: kept on disk, compiled again from the call when the file is gone. */
  private scriptOf(sessionId: string, toolUseId: string, component: string): string | null {
    const dir = viewSessionDir(this.deps.dataDir, sessionId);
    if (!dir || !SAFE_ID.test(toolUseId)) return null;
    const path = join(dir, `${toolUseId}.js`);
    try {
      return readFileSync(path, 'utf8');
    } catch {
      // Gone (deleted, or a call from before this data directory): compiled again below.
    }
    const compiled = compileViewComponent(component);
    if (!compiled.ok) return null;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, compiled.script);
    } catch {
      // Served from memory this time; compiled again next time.
    }
    return compiled.script;
  }

  /**
   * What a client needs to draw the view at this call, or null when the call
   * is not a shown `show_view` call of this session — refused, another
   * session's, or none at all.
   */
  payload(sessionId: string, toolUseId: string, extras: PayloadExtras): ViewPayload | null {
    const calls = this.calls(sessionId);
    const record = calls.find((c) => c.toolUseId === toolUseId);
    if (!record || record.isError === true) return null;
    const input = readShowView(record.input);
    if (!input) return null;
    const fold = foldViews(calls);
    const viewId = fold.viewOf.get(toolUseId) ?? viewIdOf(input, toolUseId);

    let script: string | undefined;
    if (input.component !== undefined) {
      const compiled = this.scriptOf(sessionId, toolUseId, input.component);
      if (compiled === null) return null;
      script = compiled;
    }

    const liveDomains = [...new Set((input.liveDomains ?? []).map(normaliseLiveDomain).filter((d): d is string => d !== null))];
    const approved = new Set(extras.approvedDomains);
    const pending = this.waitingDecision(sessionId);
    const waiting = pending?.id === toolUseId;
    const memory = this.memory.get(sessionId)?.get(toolUseId);
    const full = waiting
      ? null
      : (record.resultText !== undefined ? readViewResult(record.resultText) : null) ?? memory?.result ?? null;
    // What the user sent or typed may be far larger than a relay frame holds;
    // the agent got all of it, a client shows a line.
    const result = full ? echoViewResult(full) : null;

    const payload: ViewPayload = {
      viewId,
      toolUseId,
      title: input.title.trim(),
      kind: input.component !== undefined ? 'react' : 'html',
      ...(script !== undefined ? { script } : { html: input.html ?? '' }),
      height: clampViewHeight(input.height),
      wait: input.wait === true,
      liveDomains,
      data: this.dataOf(sessionId, toolUseId, input),
      approvedDomains: liveDomains.filter((d) => approved.has(d)),
      cdnHosts: [...new Set([...VIEW_BUILTIN_CDN_HOSTS, ...extras.cdnHosts])],
      waiting,
      result,
    };
    // A data copy rides inside only while the whole payload fits one relay
    // frame; past it, the client fetches it on its own.
    const data = payload.data;
    if (data && data.format !== 'inline' && data.inline && jsonBytes(payload) > VIEW_PAYLOAD_MAX_BYTES) {
      payload.data = { format: data.format, bytes: data.bytes, inline: false };
    }
    return payload;
  }

  /** The payload's data: inline as the call gave it, or the copy — inline when small, fetched on its own when not. */
  private dataOf(sessionId: string, toolUseId: string, input: ShowViewInput): ViewPayload['data'] {
    if (input.data !== undefined) {
      return { format: 'inline', bytes: Buffer.byteLength(JSON.stringify(input.data) ?? ''), value: input.data, inline: true };
    }
    if (input.dataFile === undefined) return null;
    const copy = viewDataCopy(this.deps.dataDir, sessionId, toolUseId);
    if (!copy) return null;
    let bytes: number;
    try {
      bytes = statSync(copy.path).size;
    } catch {
      return null;
    }
    if (bytes > VIEW_DATA_INLINE_REST_MAX) return { format: copy.format, bytes, inline: false };
    try {
      const text = readFileSync(copy.path, 'utf8');
      return copy.format === 'json'
        ? { format: 'json', bytes, value: JSON.parse(text) as unknown, inline: true }
        : { format: 'csv', bytes, text, inline: true };
    } catch {
      return null;
    }
  }

  /** The data copy of a shown call of this session, or null. */
  dataCopy(sessionId: string, toolUseId: string): { path: string; format: 'json' | 'csv' } | null {
    const record = this.calls(sessionId).find((c) => c.toolUseId === toolUseId);
    if (!record || record.isError === true) return null;
    return viewDataCopy(this.deps.dataDir, sessionId, toolUseId);
  }
}
