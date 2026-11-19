---
id: locally-answered-slash-commands
title: How a locally-answered slash command reaches the transcript
type: domain
status: in-force
domain: transcripts
related:
  - notice-rows-are-their-own-kind-of-turn
  - subagents-in-transcripts
  - command-completion-is-not-anchored-to-position-0
tags:
  - slash-commands
  - transcripts
  - sdk
---

# How a locally-answered slash command reaches the transcript

Measured against Claude Code **2.1.278** / `@anthropic-ai/claude-agent-sdk`
**0.3.278** on 2026-09-23, by driving the real `query()` with each command and
dumping every message it emitted, then reading the `.jsonl` the same run left
behind.

Some slash commands never reach the model. The CLI answers them itself, out
of state it already holds, and the answer arrives on a path that has nothing
to do with an assistant turn. Six were measured: `/context`, `/usage`,
`/mcp`, `/agents`, `/status`, `/permissions`.

## On the SDK stream: a synthetic assistant frame

All six answer the same way — **not** as a `system` message:

```jsonc
{
  "type": "assistant",
  "parent_tool_use_id": null,
  "message": {
    "role": "assistant",
    "model": "<synthetic>",
    "content": [{ "type": "text", "text": "## Context Usage\n\n…" }],
    "usage": { "input_tokens": 0, "output_tokens": 0, "…": 0 }
  },
  "local_command_source": "<local-command-stdout>## Context Usage\n\n…</local-command-stdout>",
  "local_command_run": { "command": "context", "args": "" },
  "context_usage": { "…": "structured twin, /context only" }
}
```

What identifies one is `local_command_source`: the same text as the content
blocks, wrapped in `<local-command-stdout>` (or `-stderr`). `local_command_run`
names the command without its slash — and is **absent** when the CLI refused
the command outright, which is what `/status` and `/permissions` do outside a
terminal ("`/status` isn't available in this environment."). `message.model`
is the literal string `<synthetic>`, and `message.usage` is all zeros.

The turn still bookends normally: a `system`/`init` frame precedes it and a
`result` follows, so the session goes `working` → `needs_input` exactly as it
would for a real turn.

### The structured twins

`/context` carries a `context_usage` (`SDKContextUsage`) sibling and `/usage`
a `usage_report` (`SDKUsageReport`), both at wrapper level so the model never
replays them. The SDK calls the markdown in `message.content` the canonical
form and the twins a convenience for clients that render a card from data.

Orbital reads `/context`'s twin (spec `2026-11-19-context-report-dialog-design`):
`transcript/notices.ts` puts it on the notice as `notice.contextReport`,
camelCased, with a tolerant reader — a report without numeric
`total_tokens` / `raw_max_tokens` and a `categories` array is dropped whole,
a malformed list is empty, a row without numeric `tokens` is skipped, an
unknown `kind` is kept. The clients draw it as a one-line row and a report
dialog (a sheet on the phone); the text stays as the fallback and the
dialog's "As text". `usage_report` is still not read.

The twin is not the arc's source. `context_usage.total_tokens` is the CLI's
estimate against `raw_max_tokens`, which can be a compaction window smaller
than the model's (the 200K boundary on a 1M model); the arc's one source is
still the `get_context_usage` control request (adr
`context-usage-has-one-source`), which a `/context` turn's `result` triggers
anyway. The dialog shows the CLI's own figures and does not reconcile them
with the arc.

## On the SDK stream: the `system` subtypes that exist but were not used

`SDKMessage` does contain two `system` subtypes that carry user-facing text,
and neither of the six commands produced one:

- `local_command_output` — `{ type: 'system', subtype: 'local_command_output',
  content: string, uuid, session_id }`. The SDK documents it as "Output from a
  local slash command (e.g. /voice, /usage). Displayed as assistant-style text
  in the transcript." It was **not** observed for any of the six.
- `informational` — `{ type: 'system', subtype: 'informational', content:
  string, level: 'info' | 'notice' | 'suggestion' | 'warning', tool_use_id?,
  prevent_continuation? }`. "Non-error status lines, hook feedback (e.g. a
  UserPromptSubmit hook's block reason), slash-command output."

Orbital handles both anyway. They are in the union, the SDK names commands
that use them, and the cost of a handler is a branch.

A parity audit in this repo reported `local_command_output` as *the* mechanism
behind the six commands' silence. That is wrong for this CLI: the name is real,
the mechanism is not.

## In the transcript file: `system` / `local_command`

The file uses none of the stream's names. One command writes up to two lines:

```jsonc
{"type":"system","subtype":"local_command","content":"/status","level":"info", …}
{"type":"system","subtype":"local_command","content":"<local-command-stdout>/status isn't available in this environment.</local-command-stdout>","level":"info", …}
```

