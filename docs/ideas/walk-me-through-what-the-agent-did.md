---
id: walk-me-through-what-the-agent-did
title: Walk me through what the agent did
status: done
type: idea
domain: sessions
related:
  - 2026-09-23-walkthrough-design
  - walkthrough-narration-is-a-turn-in-the-session
  - an-orbital-tag-marks-a-walkthrough-turn
  - 2026-09-22-subagent-transcript-panel-design
  - orbital-speaks-to-the-ide-itself
  - 2026-09-23-ide-bridge-design
  - subagents-only-for-orbital-sessions
tags:
  - transcript
  - ide
  - review
---
# Walk me through what the agent did

An agent finishes a piece of work — sometimes large, sometimes small — and the
person who dispatched it now has to stand behind it. Not merely trust it:
explain it to colleagues, in a review, as their own work. Right now the only
way to get there is to read the diff and reconstruct the reasoning backwards.

**The gap is not the diff. It is the join.** Git has always been able to show
what changed. What no tool keeps is the link from a changed line back to the
turn that changed it and the reason given at the time. The CLI does not keep
that link either — it scrolls away. Orbital is the only place that holds both
halves at once: the session's transcript on one side, the working tree on the
other, and now a diff renderer between them.

In *this* repository there is a second source of reasoning to draw on, because
`CLAUDE.md` obliges every agent to write an ADR for a decision and a spec for
agreed behaviour. Those documents exist and nothing gathers them up, so the
walkthrough should use them where they are there — but **only as a bonus**.
The atlas convention is local to Orbital and is not how most projects work; a
walkthrough that leans on it would produce nothing anywhere else. The
transcript has to carry the explanation on its own.

## What it is

**A guided walkthrough inside Orbital**, driven by the person reading it, one
session at a time, in the order the work actually happened.

Decided when the idea was raised:

- **A guide, not a document.** It is read in the session panel by the person
  who ran the session, not exported and sent to anyone. The purpose is to end
  up understanding the change well enough to defend it — once that has
  happened, no artefact is needed. (Consequence: if something sendable is ever
  wanted — a PR description, a page for colleagues — that is a *second*
  feature, not a rendering mode of this one. It has a different audience and a
  different standard of truth.)
- **Chronological.** The story is what the agent did, in the order it did it,
  rather than a tour of the final diff by file. This is the most faithful
  ordering and the one that makes abandoned attempts visible.
- **One session, subagents included.** Not a branch, not a pull request. The
  data is already all in one place for Orbital's own sessions.

## What makes it hard

**Chronological means noise.** A session is mostly reading, searching and
checking. A walkthrough that replays all of it is worse than the transcript it
came from. The design problem is *elision*: the spine should be the turns that
changed something, with everything else collapsed behind them. Deciding what
survives that filter is the whole feature.

**Blind alleys are the point, not a defect.** An attempt that was made and
abandoned is exactly the material a review asks for — "did you consider Y?"
— so it must be shown *as* abandoned rather than quietly dropped. A purely
chronological replay shows it by accident; the elision filter must be careful
not to remove it.

**Attribution is last-writer-wins.** Orbital sees every `Edit` and `Write` with
its file path and both sides, so a line can be traced to the turn that wrote it
without git blame. But a later turn that rewrites the same lines takes the
credit, and the earlier reasoning — often the more interesting one — detaches
from the code. A walkthrough that claims the final diff explains the session
will be wrong exactly where the session was most interesting.

**Terminal sessions have thinner data.** Attribution leans on the tool calls
Orbital captured. For sessions Orbital ran itself these are SDK messages; for
sessions it merely watched, they come from the CLI's undocumented transcript
format. The feature will be better for Orbital's own sessions, and should not
pretend otherwise.

## What the IDE bridge gives it

This is the idea that makes the pull direction of
[[orbital-speaks-to-the-ide-itself]] earn its keep:

- **`openFile`** — each step of the walkthrough can put the editor on the exact
  file and line being discussed. Reading a change in a real editor, with the
  rest of the file around it and the project's own navigation, beats any
  viewport Orbital could build.
- **`openDiff`** — a step can show its change as a real diff in the editor.
- **`getDiagnostics`** — "and nothing broke" is a claim the editor can check.

Without the bridge the walkthrough has to be its own reading surface. With it,
Orbital can be the narrator and leave the code to the tool built for reading
code.

## Open questions

- What is a "step"? A turn, a tool call, or a group of turns that belong to one
  intent? The last is the most useful and the least mechanical.
- Where do the ADRs and specs written during the session attach — to the step
  that wrote them, or to the steps they justify? And what takes their place in
  a repository that has no such convention, which is most of them?
- Does a subagent's work collapse to one step in the parent's story, expandable
  into its own walkthrough? (Its transcript is already a panel.)
- Is this better as a skill than a feature? A skill would work in the terminal
  and for any repository, but it cannot offer a guided, clickable reading and
  it does not have the IDE connection. The answer may be that the *elision* —
  working out which turns matter — is a skill, and the reading surface is the
  feature.

## Where it went

Brainstormed 2026-09-23. The open questions above are answered in
[[2026-09-23-walkthrough-design]]: a step is a run of tool calls that wrote
something, atlas documents are not used at all, a subagent's writes are one
step expandable into its own, and the elision is mechanical with the session
itself narrating on request ([[walkthrough-narration-is-a-turn-in-the-session]]).
The walkthrough is its own page, and a question about a step goes to the
session. Orbital's own sessions only.
