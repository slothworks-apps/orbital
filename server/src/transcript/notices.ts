import type { ChatMessage, NoticeLevel } from '../types.js';

/**
 * The CLI wraps a local command's own output in one of these before it writes
 * it anywhere — into the transcript file, and into the `local_command_source`
 * sibling on the synthetic assistant frame it streams. The tags are display
 * machinery, not content, so they come off before the text reaches a reader.
 *
 * `stderr` is the same wrapper with a different name, and it is the only thing
 * that distinguishes a command that failed from one that answered.
 */
const LOCAL_COMMAND_WRAPPER = /^<local-command-(stdout|stderr)>([\s\S]*?)(?:<\/local-command-\1>)?$/;

/**
 * A local command's output with the wrapper taken off, and which stream it
 * came from.
 *
 * A closing tag that is missing — the CLI omits it when the block runs to the
 * end of the message — is not an error: the opening tag alone is enough to
 * name the stream, and everything after it is the output.
 */
export function stripLocalCommandWrapper(content: string): {
  text: string;
  stream: 'stdout' | 'stderr' | null;
} {
  const match = LOCAL_COMMAND_WRAPPER.exec(content.trim());
  if (!match) return { text: content, stream: null };
  return { text: match[2], stream: match[1] as 'stdout' | 'stderr' };
}

/**
 * The SDK's `SDKInformationalMessage.level`, which is also the vocabulary
 * every other notice is mapped onto. A level the SDK has since added, or one
 * a garbled message carries, falls back to whatever the caller considers
 * ordinary for that kind of row rather than being passed through unchecked.
 */
const SDK_LEVELS: readonly string[] = ['info', 'notice', 'suggestion', 'warning'];

function levelOf(raw: unknown, fallback: NoticeLevel): NoticeLevel {
  return typeof raw === 'string' && SDK_LEVELS.includes(raw) ? (raw as NoticeLevel) : fallback;
}

/**
 * Builds the transcript row. `text` is trimmed of the surrounding blank lines
 * the CLI's own padding leaves behind, but never of interior whitespace — the
 * body is terminal output and its columns are load-bearing.
 */
function notice(
  id: string,
  text: string,
  level: NoticeLevel,
  command?: string | null,
): ChatMessage | null {
  const body = text.replace(/^\n+/, '').replace(/\s+$/, '');
  if (!body) return null;
  return {
    id,
    role: 'notice',
    text: body,
    notice: { level, ...(command ? { command } : {}) },
  };
}

/**
 * The command a local-command frame answered, as `/name`, or null.
 *
 * `local_command_run.command` carries the bare name (`context`, not
 * `/context`) and is absent when the CLI refused the command outright —
 * `/status` outside a terminal — so the slash is added here and a missing
 * field simply leaves the row unlabelled rather than inventing one.
 */
function commandNameOf(msg: Record<string, unknown>): string | null {
  const run = msg.local_command_run as { command?: unknown } | undefined;
  const name = run?.command;
  return typeof name === 'string' && name ? `/${name}` : null;
}

/** The text blocks of an SDK message's `message.content`, joined. */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { text: string } =>
      Boolean(b) && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string',
    )
    .map((b) => b.text)
    .join('\n');
}

/**
 * One SDK stream message as a transcript notice, or `null` when it is not one.
 *
 * Three shapes, all of them the CLI answering without the model:
 *
 * 1. A **synthetic assistant frame** carrying `local_command_source`. This is
 *    how `/context`, `/usage`, `/mcp`, `/agents`, `/status` and `/permissions`
 *    answer on the CLI Orbital ships against: `message.model` is the literal
 *    `<synthetic>`, `message.usage` is all zeros, and the answer sits in the
 *    text blocks. It must not reach the transcript as an assistant turn —
 *    `<synthetic>` is not a model, and a reload rebuilds the same output from
 *    the transcript file as a notice, so the two would disagree.
 * 2. `system`/`local_command_output`, the SDK's own type for the same thing.
 *    Nothing in the six commands above uses it today, but it is in the
 *    message union (the SDK names `/voice`) and it carried no handler at all.
 * 3. `system`/`informational`, the loop's text banner — hook feedback and
 *    status lines, which the SDK documents as transcript-only output.
 *
 * The `context_usage` and `usage_report` siblings that ride along on (1) are
 * deliberately not read: the SDK calls the text in `message.content` the
 * canonical form and the structured twins a convenience for clients that
 * render a card, which Orbital does not yet do
 * (`docs/domains/locally-answered-slash-commands.md`).
 */