The first is the **echo** of what was typed; the second is the **answer**. The
two are complementary, never duplicated: a command the CLI expands (`/context`,
`/usage`, `/mcp`, `/agents`) writes a `<command-name>` *user* turn instead of an
echo, and a command it refuses before expanding (`/status`, `/permissions`)
writes an echo and no user turn at all.

`level` is `info` on every one of them, so it says nothing worth rendering.

The `/context` answer entry carries the same twin as `contextUsage` (the
stream's object under a camelCase key, its fields still snake_case), and a
`commandRun: { command, args }` beside it — measured on 2.1.280, 2026-11-19.
The parser reads `contextUsage`; it does not read `commandRun`, so a
reloaded local command still names no command (the `/context` row names
itself from its report).

Older CLIs wrapped the same `<local-command-stdout>` payload around ANSI-coloured
terminal output rather than markdown (transcripts from 2.1.228 carry the block
drawing of `/context` verbatim, escape codes included), which is why the row
decodes ANSI on the way to the screen.

## What Orbital does with all this

Both paths converge on one `ChatMessage` shape, `role: 'notice'` (adr
`notice-rows-are-their-own-kind-of-turn`):

| where | what it sees | what it makes |
|---|---|---|
| `runner.ts` pump | synthetic assistant frame | notice, with `command` from `local_command_run` |
| `runner.ts` pump | `system`/`local_command_output` | notice |
| `runner.ts` pump | `system`/`informational` | notice at the SDK's own level |
| `parser.ts` (`entriesToMessages`) | `system`/`local_command`, wrapped | notice |
| `parser.ts` (`entriesToMessages`) | `system`/`local_command`, echo | `user` row — it is what was typed |

`transcript/notices.ts` holds the shape-reading; the pump and the parser only
call it. The parser path covers three surfaces at once: the REST history, the
`TranscriptTail` live feed (which is how a *terminal* session's transcript
reaches the browser), and the auto-titler — which ignores unknown roles, so a
page of `/context` output cannot become a session title.

## How the row is drawn

`NoticeRow` was built before its design existed, borrowing every value from a
row that did have one. **The design pass happened on 2026-09-23** against
canvas `Feature - Transcript blocks` artboard **20c** "NOTICE ROWS — THE CLI'S
OWN VOICE", with **20a** for where the row sits between messages.

- **Not a box.** 20c drops the bordered, filled `<pre>` for dashed rules above
  and below at full transcript width — a printout between messages rather than
  a panel. Only `warning` leaves the printout for a solid box.
- **No hue.** The old loud variant borrowed the transcript's error-alert reds.
  20c's rule is that amber and red belong to the tags and the mode dots, so the
  four levels separate by glyph and ink weight alone: `·` INFO, `○` NOTICE,
  `◇` SUGGESTION in the accent, `▲` WARNING at full white in its box. The
  artboard's own acceptance test is that a greyscale screenshot still tells
  them apart.
- **Two headers, and `command` chooses.** A notice that names a command is that
  command's output and wears 20c A's `CLI` + command chip + time; one that
  names none is a run message and wears 20c F's glyph + level label. This is
  the one discriminator the data actually carries (see the table above), and it
  keeps 20c E's rule either way — the chip is absent, never guessed.
- **Folded, not capped.** 20c B renders up to 8 lines in full and clips longer
  output with a fade and one `show all n lines` link that grows the row in
  place. That replaced the bounded scroller this row used to own, which the
  feature's acceptance list forbids: the transcript scrolls, the row never
  does.
- **Box drawing joins.** Output carrying box-drawing characters or raw ANSI is
  set at 20c D's tighter 1.3 leading without reflow and scrolls sideways in its
  own line box; prose keeps 1.55 and wraps.

## What is still open

- **Markdown is still not rendered.** 20c C sets `/context`'s pipe table as a
  three-column grid in the notice's own mono type, numerics right-aligned,
  headers as mono eyebrows. A `/context` answer with its twin no longer shows
  the table (it is the report row, canvas `Feature - Context report` 70b), but
  one from a CLI too old to attach it, and every other command's table, still
  print verbatim.
- **`/usage`'s twin is not rendered.** `usage_report` is on the wire beside
  `/usage`'s text; the code that draws `/context`'s report could draw it next.
- **The reloaded rows name no command.** The file's `commandRun` would give a
  reloaded local command the same `CLI` + chip header the live one has; the
  parser does not read it yet.
- **20c F's trailing action is undrawn.** A suggestion row in the artboard ends
  in the command that answers it (`/compact →`). Nothing on the wire says what
  that command is.
