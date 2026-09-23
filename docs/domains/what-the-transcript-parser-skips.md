---
id: what-the-transcript-parser-skips
title: What the transcript parser leaves out of a conversation
type: domain
status: in-force
domain: transcripts
related:
  - subagents-in-transcripts
  - locally-answered-slash-commands
  - 2026-09-18-transcript-folding-design
  - 2026-09-18-transcript-images-design
  - show-images-pasted-into-terminal-sessions
tags:
  - transcripts
  - parser
  - sdk
---
# What the transcript parser leaves out of a conversation

The CLI's session JSONL is undocumented, and much of what it writes in the
user's role was never typed by the user. `server/src/transcript/parser.ts`
decides what counts as a turn. This lists what it leaves out, and why.

## Entries dropped whole

`outsideConversation(e)` is the rule. Both `extractMeta`, which gives the
index its title, count and time span, and `entriesToMessages`, which gives
the transcript, skip what it matches:

- **`isSidechain: true`**: a subagent's own line. Its turns belong to the
  subagent's panel, not the parent's (see `subagents-in-transcripts`).
- **`isMeta: true`**: the harness speaking in the user's role. A survey of
  one project's transcripts on 2026-09-23 found these bodies, either as a
  string or as an array of `text` blocks and never with an `image` block:
  - a skill's body (`Base directory for this skill: …`,
    `(Re-invocation of /… — the skill instructions …`,
    `The user is asking a question. Your ONLY job…`)
  - `<local-command-caveat>…`
  - `Continue from where you left off.`
  - cross-session notices (`[Cross-session idle notice] …`,
    `Another Claude session sent a message: <cross-session-message …>`)
  - `[Image: original WxH, displayed at WxH. Multiply coordinates by …]`,
    written after a Read of an image
  - `[Image: source: /path/to/image.png]`, written after an image the user
    pasted. The pixels are already in the human's own entry as a base64
    `image` block, and the existing image pipeline renders them from there.
    Only the cache path is lost, and see
    `show-images-pasted-into-terminal-sessions`.

Before `isMeta` was honoured, a session opened with a bare `/skill` got the
skill's body as its title: the bare command is only a fallback, so the next
user entry won. On startup, `indexProjects` blanks stored titles that begin
with `Base directory for this skill:`, `(Re-invocation of /` or `[Image:`,
so that those sessions work out their titles again.

The stats (`server/src/stats/compute.ts`) do **not** skip `isMeta`. A meta
entry is still input the model was sent, and a user entry is where API
timing starts counting.

## Entries that are not turns but are kept

- **`type: "system"`, `subtype: "local_command"`**: becomes a notice row
  (see `locally-answered-slash-commands`).
- **Every other type** (`attachment`, `summary`, `file-history-snapshot`,
  other `system` subtypes): ignored.

## Text stripped inside a real user turn

`NOISE_BLOCK` matches the CLI's machine tags inside a turn the human did
write: `<local-command-*>`, `<system-reminder>`, `<command-*>`,
`<task-notification>` and `<orbital-walkthrough>`. `splitUserText` folds
them behind a chip instead of dropping them (spec
`2026-09-18-transcript-folding-design`), and `cleanTitle` keeps them out of
titles. This is a different mechanism from `isMeta`. The tags sit inside the
human's entry, and the entry itself stays.

## The live path

Orbital-run sessions do not read the file. They get SDK frames, which
`sdkToChatMessages` in `server/src/runner/runner.ts` turns into messages.
The SDK has no `isMeta` field. The CLI sets `isSynthetic: true` on a user
frame when the entry is `isMeta`, `isVisibleInTranscriptOnly` or
`isCompactSummary`. `sdkToChatMessages` drops synthetic user frames. When
the runner passes frames to `onEntries` (the titler), it sets `isMeta` back
on them. A compact summary is a string body, which the live path never
rendered. On the file path it still shows as a user turn, because it is not
`isMeta`.
