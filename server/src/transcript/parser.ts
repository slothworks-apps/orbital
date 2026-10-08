import type { ChatMessage, ImageRefEntry } from '../types.js';
import type { ImageWriter } from '../images/store.js';
import { messageFromLocalCommandEntry } from './notices.js';
import { compactSummaryText, markFromTranscriptBoundary } from './compaction.js';
import { parseWalkthroughTag, walkthroughChipName, WALKTHROUGH_TAG } from '../walkthrough/tag.js';

export type { ImageWriter };

/**
 * The CLI's `message.usage`, as the transcripts write it. Every field is
 * optional: older entries omit the ephemeral split and the thinking detail,
 * and nothing about this format is contractual.
 */
export interface TranscriptUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  output_tokens_details?: { thinking_tokens?: number };
}

export interface TranscriptEntry {
  type: string;
  /** `system` entries only — `local_command`, `compact_boundary` and so on. */
  subtype?: string;
  /** `system` entries only: the line the CLI wrote, tags and all. */
  content?: string;
  uuid?: string;
  /** The entry this one follows on the chain; null at a root and at a `compact_boundary`. */
  parentUuid?: string | null;
  /** `compact_boundary` entries only: the entry the compaction continues from. */
  logicalParentUuid?: string | null;
  timestamp?: string;
  cwd?: string;
  isSidechain?: boolean;
  /**
   * The harness speaking in the user's role, not the human: a skill's body,
   * `<local-command-caveat>`, "Continue from where you left off.", a
   * cross-session notice, the `[Image: …]` notes a Read of an image or a
   * pasted image leaves behind. See `outsideConversation`.
   */
  isMeta?: boolean;
  /**
   * The user entry carrying a compaction's summary, right after its
   * `compact_boundary`. Not `isMeta`, so it has to be named to be kept out of
   * the conversation.
   */
  isCompactSummary?: boolean;
  /** `compact_boundary` entries only: trigger, token counts and duration. */
  compactMetadata?: Record<string, unknown>;
  /** Set on assistant entries; several entries of one API response share it. */
  requestId?: string;
  /** Set on the user entry carrying a tool_result — the payload stats measure. */
  toolUseResult?: unknown;
  message?: {
    role: string;
    model?: string;
    content: string | Array<Record<string, unknown>>;
    usage?: TranscriptUsage;
  };
}

/**
 * An entry that is not part of the conversation this session shows: a
 * subagent's (`isSidechain`) or the harness's own (`isMeta`). Both are left
 * out of the transcript and out of the metadata the index derives, so a
 * skill's body never becomes a session's title (domain
 * `what-the-transcript-parser-skips`).
 */
export function outsideConversation(e: TranscriptEntry): boolean {
  return e.isSidechain === true || e.isMeta === true;
}

export function parseTranscriptLine(line: string): TranscriptEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (typeof obj !== 'object' || obj === null || typeof obj.type !== 'string') return null;
    return obj as TranscriptEntry;
  } catch {
    return null;
  }
}

export function parseTranscript(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of text.split('\n')) {
    const e = parseTranscriptLine(line);
    if (e) entries.push(e);
  }
  return entries;
}

/**
 * A transcript field read as a name or an id. The format is undocumented and
 * can change under a CLI update, so a field that is not a string is treated as
 * absent — `String()` on it would put a literal `[object Object]` into a tool
 * name, which then travels all the way to the UI as if it were one.
 */
function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function textOf(content: string | Array<Record<string, unknown>>): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

// CLI transcripts wrap machine-generated user turns in tags like
// <local-command-caveat>, <command-message>, <system-reminder>. A closing tag
// may be missing when the block runs to the end of the message.
//
// `task-notification` is the CLI reporting on a background agent — including,
// on every resume, the ones a previous process left unfinished. Every revive
// is a resume, and a session that sleeps and wakes often collects them faster
// than anything the human types. Folded, not dropped: which agent died is
// worth keeping one click away.
const NOISE_BLOCK = /<(local-command-caveat|local-command-stdout|local-command-stderr|system-reminder|command-message|command-name|command-args|command-contents|task-notification|orbital-walkthrough)(?:\s[^>]*)?>[\s\S]*?(<\/\1>|$)/g;

