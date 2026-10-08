---
id: the-first-index-pass-timed-out-the-static-plugin
title: The first index pass on a long history failed the boot on the static plugin's timeout
status: done
type: fix
domain: server
tags:
  - server
  - indexer
  - boot
---
# The first index pass on a long history failed the boot on the static plugin's timeout

## What happened

With a fresh data dir, the built web app served (`ORBITAL_STATIC_DIR`, which
the desktop app always sets) and a large `~/.claude` (2.7 GB, 609
transcripts), the server printed the backfill notice and then died:

```
FastifyError: Plugin did not start in time: '@fastify/static'
  code: 'AVV_ERR_PLUGIN_EXEC_TIMEOUT'
```

Without `ORBITAL_STATIC_DIR` it booted, and so did the second start, when the
index already existed. Every first launch of the desktop app on a long
history would have failed.

## Why

`buildServer` started each Claude directory's first full index pass with a
`setImmediate`, meant to let `app.listen` bind first. But the directories
start before the plugins are registered, and `await app.register(...)` yields
to the event loop. `@fastify/static` awaits I/O while it loads, so the
immediate fired in the middle of its load, and the pass — synchronous, one
transaction, reparsing every transcript — held the event loop for longer than
avvio's plugin timeout. The timer fired before the plugin could finish.

The watcher's "cannot say which file" batch ran the same synchronous full
pass. It ran only after boot, so it never hit the timeout, but it froze the
server for as long as it took.

## The fix

- The full pass now runs in slices (`indexProjectsSliced` in
  `server/src/indexer/indexer.ts`): each slice is one transaction of as many
  transcripts as fit in `BACKFILL_SLICE_MS`, then it yields with
  `setImmediate` from `node:timers/promises`. Rollups are announced after each
  slice commits; the rule tags are regenerated once, at the end.
- Every index write in `server/src/index.ts` goes through one queue, which
  opens only when Fastify fires `onReady` — after every plugin has loaded.
  The boot passes run first, the default directory's before the others, and
  watcher batches after them, so the order of writes is what it was when the
  pass held the loop, and a session still belongs to the first directory that
  indexed it.
- Stopping a directory aborts its pass at the next slice and drops its queued
  batches; that replaces `clearImmediate`.

The plugin timeout was not raised: a pass that holds the loop is the fault,
and any timeout would be too short for some history.

## Checked

- `server/test/staticServe.test.ts`: a server with the built frontend whose
  first pass is held back starts no pass before it is ready, answers
  `/api/health` and `/api/sessions` while the pass waits, and lists every
  session once it runs.
- `server/test/indexer.test.ts`: the sliced pass yields between slices,
  indexes everything, stops writing once aborted, and applies the tag rules.
- The repro above: listening within a second, `/` and `/api/health` answering
  throughout, all 609 transcripts indexed.
