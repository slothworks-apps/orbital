---
id: composer-drafts-are-kept-per-session-in-memory
title: A session's unsent composer text is kept per session, in memory only
status: in-force
type: adr
domain: web
related:
  - the-new-session-dialog-remembers-the-last-launch
tags:
  - sessions
  - composer
---
# A session's unsent composer text is kept per session, in memory only

## The problem

The detail panel held the composer text in its own state and cleared it
whenever the selected session changed. Leaving a half-written message to
answer another session's question, then coming back, found the composer
empty and the message gone.

## The decision

The draft lives in the store, keyed by session id (`composerDrafts`). The
panel reads and writes the selected session's entry, so switching sessions
swaps the draft instead of clearing it.

An entry goes away when the draft is sent or emptied, and when the session
is removed from the store. An ended session keeps its draft, because it can
still be continued from the same composer.

It is memory only. A reload or an app restart loses every draft.

## Ruled out

- **localStorage.** It would survive a reload, but it would also keep drafts
  for sessions that no longer exist unless something swept them. The
  complaint was about switching sessions, not about reloads, and memory is
  enough for that.
- **Keeping attached images too.** Chips are tied to uploads in flight in
  `useAttachments` and still reset on a switch. Only the text is kept.
