import type { ChatMessage } from '../types.js';
import { SUBAGENT_TOOLS } from '../transcript/subagents.js';
import type { FileSummary, Gap, Step, StepCall, StepFate, TimelineEntry, Walkthrough } from './types.js';
import type { WalkthroughTag } from './tag.js';
import { parseNarration } from './narration.js';

/** Tools whose call is a change to a file. Mirrors `EDITING_TOOLS` in `web/src/lib/fileEdit.ts`. */
export const WRITING_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'NotebookEdit']);

/** The `Write` tool's creation sentence, as the CLI writes it (mirrors `writeOutcome` on the web). */
const WRITE_CREATED = /^File created successfully at:/;

type Segment =
  /** `machine`: nobody typed it — only an unnamed wrapping that is not a walkthrough tag (a task notification, a reminder). */
  | { kind: 'user'; message: ChatMessage; tag: WalkthroughTag | null; machine: boolean }
  | { kind: 'text'; message: ChatMessage; answers: boolean }
  | { kind: 'run'; calls: StepCall[] };

/**
 * Pass 1: the transcript as user turns, assistant texts and runs — a run being
 * a maximal sequence of tool_use/tool_result messages with no assistant text
 * between them (spec § Vocabulary). Results are joined to their call by
 * `toolUseId`; a result whose call is not in the open run is dropped.
 *
 * A user turn carrying a walkthrough tag keeps it, and the assistant texts
 * after it are marked as its answer. Read-only runs in between keep the answer
 * open, and so does a machine-only user turn; a run with a writing call, or
 * the next user turn someone typed, ends it. The tag is the parser's
 * `command.walkthrough` — read from a top-level block only, never re-scanned
 * out of the body, where a quoted tag would pass for the turn's own.
 */
function segment(messages: ChatMessage[], subagents: Map<string, ChatMessage[]>): Segment[] {
  const out: Segment[] = [];
  let run: StepCall[] | null = null;
  let answering = false;
  const close = () => {
    if (!run) return;
    out.push({ kind: 'run', calls: run });
    if (runWrites(run, subagents)) answering = false;
    run = null;
  };
  for (const m of messages) {
    if (m.role === 'tool_use') {
      run ??= [];
      run.push({ call: m, result: null });
    } else if (m.role === 'tool_result') {
      const owner = m.toolUseId && run?.find((c) => c.call.toolUseId === m.toolUseId && c.result === null);
      if (owner) owner.result = m;
    } else if (m.role === 'assistant') {
      close();
      if (m.text?.trim()) out.push({ kind: 'text', message: m, answers: answering });
    } else if (m.role === 'user') {
      close();
      const tag = m.command?.walkthrough ?? null;
      // A slash command is typed even when its text is empty; it carries a name.
      const machine = !tag && !!m.command && m.command.name === null && !m.text?.trim();
      if (!machine) answering = tag !== null;
      out.push({ kind: 'user', message: m, tag, machine });
    }
    // `notice` rows are the CLI talking to itself; not part of the story.
  }
  close();
  return out;
}

function inputString(input: unknown, key: string): string | null {
  if (!input || typeof input !== 'object') return null;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}

function pathOf(call: ChatMessage): string | null {
  return inputString(call.toolInput, 'file_path') ?? inputString(call.toolInput, 'notebook_path');
}

export function isWritingCall(m: ChatMessage, subagents: Map<string, ChatMessage[]>): boolean {
  if (!m.toolName) return false;
  if (WRITING_TOOLS.has(m.toolName)) return true;
  if (SUBAGENT_TOOLS.has(m.toolName) && m.toolUseId) {
    const own = subagents.get(m.toolUseId);
    return !!own && own.some((x) => x.role === 'tool_use' && !!x.toolName && WRITING_TOOLS.has(x.toolName));
  }
  return false;
}

/** Whether a run makes at least one step. */
function runWrites(calls: StepCall[], subagents: Map<string, ChatMessage[]>): boolean {
  return calls.some((c) => isWritingCall(c.call, subagents));
}