/**
 * The command-expansion fold (spec: 2026-09-18-transcript-folding-design).
 * A user turn wrapped in the CLI's machine tags splits into what the human
 * actually typed (everything outside the tags, whitespace preserved, then
 * trimmed) and the machinery itself — name from `<command-name>` verbatim
 * including the slash, `body` the raw tag blocks joined in order (nothing
 * is thrown away; "expanded" in the UI renders this), `blocks` how many
 * there were (the "machine context ×3" chip label). No tags → no command.
 */
export function splitUserText(text: string): {
  text: string;
  command?: NonNullable<ChatMessage['command']>;
} {
  const matches = [...text.matchAll(NOISE_BLOCK)];
  if (matches.length === 0) return { text };
  const name = /<command-name>([^<\n]+)<\/command-name>/.exec(text)?.[1]?.trim() ?? null;
  // Only a top-level block is the turn's own tag. One quoted inside a
  // reminder or a command's contents (a pasted spec, a test file) was
  // swallowed whole by its enclosing match and is not found here.
  const own = matches.find((m) => m[1] === WALKTHROUGH_TAG);
  const tag = own ? parseWalkthroughTag(own[0]) : null;
  const chipName = name ?? (tag ? walkthroughChipName(tag) : null);
  return {
    // Plain removal + trim, NOT the title path's whitespace collapse — a
    // human paragraph with a reminder appended must keep its newlines.
    text: text.replace(NOISE_BLOCK, '').trim(),
    command: {
      name: chipName,
      body: matches.map((m) => m[0]).join('\n'),
      blocks: matches.length,
      ...(tag ? { walkthrough: tag } : {}),
    },
  };
}

/** Longest stored session title, ellipsis included. */
export const TITLE_MAX_CHARS = 120;

/**
 * Cap a derived title at TITLE_MAX_CHARS, breaking at a word boundary and
 * appending an ellipsis — so wherever the full stored title is shown (the
 * map label's hover expansion, the detail panel) the cut stays visible
 * instead of ending mid-word as if that were the whole prompt. A boundary
 * in the first half of the budget would keep a useless stub ("Look at…"
 * for a prompt that opens with a long URL), so those hard-cut mid-word
 * and let the ellipsis carry the message alone.
 */
export function truncateTitle(text: string): string {
  if (text.length <= TITLE_MAX_CHARS) return text;
  const slice = text.slice(0, TITLE_MAX_CHARS - 1);
  const boundary = slice.lastIndexOf(' ');
  const keep = boundary >= TITLE_MAX_CHARS / 2 ? slice.slice(0, boundary) : slice;
  return `${keep.trimEnd()}…`;
}

/**
 * What Orbital's composer puts in front of a prompt from the editor
 * (`promptWithSelection` / `promptWithOpenFile` in `web/src/lib/ideSelection.ts`
 * — the wording is a contract with those two, and moves with them): the
 * selection as a fenced block, or the CLI's sentence naming the open file.
 * Either is context for the model, never what the session is about.
 */
