---
id: name-on-first-message-test-misses-the-transcript
title: A name-on-first-message test sometimes never saw the transcript it wrote
status: done
type: fix
domain: sessions
related:
  - 2026-10-21-name-on-first-message-design
  - recursive-fs-watch-instead-of-chokidar
tags:
  - server
  - tests
  - flaky
---
# A name-on-first-message test sometimes never saw the transcript it wrote

## What happened

`server/test/nameOnFirstMessage.test.ts` → "keeps the name of a session
the user had written in before the harness came" failed in most full
`npx vitest run` runs in `server/`, never when its file ran alone, and
never with `--no-file-parallelism`:

```
AssertionError: expected '' to be 'fix the zoom'
```

The transcript was on disk, but the session had no messages and no first
message time: the server never indexed the file, however long it waited.

## Cause

The test launched a session and wrote its transcript straight after the
server's boot. The transcript watch is a recursive `fs.watch` on the
projects directory, which macOS serves with an FSEvents stream; the stream
starts with a delay that grows with the load on the machine (a full run
opens many at once), and a write made before it runs produces no event.
The file was then never written again, so nothing indexed it. Waiting
500 ms before the write made every full run pass; burning CPU alone did
not make it fail.

In the app the window is the same few moments after a boot, and a
session's CLI keeps writing its transcript, so the next write is seen.

## Fix

The test waits until the watch delivers events before it writes: it
writes a probe transcript, again on every try, until the probe's session
appears (`watchIsLive`).
