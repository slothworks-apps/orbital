---
id: recursive-fs-watch-instead-of-chokidar
title: The server watches directories with fs.watch, not chokidar
type: adr
status: in-force
domain: sessions
related:
  - resource-usage-pass-2026-09-24
  - the-tail-yields-to-the-runner
tags:
  - server
  - performance
  - watcher
---

# The server watches directories with fs.watch, not chokidar

## The problem

The server watched `~/.claude/projects/` with chokidar 4, `depth: 2`. On
2026-09-24 the dev server held ~709 open files, 665 of them under
`~/.claude/projects` (audit [[resource-usage-pass-2026-09-24]], finding 3).

chokidar 4 dropped its FSEvents backend. On macOS it now calls `fs.watch`
once per file, and Node watches a single file through a kqueue descriptor.
So the server held one descriptor for every transcript ever written, and one
for every `memory/` file, and the count grew with history. It never shrinks,
because the CLI does not delete transcripts.

The registry watcher (`~/.claude/sessions/*.json`), the IDE lock watcher
(`~/.claude/ide/`) and `GitStore` (one `HEAD` per repository) used chokidar
the same way, at a smaller scale.

## The decision

Every watch in the server is a plain `fs.watch` on a **directory**, and it
filters by file name:

- `projects/` gets one `fs.watch(dir, { recursive: true })`. Its events are
  narrowed to `<project>/<id>.jsonl` (`projectsEventTarget` in
  `server/src/watcher/projects.ts`).
- `sessions/` and `ide/` get a non-recursive watch on the directory.
- `GitStore` watches the git directory and reacts to `HEAD` only.

`server/src/watcher/watchDir.ts` holds the shared part. When the directory
does not exist yet, it watches the nearest existing ancestor until the
directory appears (a fresh machine has no `~/.claude/projects`). When the
watch errors, it sets it up again. `TranscriptTail` already watched its
directory rather than its file, for a different reason (a kqueue race), and
it stays as it is.

chokidar is no longer a dependency.

Measured on 2026-09-24, against the real `~/.claude` (494 transcripts), with
a throwaway server:

| | open files | under `~/.claude` |
|---|---|---|
| before (chokidar) | 709 | 676 |
| after | 26 | 0 |

## Why this works

On macOS, libuv watches a directory through FSEvents and closes the
descriptor it opened to check the path. A watched directory therefore costs
no file handle, recursive or not, however large the tree gets. Only a
watched *file* costs a kqueue descriptor. This is why the `GitStore` watch
names the git directory and not `HEAD`.

## What it costs

- **macOS only, in practice.** A recursive `fs.watch` works on macOS and
  Windows. On Linux it needs Node 20+, which walks the tree with inotify, one
  watch per directory. The desktop app ships for macOS arm64 only, and the
  dev machines are Macs, so nothing loses anything today. A Linux port would
  have to check this again.
- **Coalesced, unattributed events.** FSEvents can merge events, name a
  directory rather than the file inside it, or name nothing when it had to
  drop events. The projects watch handles each case: a project directory
  alone indexes that directory's transcripts, and an event with no name runs
  the full pass. An event never says *what* happened, so every consumer
  stats the file (the indexer, the IDE lock watch, `GitStore`'s `HEAD`
  check) rather than trusting an add, change or unlink label.
- **We own the edge cases** chokidar used to handle: a directory that
  appears late, a directory removed while watched, and the watcher's
  `error` event. `watchDir.ts` covers them. It has tests for the late
  directory and for recursive paths.

## Ruled out

- **Keeping chokidar and narrowing it** (for example `depth: 1` and ignoring
  `memory/`). This still costs one descriptor per transcript, so it does not
  fix the growth.
- **chokidar 3**, which still had FSEvents. It needs the optional native
  `fsevents` module, which means a native dependency in the bundle and a
  pinned major that is no longer maintained, all for something `fs.watch`
  already does.
- **Polling** (`fs.watchFile`, or a stat loop). It reads the disk all the
  time for a tree that is mostly idle, and it is slower to notice a write.
