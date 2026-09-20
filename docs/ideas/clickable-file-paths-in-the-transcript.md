---
id: clickable-file-paths-in-the-transcript
title: File paths in the transcript should be pressable, and markdown should open in Orbital
status: done
type: idea
domain: web
related:
  - desktop-wrapper-electron
  - tilde-expands-at-the-api-boundary
tags:
  - detail-panel
  - transcript
---
# File paths in the transcript should be pressable, and markdown should open in Orbital

A session's whole output is about files, and not one of them can be opened
from the panel. Reading `docs/ideas/subagent-model.md:12` in an assistant turn
means selecting the path, switching to an editor and pasting it.

> Shipped 2026-09-19 — see [[2026-09-19-file-viewer-design]]: pressable
> paths in tool rows, INPUT values *and* assistant prose, plus the
> in-Orbital viewer. Targets 2 and 3 below (editor, Finder) wait on
> [[desktop-wrapper-electron]] and live with that idea.

## What is text today

Two different kinds of path, with two different amounts of certainty:

- **Structured.** `ToolRow.salientInput` already pulls `file_path` out of
  every `Read`/`Edit`/`Write` input, and the full input JSON sits one click
  below it. No guessing is involved — the tool told us the path.
- **Prose.** `MessageView` runs assistant text through `ReactMarkdown`, so an
  actual markdown link becomes an anchor and a bare `web/src/App.tsx:42` stays
  inert text, because that is exactly what the markdown says it is.

The structured half is where this should start. It needs no heuristic, it
covers the rows people actually want to open, and it is one component.

## What pressing one should do

Three targets, in the order they are worth building:

1. **Preview inside Orbital.** The markdown pipeline already exists —
   `MessageView`'s `ReactMarkdown` + `remarkGfm`, and `highlightCode`'s shiki
   for fenced blocks. A file viewer is that pipeline pointed at a file's
   contents instead of a message's, with markdown rendered and everything else
   shown as a highlighted source blob. This is the only target that works in a
   plain browser tab, which is where Orbital runs today.
2. **Open in the editor.** Only once the Electron shell exists
   ([[desktop-wrapper-electron]]), where `shell.openPath` can hand the path to
   whatever owns `.ts` on the machine. A browser tab cannot do this and should
   not pretend to.
3. **Reveal in Finder.** Same constraint, same shell call.

## What the server has to grow

There is no file-reading route at all: `routes.ts` serves sessions, tags,
rules, models and settings, and nothing that touches the filesystem outside
`~/.claude`. A `GET /api/files?path=…` is new surface, and the guard rails
belong in the design, not in the implementation:

- The path arrives as text from a browser, so it goes through `expandHome`
  like every other typed path ([[tilde-expands-at-the-api-boundary]]).
- Confine reads to the session's `cwd` after resolving symlinks. The server
  runs as the user and binds `127.0.0.1`, so an unconfined route is a "read
  any file on this machine" endpoint for anything that can reach the port.
- Cap the size, and refuse anything that is not text rather than streaming a
  binary into the panel.

## The prose half, later

Linkifying paths inside message text is a rehype plugin over text nodes:
match path-like tokens with an optional `:line`, check them against the
session's `cwd`, and turn only the ones that resolve into anchors. The
checking is what makes it safe to be liberal in the matching — an invented
path simply stays text. Worth doing after the tool rows prove the viewer.
