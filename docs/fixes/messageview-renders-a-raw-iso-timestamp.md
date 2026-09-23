---
id: messageview-renders-a-raw-iso-timestamp
title: MessageView renders message.timestamp as a raw, unformatted ISO string
status: done
type: fix
domain: subagents
related:
  - 2026-09-22-subagent-transcript-panel-design
tags:
  - web
  - transcript
---

# `MessageView` renders `message.timestamp` as a raw, unformatted ISO string

Found while reviewing this branch's work, not introduced by it. Not fixed
here: no canvas shows a timestamp under a message bubble at all, so fixing
it means either deleting an element someone may have intended to keep, or
inventing a display format with no design to match — on a surface this
branch did not touch and the governing spec did not scope.

## What the bug is

`web/src/panels/MessageView.tsx:343-344`:

```tsx
{message.timestamp && (
  <span className="font-mono text-[10px] text-text-muted">{message.timestamp}</span>
)}
```

`message.timestamp` is an ISO 8601 string (`2026-09-22T10:00:00.000Z`,
stamped by `sdkToChatMessages`/`entriesToMessages`) and is interpolated
directly, with no `Date` formatting of any kind. Every user and assistant
bubble that carries a timestamp shows the full machine-readable string —
`2026-09-22T10:00:00.000Z`, not a time, not a relative "2m ago" — under
itself.

This dates to commit `7aa458a` (2026-09-15, "transcript renderer with tool
rows"), confirmed by `git blame`: lines 343-344 are still attributed to that
commit, unmoved by every later change to the file. It predates this branch
by a week.

## Why this branch widens it

Before this branch, `sdkToChatMessages` (`server/src/runner/runner.ts`)
stamped no `timestamp` on live messages at all — only `entriesToMessages`
(`server/src/transcript/parser.ts`), the reload path, did, because only a
reloaded session's messages come from an already-written `.jsonl` with its
own recorded timestamps. So the raw-ISO-string bug was visible only after a
page reload, never on a message that streamed in live.

Commit `2067c2c` (task 1 of this branch, "Carry thinking blocks and publish
timestamps through `ChatMessage`") made `sdkToChatMessages` stamp every
emitted message with a timestamp too — needed so a later task could compute
tool-row durations (`toolDurationMs`, `web/src/panels/ToolRow.tsx`). That is
an unrelated, correct reason to add the field. Its side effect is that the
bug's reach widened from "reloaded transcripts only" to "every message,
live or reloaded" — nothing about `MessageView`'s own rendering changed, but
the set of messages that now carry a `timestamp` at all grew to include
every live one.

## Why it is not fixed here

Two things would have to be decided to fix it, and neither is this branch's
call to make:

- **Delete the element.** No canvas — not 1b (the parent transcript), not
  11b (the subagent panel) — draws a timestamp under a message bubble.
  Deleting it might be correct, or might remove something someone added on
  purpose for a reason not recorded anywhere this branch's author could
  find.
- **Reformat it instead.** Doing that invents a time format (relative? a
  clock time? which timezone?) with no design reference to match it against,
  on a surface — `MessageView`, the parent transcript's own bubble renderer
  — this branch's spec (`2026-09-22-subagent-transcript-panel-design.md`)
  never scoped in the first place.

Either choice is a design decision about an already-shipped, already-approved
surface, not a consequence of anything this branch built. Worth revisiting
the next time `MessageView` or its canvas is touched on purpose.

## Resolved in the whole-branch review

The second option, reformatting, was taken. The format was not invented:
the same three lines — `toLocaleTimeString(undefined, { hour: '2-digit',
minute: '2-digit' })` — already appear in `TranscriptView`'s model divider,
`QuestionCard`'s answered-at line and `FileViewer`'s footer, so `MessageView`
is a fourth matching copy rather than a new convention. A timestamp `Date`
cannot parse renders nothing at all, never the words "Invalid Date".

Deleting the element was left alone: the argument above stands that no canvas
draws it, but widening a branch's scope to REMOVE a shipped element on the
strength of an absence is a bigger call than making the element stop
shouting. What tipped the balance to fixing rather than filing was that this
branch is what made it visible everywhere — 24 characters and a full extra
line under every bubble in a 380 px panel.

`web/src/test/transcript.test.tsx` asserts the raw ISO string is NOT
rendered, rather than asserting a particular clock format: the format is the
locale's, so pinning it would pin the test runner's locale, while "is not
the machine string" can only fail by regression.
