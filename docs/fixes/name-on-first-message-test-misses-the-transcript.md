---
id: name-on-first-message-test-misses-the-transcript
title: A name-on-first-message test sometimes never sees the transcript it wrote
status: backlog
type: fix
domain: sessions
related:
  - 2026-10-21-name-on-first-message-design
tags:
  - server
  - tests
  - flaky
---
# A name-on-first-message test sometimes never sees the transcript it wrote

## What happens

`server/test/nameOnFirstMessage.test.ts` → "keeps the name of a session
the user had written in before the harness came" fails now and then in a
full `npm test -w server` run, never when the file runs alone:

```
AssertionError: expected '' to be 'fix the zoom'
 ❯ test/nameOnFirstMessage.test.ts:239
```

The test launches a session, writes the CLI's transcript for it under
`projects/-w-x`, and waits for the title derived from it. In a failing
run the title stays empty even with an eight-second wait, so the
transcript is not read late but not read at all. The same run logs the
boot's "backfilling the session-stats index" from inside this test: the
server is still starting when the file is written.

## Where it was seen

On the release branch `release/2026-11-11`, before and after the review
fixes of #200 (one run in three on the commit before them), with this
test unchanged since desktop 0.47.0. The rest of the suite passes.

## Likely cause

The watcher does not yet watch the new project directory when the test
creates it right after the launch, so the write's event is lost, and
nothing rescans. Not confirmed.

## What to do

Confirm whether a transcript written while the server finishes booting
is missed in the app too, not only in the test. If only the test: write
the transcript once the server is ready, or wait for the watcher before
writing. If the app: a directory the watcher starts on later must be
scanned once when it is picked up.
