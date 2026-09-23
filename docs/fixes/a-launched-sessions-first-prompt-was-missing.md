---
id: a-launched-sessions-first-prompt-was-missing
title: A session launched from the New Session dialog showed no first prompt
status: done
type: fix
domain: sessions
related:
  - first-turn-can-outrun-the-ws-subscription
  - the-browser-mints-the-session-id
  - transcript-pages-older-history-on-scroll
tags:
  - transcript
  - runner
---
# A session launched from the New Session dialog showed no first prompt

## What happened

A session started from the New Session dialog opened with the assistant's
reply at the top and no user turn above it. The prompt typed into the dialog
appeared only after pressing "Load older", or after a reload.

## Why

Two things were missing, and a third bug hid them.

1. **Nothing publishes a user's turn.** The Runner streams the SDK's frames
   onto `session:<id>`, but the SDK is never asked to replay stdin (no
   `--replay-user-messages`), so the only `user` frames it sends back are
   tool results. Later prompts show up because `sendPrompt` appends an
   optimistic `local:` turn. `launchSession` appended nothing.
2. **The REST read comes too early.** `select()` runs right after the launch
   request resolves. At that moment the row has `project_dir: ''` and the CLI
   has not written the transcript, so `GET /api/sessions/:id/messages` answers
   `{ messages: [] }`. The empty answer sets `historyLoaded`, so the tab never
   reads the file again until a reload or a reconnect.
3. **"Load older" hid it by duplicating the session.** Its cursor was the
   oldest message held, a live id (`<session>:<seq>:<i>`) the file never
   contains. The route treated an unknown `before` as no cursor and returned
   the transcript's tail. The file uses different ids (`<uuid>:<i>`), so the
   client's dedupe matched nothing. The whole session was prepended a second
   time, first prompt included. That looked like the prompt had been
   "loaded".

This came out of the fix for
[[first-turn-can-outrun-the-ws-subscription]]. Before that fix, the early
read 404'd, and `select()` left `historyLoaded` unset, so a later select read
the file. The 404 was replaced by an empty 200, which is correct, and the
retry went with it.

## How it was fixed

- `launchSession` appends the first prompt as an optimistic turn, built by
  the same helper `sendPrompt` uses (`optimisticTurn`). It is appended before
  the request goes out, so a reply that arrives while the request is still in
  flight lands below it. It is dropped again if the launch is refused.
- The messages route answers a `before` cursor it cannot find with an empty
  page. Everything the client holds under such a cursor arrived live from
  the launch on, so nothing is older than it.

Pinned by `web/src/test/launch.test.ts` (first prompt above the first reply,
dropped on failure) and `server/test/routes.test.ts` (unknown cursor → empty
page).

## Still true

`select()` still merges a REST page into live messages by id, and the two
id schemes never match. A launched session avoids this only because the file
does not exist yet when it is selected. A tab that selected the session later,
after the indexer found the file but with live messages already cached, would
show them twice. That has not been reported and is not fixed here.
