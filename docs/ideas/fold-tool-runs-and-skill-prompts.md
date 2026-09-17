---
id: fold-tool-runs-and-skill-prompts
title: Fold a tool run, and a skill's expanded prompt, behind one line
status: backlog
type: idea
domain: web
related:
  - clickable-file-paths-in-the-transcript
tags:
  - detail-panel
  - transcript
---
# Fold a tool run, and a skill's expanded prompt, behind one line

The transcript is faithful to the CLI's output, which is the problem. Two
kinds of machine noise push the actual conversation off the screen, and both
are already half-solved somewhere in the code.

## A run of tool calls

`groupToolRuns` folds consecutive tool rows into one group and packs them 4px
apart inside the transcript's 14px rhythm, so a run already reads as one block
of machine work. But every row in it is still rendered: a twenty-step run is
twenty lines of `▸ ⚙ Read: web/src/App.tsx`, and the assistant's sentence
before it and after it are a screen apart.

The group is the right unit to collapse, and it exists. Give it a header —
`▸ ⚙ 12 tool calls · Read ×6, Bash ×4, Edit ×2` — and render today's stack
only when it is open. Two rules keep it honest:

- A run that is still running stays open, or at minimum keeps its unfinished
  row visible. `openToolUse` already names exactly that row for `StopDialog`;
  the transcript can use the same predicate rather than a second one.
- Collapse by threshold, not always. A single `Bash` between two turns is not
  noise, and hiding it behind a summary costs a click to learn nothing.

Whether a group the user opened stays open as new messages stream in is a real
question — `ToolRow`'s `expanded` is component state keyed by message id, so it
survives a re-render but nothing else. Per-group state in the store would
survive a reselect too.

## A skill's prompt, printed whole

When a slash command runs, the CLI writes the command's entire expansion into
the user turn, wrapped in `<command-name>`, `<command-message>`,
`<command-args>`, `<command-contents>` and `<local-command-stdout>`. A skill's
body can be hundreds of lines, and the panel prints all of it as one enormous
user bubble, because `entriesToMessages` passes `text` through untouched.

The parser already knows these tags. `NOISE_BLOCK` in
`server/src/transcript/parser.ts` lists every one of them — including
`<system-reminder>` — but only `cleanTitle` uses it, and only to keep the
sidebar's titles readable. The knowledge is there; the transcript just never
asked for it.

So: split a user turn into what the person typed (which `cleanTitle` already
isolates as the non-tagged remainder) and the machinery around it. Render the
first as the bubble, and the second as a collapsed `▸ /code-review` line that
expands to the full expansion. Nothing is thrown away — the current behaviour
is simply what "expanded" looks like.

Whether the splitting happens in `entriesToMessages` (so `ChatMessage` carries
the parts and every consumer agrees) or in `MessageView` (so the wire shape
stays as it is) is the one decision to make first. The parser is the better
place: the same wrapping is what makes a title useless, and one definition
cannot drift from the other.

The `Skill` tool call is a separate shape — a `tool_use` whose result is the
skill body — and it already lands in a collapsed `ToolRow`, so it needs
nothing beyond what the run-folding above gives it.