const IDE_SELECTION_BLOCK = /^Selected in the editor — @\S+ lines \d+–\d+:\n\n(`{3,})\n[\s\S]*?\n\1(?:\n|$)/;
const IDE_OPEN_FILE_LINE = /^The user opened the file .+? in the IDE\. This may or may not be related to the current task\.(?:\n|$)/;

/**
 * The list of attached files the composer appends after a prompt
 * (`promptWithFiles` in `web/src/lib/attachedFiles.ts` — a contract with it,
 * as the two above are with the IDE helpers). Paths, not what the session is
 * about.
 */
const ATTACHED_FILES_BLOCK = /(?:^|\n\n)Attached files:\n(?:- \/[^\n]*(?:\n|$))+$/;

export function cleanTitle(text: string): string {
  text = text
    .trimEnd()
    .replace(ATTACHED_FILES_BLOCK, '')
    .replace(IDE_SELECTION_BLOCK, '')
    .replace(IDE_OPEN_FILE_LINE, '');
  const commandName = /<command-name>([^<\n]+)<\/command-name>/.exec(text)?.[1]?.trim();
  const commandArgs = /<command-args>([^<\n]*)/.exec(text)?.[1]?.trim();
  const stripped = text.replace(NOISE_BLOCK, ' ').replace(/\s+/g, ' ').trim();
  if (stripped) return stripped;
  if (commandName) return commandArgs ? `${commandName} ${commandArgs}` : commandName;
  return '';
}

/**
 * A slash command with no arguments — `/clear`, `/login`, `/compact`. Sessions
 * very often open with one, and it says nothing about what the session is, so
 * it makes a useless title. A command WITH arguments (`/clickup-branch CU-123`)
 * does carry the subject, so only the bare form counts as noise here.
 */
export function isBareSlashCommand(text: string): boolean {
  return /^\/[A-Za-z0-9](?:[A-Za-z0-9:_-]*)$/.test(text);
}

export function extractMeta(entries: TranscriptEntry[]) {
  let cwd = '';
  let model: string | null = null;
  let title = '';
  /** First usable title seen, kept as a fallback if every turn is a bare command. */
  let fallbackTitle = '';
  let firstAt: number | null = null;
  let lastAt: number | null = null;
  let messageCount = 0;
  for (const e of entries) {
    if (!cwd && typeof e.cwd === 'string') cwd = e.cwd;
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    if (outsideConversation(e)) continue;
    if (e.type === 'assistant' && typeof e.message?.model === 'string' && e.message.model) {
      model = e.message.model;
    }
    messageCount++;
    const t = e.timestamp ? Date.parse(e.timestamp) : NaN;
    if (!Number.isNaN(t)) {
      if (firstAt === null) firstAt = t;
      lastAt = t;
    }
    if (!title && e.type === 'user' && e.message) {
      const text = truncateTitle(cleanTitle(textOf(e.message.content)));
      if (!text) continue;
      // Skip past a leading `/clear` (or any other bare command) to the first
      // turn that actually describes the work.
      if (isBareSlashCommand(text)) {
        if (!fallbackTitle) fallbackTitle = text;
        continue;
      }
      title = text;
    }
  }
  return { cwd, title: title || fallbackTitle, firstAt, lastAt, messageCount, model };
}

/**
 * Decode one transcript `image` block into the content-addressed store and
 * return its wire entry — or null (no store, or an unusable block), in
 * which case the block drops, which was the behaviour before images
 * existed on the wire at all (spec: 2026-09-18-transcript-images-design).
 */
export function imageRefOf(
  block: Record<string, unknown>,
  images?: ImageWriter,
): ImageRefEntry | null {
  if (!images) return null;
  const source = block.source as Record<string, unknown> | undefined;
  if (!source || source.type !== 'base64') return null;
  if (typeof source.media_type !== 'string' || typeof source.data !== 'string') return null;
  return images.put(source.media_type, source.data);
}

/**
 * A tool_result's `content` split for the wire: text blocks joined, image
 * blocks stored and turned into refs. `JSON.stringify` survives only as
 * the fallback for an array carrying neither — stringifying an image
 * block put megabytes of base64 into a `<pre>`, which is the bug this
 * exists to fix.
 */
export function toolResultParts(
  content: unknown,
  images?: ImageWriter,
): { text: string; images: ImageRefEntry[] } {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: JSON.stringify(content), images: [] };
  const texts: string[] = [];
  const refs: ImageRefEntry[] = [];
  let known = false;
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
      known = true;
    } else if (block?.type === 'image') {
      known = true;
      const entry = imageRefOf(block, images);
      if (entry) refs.push(entry);
    }
  }
  if (!known) return { text: JSON.stringify(content), images: [] };
  return { text: texts.join('\n'), images: refs };
}

export function entriesToMessages(entries: TranscriptEntry[], images?: ImageWriter): ChatMessage[] {
  const out: ChatMessage[] = [];
  // The newest compaction mark still waiting for its summary entry.
  let unsummarised: ChatMessage | null = null;
  for (const e of entries) {
    // The entry's uuid rides on every message it becomes: a rewind names its
    // target by it, and the messages API cuts and places dividers by it
    // (spec 2026-09-29-rewind-design § Ids). So does its `cwd`: a file link
    // in the message resolves against the directory it was written in (adr
    // a-file-link-resolves-against-the-cwd-it-was-written-in).
    const origin = {
      ...(typeof e.uuid === 'string' ? { uuid: e.uuid } : {}),
      ...(typeof e.cwd === 'string' && e.cwd ? { cwd: e.cwd } : {}),
    };
    // A compaction becomes its own mark, carrying the summary from the entry
    // that follows it — the same item the runner builds live (spec
    // 2026-09-28-context-compaction-design § Success).
    if (e.type === 'system' && e.subtype === 'compact_boundary' && e.isSidechain !== true) {
      unsummarised = {
        id: `${e.uuid}:0`, role: 'compaction', timestamp: e.timestamp, ...origin,
        compaction: markFromTranscriptBoundary(e),
      };
      out.push(unsummarised);
      continue;
    }
    // The summary is the harness speaking, not the human: the live path
    // drops the same frame, so it never becomes a user bubble on either.
    if (e.type === 'user' && e.isCompactSummary === true) {
      const summary = compactSummaryText(e.message?.content);
      if (unsummarised?.compaction && summary) unsummarised.compaction.summary = summary;
      unsummarised = null;
      continue;
    }
    // The CLI answers some slash commands by itself and writes the answer as
    // a `system`/`local_command` entry — never as a turn. Without this the
    // whole of `/context`, `/usage`, `/mcp` and friends survived only in the
    // live stream and vanished on reload, and a terminal session (which
    // Orbital only ever reads from the file) never showed them at all.
    if (e.type === 'system') {
      const row = messageFromLocalCommandEntry(e, `${e.uuid}:0`);
      if (row) out.push({ ...row, ...origin });
      continue;
    }
    if ((e.type !== 'user' && e.type !== 'assistant') || !e.message || outsideConversation(e)) continue;
    const base =
      e.type === 'assistant' && typeof e.message.model === 'string' && e.message.model
        ? { timestamp: e.timestamp, model: e.message.model, ...origin }
        : { timestamp: e.timestamp, ...origin };
    const content = e.message.content;
    if (typeof content === 'string') {
      if (e.type === 'user') {
        const split = splitUserText(content);
        out.push({
          id: `${e.uuid}:0`, role: 'user', text: split.text,
          ...(split.command ? { command: split.command } : {}), ...base,
        });
      } else {
        out.push({ id: `${e.uuid}:0`, role: e.type, text: content, ...base });
      }
      continue;
    }
    if (!Array.isArray(content)) continue;
    content.forEach((block, i) => {
      const id = `${e.uuid}:${i}`;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        if (e.type === 'user') {
          const split = splitUserText(block.text);
          out.push({
            id, role: 'user', text: split.text,
            ...(split.command ? { command: split.command } : {}), ...base,
          });
        } else {
          out.push({ id, role: 'assistant', text: block.text, ...base });
        }
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
        // Same field name and same empty-skip rule as the live path
        // (`sdkToChatMessages`) — a thinking block with only a signature
        // and no text is not a message on either path.
        out.push({ id, role: 'thinking', text: block.thinking, ...base });
      } else if (block.type === 'tool_use') {
        out.push({
          id, role: 'tool_use', toolName: stringField(block.name),
          toolInput: block.input, toolUseId: stringField(block.id), ...base,
        });
      } else if (block.type === 'tool_result') {
        const parts = toolResultParts(block.content, images);
        out.push({
          id, role: 'tool_result', toolUseId: stringField(block.tool_use_id),
          text: parts.text,
          ...(parts.images.length ? { images: parts.images } : {}),
          ...(block.is_error === true ? { isError: true } : {}),
          ...base,
        });
      } else if (block.type === 'image') {
        const entry = imageRefOf(block, images);
        // The loop's top guard narrowed e.type, but TS loses it in the
        // forEach closure.
        if (entry) out.push({ id, role: e.type as 'user' | 'assistant', images: [entry], ...base });
      }
    });
  }
  return out;
}