function millis(ts: string | undefined): number | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

/** From the earliest call to the latest result among `calls`; null when none carries a timestamp. */
function spanMs(calls: StepCall[]): number | null {
  let first: number | null = null;
  let last: number | null = null;
  for (const c of calls) {
    for (const t of [millis(c.call.timestamp), millis(c.result?.timestamp)]) {
      if (t === null) continue;
      first = first === null ? t : Math.min(first, t);
      last = last === null ? t : Math.max(last, t);
    }
  }
  return first !== null && last !== null ? last - first : null;
}

function isDispatch(call: ChatMessage): boolean {
  return !!call.toolName && SUBAGENT_TOOLS.has(call.toolName);
}

/**
 * A run's writing calls, split into the steps they make: the direct writes
 * together as one, each writing dispatch alone. Ordered by each group's
 * first call in the run.
 */
function groupWrites(calls: StepCall[], subagents: Map<string, ChatMessage[]>): StepCall[][] {
  const groups: StepCall[][] = [];
  let direct: StepCall[] | null = null;
  for (const c of calls) {
    if (!isWritingCall(c.call, subagents)) continue;
    if (isDispatch(c.call)) {
      groups.push([c]);
    } else if (direct) {
      direct.push(c);
    } else {
      direct = [c];
      groups.push(direct);
    }
  }
  return groups;
}

function emptyGap(): Gap {
  return { kind: 'gap', durationMs: null, folded: {}, subagents: [], said: '' };
}

function gapIsEmpty(g: Gap): boolean {
  return Object.keys(g.folded).length === 0 && g.subagents.length === 0 && g.said === '';
}

function subagentName(call: ChatMessage): string {
  return inputString(call.toolInput, 'description') ?? inputString(call.toolInput, 'prompt')?.split('\n')[0] ?? 'subagent';
}

/**
 * Pass 2: runs with a writing call become steps (`groupWrites` decides how
 * many); everything else between two steps accumulates into one gap. The
 * assistant text immediately before a run is the narration of every step it
 * produces and is NOT also said in the gap. A text answering a walkthrough
 * turn is neither. `stepSegment` maps every step id to the index of the run
 * it came from.
 */