export function noticeFromSdkMessage(msg: unknown, id: string): ChatMessage | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;

  if (m.type === 'assistant' && typeof m.local_command_source === 'string') {
    const message = m.message as { content?: unknown } | undefined;
    const fromBlocks = textOfContent(message?.content);
    const source = stripLocalCommandWrapper(m.local_command_source);
    // The text blocks first: they are the same string with the wrapper
    // already off. The wrapper is the fallback for a frame that carries the
    // output only there.
    return notice(
      id,
      fromBlocks || source.text,
      source.stream === 'stderr' ? 'warning' : 'notice',
      commandNameOf(m),
    );
  }

  if (m.type !== 'system') return null;

  if (m.subtype === 'local_command_output' && typeof m.content === 'string') {
    const source = stripLocalCommandWrapper(m.content);
    return notice(id, source.text, source.stream === 'stderr' ? 'warning' : 'notice', null);
  }

  if (m.subtype === 'informational' && typeof m.content === 'string') {
    return notice(id, m.content, levelOf(m.level, 'info'), null);
  }

  return null;
}

/** A slash command on a line of its own, which is all a command echo ever is. */
const BARE_COMMAND = /^\/[A-Za-z0-9][A-Za-z0-9:_-]*(?:\s.*)?$/;

/**
 * One transcript-file entry as a transcript row, or `null` when it is not one
 * Orbital shows.
 *
 * The file's name for these is `system`/`local_command` — not any of the SDK
 * stream's names — and one command writes up to two of them:
 *
 * - an **echo** whose content is the command line itself, unwrapped. It comes
 *   back as a `user` row, because that is what it records, and because it is
 *   the only trace of what was typed for the commands the CLI refuses before
 *   expanding them: `/status` and `/permissions` write no `<command-name>`
 *   user turn at all. The commands that do expand write no echo, so a reloaded
 *   transcript never shows the command twice.
 * - the **answer**, wrapped in `<local-command-stdout>` (or `-stderr`), which
 *   comes back as a notice — the same row the live stream produces for it.
 *
 * The entry's own `level` is not read. It is `info` on every local command the
 * CLI writes, and honouring it would style a reloaded answer differently from
 * the live one that said exactly the same thing.
 */
export function messageFromLocalCommandEntry(
  entry: { type: string; subtype?: unknown; content?: unknown; timestamp?: string },
  id: string,
): ChatMessage | null {
  if (entry.type !== 'system' || entry.subtype !== 'local_command') return null;
  if (typeof entry.content !== 'string') return null;
  const source = stripLocalCommandWrapper(entry.content);
  const stamp = entry.timestamp ? { timestamp: entry.timestamp } : {};

  if (source.stream === null) {
    const text = source.text.trim();
    // Anything unwrapped that is not a command line is the CLI saying
    // something of its own; it is still worth showing, just not as speech.
    if (!BARE_COMMAND.test(text)) {
      const row = notice(id, source.text, 'notice', null);
      return row ? { ...row, ...stamp } : null;
    }
    return { id, role: 'user', text, ...stamp };
  }

  const row = notice(id, source.text, source.stream === 'stderr' ? 'warning' : 'notice', null);
  return row ? { ...row, ...stamp } : null;
}
