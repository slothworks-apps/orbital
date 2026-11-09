/**
 * The progress list on the Mac (spec 2026-11-09-progress-list-design, adr
 * progress-list-has-its-own-tool-not-the-clis-tasks): the `progress_write`
 * tool a session started with a list is given, the rules that tool keeps,
 * and the figure `ApiSession.progress` carries. The list has no table: it is
 * the fold of the tool's successful calls in the session's main transcript
 * (`@orbital/shared/progress`), read once and then kept up to date by the
 * calls the tool itself accepts.
 */

import { readFileSync } from 'node:fs';
import { tool, type HookInput, type HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  PROGRESS_TOOL, applyProgressCall, progressFigure, readProgressCall, type ProgressCall, type ProgressItem,
} from '@orbital/shared/progress';
import type { SessionTools } from '../runner/runner.js';
import { liveBranch } from '../transcript/liveBranch.js';
import { parseTranscript, type TranscriptEntry } from '../transcript/parser.js';
import type { SessionRow } from '../types.js';

/** The Labs switch: off, no session is started with a list, and none started with one gets the tool. */
export const PROGRESS_LIST_ENABLED_KEY = 'progress_list_enabled';

/** The tool's own name on Orbital's MCP server; `PROGRESS_TOOL` is how the CLI writes it. */
const TOOL_NAME = 'progress_write';

/**
 * The CLI's own task tools, taken away from a session with a progress list so
 * the agent keeps one list, the one the user sees (adr
 * progress-list-has-its-own-tool-not-the-clis-tasks). `TodoWrite` is what
 * they replaced, gone already from a current CLI.
 */
export const CLI_TASK_TOOLS = ['TaskCreate', 'TaskUpdate', 'TodoWrite'] as const;

/** The appendix's sentence for a session with a progress list (spec § Turning it on). */
export const PROGRESS_LIST_INSTRUCTION =
  `For work of more than a few steps, write a progress list with ${TOOL_NAME} before you start and keep it ` +
  'up to date as you go; when you add or drop items, tell the user why in its reason.';

const DESCRIPTION = [
  'Write this session\'s progress list: the steps of the work you are doing and how far you have got, shown to the user.',
  'Send the whole list on every call, each item with its state; titles are matched by their exact text, so keep them unchanged.',
  'Write it before you start work of more than a few steps, and call again as items move from pending to in_progress to done.',
  'Adding or dropping items needs `reason`: one sentence the user reads. Never leave an item out: send it with state "dropped" and its own `reason`.',
  'For a new task in this session, set `new_list` and send the new list.',
].join(' ');

/** Answered to every call once a harness is attached (spec § Turning it on). */
export const FROZEN_REFUSAL = 'The progress list is frozen; the harness now leads. Follow the harness checklist instead.';

/** Answered to a subagent's call: its work belongs to the main session's list. */
export const SUBAGENT_REFUSAL =
  `${TOOL_NAME} is for the main session only; a subagent's work belongs to the main session's list. Report back instead.`;

const RETRY = `Nothing was written; fix it and call ${TOOL_NAME} again.`;

/** Quoted titles, for a refusal. */
function titles(names: string[]): string {
  return names.map((name) => `"${name}"`).join(', ');
}

/**
 * Why a call may not be written, or null when it may. `current` is the list
 * before it, null when the session has none; `frozen` is a harness attached.
 * The call is the tool's input as sent, before `readProgressCall` would
 * quietly drop what it cannot read.
 */