function walk(
  segments: Segment[],
  subagents: Map<string, ChatMessage[]>,
): { steps: Step[]; timeline: TimelineEntry[]; stepSegment: Map<string, number> } {
  const steps: Step[] = [];
  const timeline: TimelineEntry[] = [];
  const stepSegment = new Map<string, number>();
  let gap = emptyGap();
  let gapStart: number | null = null;
  let gapEnd: number | null = null;
  const flushGap = () => {
    if (!gapIsEmpty(gap)) {
      gap.durationMs = gapStart !== null && gapEnd !== null ? Math.max(0, gapEnd - gapStart) : null;
      timeline.push(gap);
    }
    gap = emptyGap();
    gapStart = gapEnd = null;
  };
  const touch = (ts: string | undefined) => {
    const t = millis(ts);
    if (t === null) return;
    gapStart = gapStart === null ? t : Math.min(gapStart, t);
    gapEnd = gapEnd === null ? t : Math.max(gapEnd, t);
  };

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.kind === 'user') continue;
    if (seg.kind === 'text') {
      if (seg.answers) continue;
      const next = segments[i + 1];
      const opensStep = next?.kind === 'run' && runWrites(next.calls, subagents);
      if (!opensStep) {
        gap.said = gap.said ? `${gap.said}\n\n${seg.message.text!.trim()}` : seg.message.text!.trim();
        touch(seg.message.timestamp);
      }
      continue;
    }
    const groups = groupWrites(seg.calls, subagents);
    if (groups.length === 0) {
      for (const c of seg.calls) {
        if (isDispatch(c.call)) gap.subagents.push(subagentName(c.call));
        else if (c.call.toolName) gap.folded[c.call.toolName] = (gap.folded[c.call.toolName] ?? 0) + 1;
        touch(c.call.timestamp); touch(c.result?.timestamp);
      }
      continue;
    }
    flushGap();
    const prev = segments[i - 1];
    const narration = prev?.kind === 'text' && !prev.answers ? prev.message.text!.trim() : '';
    // The run's non-writing calls fold into the first step it produces, and
    // count towards that step's duration.
    const others = seg.calls.filter((c) => !isWritingCall(c.call, subagents));
    groups.forEach((writes, g) => {
      const first = writes[0].call;
      const folded: Record<string, number> = {};
      if (g === 0) {
        for (const c of others) {
          if (c.call.toolName) folded[c.call.toolName] = (folded[c.call.toolName] ?? 0) + 1;
        }
      }
      let subagent: Step['subagent'] = null;
      if (isDispatch(first) && first.toolUseId) {
        const own = buildWalkthrough(subagents.get(first.toolUseId) ?? [], new Map());
        // The agent's own reads fold into this step, not into the parent's gap.
        for (const entry of own.timeline) {
          if (entry.kind !== 'gap') continue;
          for (const [tool, n] of Object.entries(entry.folded)) folded[tool] = (folded[tool] ?? 0) + n;
        }
        subagent = { name: subagentName(first), prompt: inputString(first.toolInput, 'prompt') ?? '', steps: own.steps };
      }
      const step: Step = {
        id: first.toolUseId ?? first.id,
        ordinal: steps.length + 1,
        narration,
        calls: writes,
        folded,
        subagent,
        fate: [],
        questions: [],
        durationMs: spanMs(g === 0 ? [...writes, ...others] : writes),
      };
      steps.push(step);
      stepSegment.set(step.id, i);
      timeline.push({ kind: 'step', id: step.id });
    });
  }
  flushGap();
  return { steps, timeline, stepSegment };
}

/**
 * Every file-writing call a step made, attributed to the TOP-LEVEL step: a
 * dispatch step's writes are its sub-steps' calls, a direct step's its own.
 */
function writesOf(step: Step): Array<{ call: StepCall; step: Step }> {
  if (step.subagent) {
    return step.subagent.steps.flatMap((s) => s.calls.map((call) => ({ call, step })));
  }
  return step.calls.map((call) => ({ call, step }));
}

/**
 * Blind alleys (spec § Blind alleys): what later steps did to this step's
 * work on the same path. Only Edit and Write are compared; a step never
 * compares with itself; a match is recorded once per later step and path.
 * A failed call changed nothing, so it takes no part on either side.
 */
function assignFate(steps: Step[]): void {
  const all = steps.flatMap(writesOf).filter((w) => !w.call.result?.isError);
  for (let i = 0; i < all.length; i++) {
    const a = all[i];
    const path = pathOf(a.call.call);
    if (!path) continue;
    const aOld = inputString(a.call.call.toolInput, 'old_string');
    const aNew = a.call.call.toolName === 'Write'
      ? inputString(a.call.call.toolInput, 'content')
      : inputString(a.call.call.toolInput, 'new_string');
    if (aNew === null) continue;
    for (let j = i + 1; j < all.length; j++) {
      const b = all[j];
      if (b.step === a.step || pathOf(b.call.call) !== path) continue;
      // Once per later step and path, across all of this step's calls on it.
      if (a.step.fate.some((f) => f.byStep === b.step.id && f.path === path)) continue;
      let kind: StepFate['kind'] | null = null;
      if (b.call.call.toolName === 'Edit') {
        const bOld = inputString(b.call.call.toolInput, 'old_string') ?? '';
        const bNew = inputString(b.call.call.toolInput, 'new_string') ?? '';
        if (aOld !== null && aOld !== '' && bNew === aOld) kind = 'reverted';
        else if (aNew !== '' && (bOld.includes(aNew) || aNew.includes(bOld)) && bOld !== '') kind = 'revised';
      } else if (b.call.call.toolName === 'Write') {
        const content = inputString(b.call.call.toolInput, 'content') ?? '';
        kind = aOld !== null && aOld !== '' && content === aOld ? 'reverted' : 'revised';
      }
      if (!kind) continue;
      a.step.fate.push({ kind, byStep: b.step.id, path });
    }
  }
}

