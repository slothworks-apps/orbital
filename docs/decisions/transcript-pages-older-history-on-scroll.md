---
id: transcript-pages-older-history-on-scroll
title: The transcript pages older history on scroll, not on a button
type: adr
status: in-force
domain: web
related:
  - the-transcript-scrolls-on-its-own-raf-loop
  - a-launched-sessions-first-prompt-was-missing
tags:
  - transcript
  - pagination
---
# The transcript pages older history on scroll, not on a button

## The problem

A session's transcript opens on its last page of messages. Everything older
sat behind a "Load older" button at the top, one page per click. Reaching the
start of a long session took one click per page, and a reader scrolling up
hit a button instead of more of the conversation. Tomin does not want to press
it at all.

## What was decided

**Reaching the top of the transcript loads the next older page on its own.**
A sentinel sits above the first row, and an `IntersectionObserver` rooted at
the transcript's scroll container watches it, with a margin so the page
starts loading shortly before the reader gets there. This is the sidebar's
infinite scroll (`Sidebar.tsx`, `sentinelRef`) turned upside down, with the
same injectable observer factory for tests.

- **The reader's place does not move.** The page lands above the viewport,
  and the existing prepend compensation (`compensatePrepend`, armed before
  the fetch) moves `scrollTop` down by exactly the height that was added.
  Following new messages at the bottom is untouched: compensation and
  stick-to-bottom are separate branches of the same layout effect, and the
  prepend is flagged explicitly rather than inferred.
- **One page per scroll to the top.** The observer is re-created each time
  the transcript grows, because an observer only reports changes. While the
  sentinel stays in view (a short transcript) the next page is asked for;
  once it scrolls out, nothing more loads until the reader scrolls up again.
- **Rows already held come first.** The view renders a window of the most
  recent rows. When that window has cut rows off, reaching the top reveals
  them before anything is fetched. The fetch is cursored on the store's
  oldest message, so it could never bring them back.
- **It stops on an empty page.** The store's `loadOlder` resolves to what it
  actually prepended. An empty result means nothing older, and the sentinel
  leaves the DOM. A page holding only messages already there counts as empty,
  because asking again with the same cursor would return the same page
  forever.
- **A failed fetch is retried, not ended.** `loadOlder` resolves to `null`
  on a failed fetch. That leaves the paging on, and the next scroll to the
  top asks again.
- **No overlapping loads.** A ref guards the in-flight load, because the
  observer can report twice before a render lands.
- **Arrival does not load anything eagerly.** On arrival the view jumps to
  the bottom in a layout effect, before an observer reports anything, so a
  long transcript loads nothing until the reader scrolls up. A short one,
  whose top is in view, asks once, gets an empty page and stops.

## What was ruled out

- **Keeping the button as a fallback for a failed load.** The failure is
  retried by scrolling, which is the gesture the reader is already making. A
  button that appears only after an error would be a second way to do the
  same thing.
- **A scroll listener checking `scrollTop` near zero.** It runs on every
  scroll frame, needs its own threshold and debounce, and fires during the
  view's own animated scrolls. The observer reports only crossings, and the
  sidebar already uses one.
- **Real virtualization.** It would replace the window and the prepend
  compensation both. It is still deferred, as it was when the window was
  introduced.