export function progressRefusal(current: ProgressItem[] | null, call: ProgressCall, frozen: boolean): string | null {
  if (frozen) return FROZEN_REFUSAL;
  if (call.items.length === 0) return `Send at least one item. ${RETRY}`;
  const blank = call.items.some((item) => item.title.trim() === '');
  if (blank) return `Every item needs a title. ${RETRY}`;
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const item of call.items) (seen.has(item.title) ? repeated : seen).add(item.title);
  if (repeated.size > 0) return `Each title may appear once; ${titles([...repeated])} appears more than once. ${RETRY}`;

  const fresh = current === null || call.new_list === true;
  const before = new Map((fresh ? [] : current).map((item) => [item.title, item]));
  const unexplained = call.items
    .filter((item) => item.state === 'dropped' && !item.reason?.trim())
    .filter((item) => !before.get(item.title)?.reason || before.get(item.title)?.state !== 'dropped')
    .map((item) => item.title);
  if (unexplained.length > 0) {
    return `A dropped item needs its own \`reason\`: ${titles(unexplained)}. ${RETRY}`;
  }
  if (fresh) return null;

  const left = current
    .filter((item) => item.state !== 'dropped' && !seen.has(item.title))
    .map((item) => item.title);
  if (left.length > 0) {
    return `Keep every item on the list: send ${titles(left)} with state "dropped" and a \`reason\` instead of leaving it out. A title that changed counts as a new item. ${RETRY}`;
  }
  const { change } = applyProgressCall(current, call);
  if (change.kind === 'changed' && !call.reason?.trim()) {
    const parts = [
      ...(change.added.length > 0 ? [`adds ${titles(change.added)}`] : []),
      ...(change.dropped.length > 0 ? [`drops ${titles(change.dropped.map((d) => d.title))}`] : []),
    ];
    return `This call ${parts.join(' and ')}. Say why in \`reason\`, one sentence the user reads. ${RETRY}`;
  }
  return null;
}

/** The content blocks of an entry's message, or none. */
function blocksOf(entry: TranscriptEntry): Record<string, unknown>[] {
  const content = entry.message?.content;
  return Array.isArray(content) ? content : [];
}

/**
 * The list a transcript's calls add up to, or null when no call was written.
 * Only the live branch counts, so a rewind takes its calls back with it; a
 * subagent's entries and a refused call (`is_error` on its result) do not,
 * and neither does a call whose result never landed.
 */
export function foldProgress(entries: readonly TranscriptEntry[]): ProgressItem[] | null {
  const calls = new Map<string, ProgressCall>();
  let items: ProgressItem[] | null = null;
  for (const entry of liveBranch(entries)) {
    if (entry.isSidechain === true) continue;
    for (const block of blocksOf(entry)) {
      if (entry.type === 'assistant' && block.type === 'tool_use' && block.name === PROGRESS_TOOL && typeof block.id === 'string') {
        const call = readProgressCall(block.input);
        if (call) calls.set(block.id, call);
      } else if (entry.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const call = calls.get(block.tool_use_id);
        if (!call) continue;
        calls.delete(block.tool_use_id);
        if (block.is_error !== true) items = applyProgressCall(items, call).items;
      }
    }
  }
  return items;
}

/** The list a transcript file adds up to; a file that never names the tool is not parsed. */
export function readProgress(path: string): ProgressItem[] | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  return text.includes(PROGRESS_TOOL) ? foldProgress(parseTranscript(text)) : null;
}

/** `ApiSession.progress`: the figure, and whether a harness has taken the list's place. */
export interface ProgressFigure {
  done: number;
  total: number;
  frozen: boolean;
}

export interface ProgressDeps {
  /** The `PROGRESS_LIST_ENABLED_KEY` setting, read at the point of use. */
  isEnabled(): boolean;
  /** A live harness is attached to the session. */
  harnessAttached(sessionId: string): boolean;
  /** The session's main transcript, or null without a row. */
  transcriptPathOf(sessionId: string): string | null;
  /** The list changed: the session's shape is published again. */
  onChange(sessionId: string): void;
}

export class ProgressService {
  /** Each session's list as last read or written; null for none written. */
  private lists = new Map<string, ProgressItem[] | null>();

  constructor(private readonly deps: ProgressDeps) {}