function summarizeFiles(steps: Step[]): FileSummary[] {
  const byPath = new Map<string, FileSummary>();
  for (const { call, step } of steps.flatMap(writesOf)) {
    const path = pathOf(call.call);
    if (!path) continue;
    let f = byPath.get(path);
    if (!f) {
      f = { path, steps: [], created: false, fate: null, notApplied: false };
      byPath.set(path, f);
      if (call.call.toolName === 'Write' && call.result?.text && WRITE_CREATED.test(call.result.text)) f.created = true;
    }
    if (!f.steps.includes(step.id)) f.steps.push(step.id);
    // In transcript order: a failure is open until a later call on the path
    // succeeds — retrying a failed Edit is routine. A call with no result yet
    // changes nothing either way.
    if (call.result) f.notApplied = call.result.isError === true;
  }
  // The LAST fate on the path — what the close screen gathers.
  for (const step of steps) {
    for (const fate of step.fate) {
      const f = byPath.get(fate.path);
      if (f) f.fate = fate.kind;
    }
  }
  return [...byPath.values()];
}

/**
 * The assistant texts answering the tagged user turn at `i`: past read-only
 * runs and machine-only user turns, up to a run with a writing call or the
 * next typed user turn (the same window `segment()` marks). `open` when the
 * transcript ends inside the window — an answer may still come.
 */
function answerAfter(segs: Segment[], i: number, subagents: Map<string, ChatMessage[]>): { answer: string | null; open: boolean } {
  const parts: string[] = [];
  let open = true;
  for (let j = i + 1; j < segs.length; j++) {
    const s = segs[j];
    if (s.kind === 'user' && s.machine) continue;
    if (s.kind === 'user' || (s.kind === 'run' && runWrites(s.calls, subagents))) { open = false; break; }
    if (s.kind === 'text' && s.answers) parts.push(s.message.text!.trim());
  }
  return { answer: parts.length ? parts.join('\n\n') : null, open };
}

export function buildWalkthrough(messages: ChatMessage[], subagents: Map<string, ChatMessage[]>): Walkthrough {
  const segs = segment(messages, subagents);
  const { steps, timeline, stepSegment } = walk(segs, subagents);
  assignFate(steps);
  const stepById = new Map(steps.map((s) => [s.id, s]));
  let narration: Walkthrough['narration'] = null;
  let narrationFailed = false;
  let narrationPending = false;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg.kind !== 'user' || !seg.tag) continue;
    const { answer, open } = answerAfter(segs, i, subagents);
    if (seg.tag.kind === 'ask') {
      stepById.get(seg.tag.step)?.questions.push({ question: seg.message.text ?? '', answer, messageId: seg.message.id });
      continue;
    }
    // narrate — the last ANSWERED one wins, whatever became of the earlier
    // ones. A turn still waiting for its answer leaves the previous narration
    // standing and says it is pending; one whose window closed unanswered
    // (interrupted, superseded) changes nothing.
    if (answer === null) { narrationPending = open; continue; }
    narrationPending = false;
    const intents = parseNarration(answer, steps.map((s) => s.id));
    if (!intents) { narration = null; narrationFailed = true; continue; }
    const covered = steps.filter((s) => (stepSegment.get(s.id) ?? Infinity) < i).length;
    narration = { intents, staleSteps: steps.length - covered };
    narrationFailed = false;
  }
  return {
    steps,
    timeline,
    files: summarizeFiles(steps),
    narration,
    narrationFailed,
    narrationPending,
    lastMessageId: messages.length ? messages[messages.length - 1].id : null,
  };
}
