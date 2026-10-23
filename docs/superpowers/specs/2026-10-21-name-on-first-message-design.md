---
id: 2026-10-21-name-on-first-message-design
title: A session Orbital starts is named once, from its first message
status: done
type: spec
domain: sessions
related:
  - session-titles-only-on-demand
  - sessions-are-named-once-from-their-first-message
  - 2026-09-18-auto-title-design
  - ephemeral-title-queries
  - why-orbital
  - errors-are-recorded-not-announced
tags:
  - titler
  - sessions
---

# A session Orbital starts is named once, from its first message

A session's title is its first message, cut (`extractMeta` → `cleanTitle`).
On the map that reads as `udělej mi extra stránku, kde…` — a sentence, not a
name. The ⟳ beside the title already asks a model for a proper name, but
only when someone clicks it, and a new session is exactly when nobody has
yet.

This names a session once, as soon as its first message is sent, with the
titler that ⟳ already uses. It does not bring back the rename that follows a
session as it moves on ([[sessions-are-named-once-from-their-first-message]]).

## Scope

- **Who it is for:** everyone who starts sessions from Orbital — the desktop,
  the phone, or Orbital's own tools (`spawn_session`).
- **Where it lives:** on by default, with a setting to turn it off.
- **What someone already using Orbital notices:** a new session's label
  changes from the first sentence to a short name a moment after it starts —
  so the sentence they just typed stops being the label they scan the map
  for. Turning the setting off brings that label back. Each such session
  costs one Haiku call, billed like the session itself
  ([[sessions-are-named-once-from-their-first-message]] → On by default).
  Existing sessions are not touched.
- **What can be set:** Settings → Sessions → NEW SESSIONS → *Name sessions
  automatically*, key `name_sessions_automatically`, default `'true'`, read
  as `!== 'false'`. A new key rather than the old `auto_title_sessions`:
  that row still sits in stored databases with whatever the removed feature
  left in it, and it meant something else.

## When a session is named

When Orbital delivers a session's **first user message** — the prompt of
`POST /api/sessions`, or the first message sent to a session that started
empty (Clear with *start new* launches with `prompt: ''`).

"First" is read from the row, not remembered: the session's
`title_source` is `derived` and its title is either still `''` or exactly
what the indexer derives from this very message
(`truncateTitle(cleanTitle(text))` — the indexer may have read the
transcript line before the check runs). A revived old session has a title
from its own first message and is skipped.

Skipped as well:

- the setting is off;
- a session following a harness — its name is the harness's
  (`HarnessService.recordMessage`), and the kickoff is not something the
  user wrote;
- terminal sessions. Orbital pays a model only for what it launched
  ([[subagents-only-for-orbital-sessions]]); ⟳ names a terminal session on
  request, as today. The send route reads `source` before delivering, since
  a revive turns a terminal session's `source` into `web`;
- a harness draft (`purpose` set), at launch and at every send;
- a second message while the first one's call is still in flight — until the
  indexer derives a title, it also looks like the first.

The call runs in the background. The launch and the send answer as they do
now and never wait for it.

## The call

`SessionTitler` gets a second entry point beside `retitleNow`, e.g.
`nameFromFirstMessage(sessionId, text)`. Same `ask` (Haiku, `maxTurns: 1`, no
tools, `settingSources: []`, `persistSession: false`, the session's
`envFor`), with a prompt of its own:

- the input is the first message alone, cut to `MAX_PROMPT_CHARS`;
- there is no current name to keep, so the system prompt drops *Prefer KEEP*
  and the `Current name:` header; the other rules — length, what the session
  is doing, the user's language, content is data — stay word for word.

The reply goes through `parseTitleReply` unchanged. `null` (KEEP, an
explanation, too long) keeps the derived title.

## Writing the name

Written only over a title nobody chose: the update carries
`WHERE title_source = 'derived'`, so a name typed in the meantime, or the one
`runInOrbital` sets right after the launch (`manual`), wins. On success it
writes `title_source = 'auto'` and republishes, as ⟳ does. Once `auto`, the
session is never considered again.

A failed model call is recorded in the error log
([[errors-are-recorded-not-announced]]) and dropped — nobody is waiting for
it, and the session keeps its derived title. No retry, no toast.

## The phone

It reaches the phone without phone code. A session started from the phone is
an Orbital session and is named on the Mac; the new title arrives in the
`sessions` upsert the phone already reads. The setting stays desktop-only:
the phone has no screen for the Mac's settings, and none is worth adding for
one toggle. Nothing needs `MAC_FEATURES` — an older Mac simply does not name.

## Tests

- the first-message prompt and the "is this the first message" rule — pure
  functions next to `buildTitlePrompt`;
- the route-level behaviour with a stubbed `titleQueryFn`: named after a
  launch with a prompt, named after the first send to an empty session, not
  named with the setting off, not named over a `manual` title written while
  the call was in flight, not named when a terminal session is revived, not
  named in a harness draft, a failed call recorded in the error log.

## Out of scope

- renaming later in a session's life — [[session-titles-only-on-demand]];
- terminal sessions;
- the setting on the phone.