  /** The session's list, read from its transcript the first time it is asked for. */
  current(sessionId: string): ProgressItem[] | null {
    if (this.lists.has(sessionId)) return this.lists.get(sessionId)!;
    const path = this.deps.transcriptPathOf(sessionId);
    const items = path ? readProgress(path) : null;
    this.lists.set(sessionId, items);
    return items;
  }

  /** `ApiSession.progress` for a row: null for a session without a list, or before its first one. */
  figureOf(row: Pick<SessionRow, 'id' | 'progress_list'>): ProgressFigure | null {
    if (!row.progress_list) return null;
    const items = this.current(row.id);
    if (!items) return null;
    return { ...progressFigure(items), frozen: this.deps.harnessAttached(row.id) };
  }

  /**
   * What a starting session with a progress list gets: the tool, its card
   * skipped, the CLI's task tools taken away, and the hook that refuses the
   * tool to subagents. Nothing while the Labs switch is off, and no tool once
   * a harness leads the session. Asked at every start, so the list is read
   * again from the transcript: a rewind may have taken calls back.
   */
  sessionTools(sessionId: string, progressList: boolean): SessionTools | undefined {
    this.lists.delete(sessionId);
    if (!progressList || !this.deps.isEnabled()) return undefined;
    const disallowedTools = [...CLI_TASK_TOOLS];
    if (this.deps.harnessAttached(sessionId)) return { tools: [], allowedTools: [], disallowedTools };
    return {
      tools: [this.writeTool(sessionId)],
      allowedTools: [PROGRESS_TOOL],
      disallowedTools,
      preToolUse: [{ matcher: PROGRESS_TOOL, hooks: [refuseSubagents] }],
    };
  }

  /** Whether the session's appendix carries `PROGRESS_LIST_INSTRUCTION`: when it gets the tool. */
  instructs(sessionId: string, progressList: boolean): boolean {
    return progressList && this.deps.isEnabled() && !this.deps.harnessAttached(sessionId);
  }

  /** The answer to one call: refused with what to fix, or written. */
  write(sessionId: string, call: ProgressCall): { ok: boolean; text: string } {
    const current = this.current(sessionId);
    const refusal = progressRefusal(current, call, this.deps.harnessAttached(sessionId));
    if (refusal) return { ok: false, text: refusal };
    const read = readProgressCall(call);
    if (!read) return { ok: false, text: `The call could not be read. ${RETRY}` };
    const { items } = applyProgressCall(current, read);
    this.lists.set(sessionId, items);
    this.deps.onChange(sessionId);
    const { done, total } = progressFigure(items);
    return { ok: true, text: `Written: ${done} of ${total} done.` };
  }

  private writeTool(sessionId: string) {
    return tool(
      TOOL_NAME,
      DESCRIPTION,
      {
        items: z
          .array(z.object({
            title: z.string().describe('What the step is, short. Matched by its exact text across calls.'),
            state: z.enum(['pending', 'in_progress', 'done', 'dropped']),
            reason: z.string().optional().describe('Why the item was dropped; required for a dropped item.'),
          }))
          .describe('The whole list, in order, every item with its state.'),
        reason: z.string().optional().describe('One sentence for the user: why items were added or dropped. Required when they were.'),
        new_list: z.boolean().optional().describe('Start a new list for a new task in this session.'),
      },
      (args) => {
        const { ok, text } = this.write(sessionId, args);
        return Promise.resolve({ content: [{ type: 'text' as const, text }], ...(ok ? {} : { isError: true }) });
      },
      // Deferred behind ToolSearch, the agent would have to go looking for it first.
      { alwaysLoad: true },
    );
  }
}

/**
 * The tool is the main session's: a subagent sees it on the shared server,
 * so its calls are refused here, before the tool runs. A pass is `{}`, as in
 * `shellIntentHooks`.
 */
function refuseSubagents(input: HookInput): Promise<HookJSONOutput> {
  if (input.hook_event_name !== 'PreToolUse' || !input.agent_id) return Promise.resolve({});
  return Promise.resolve({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: SUBAGENT_REFUSAL },
  });
}

