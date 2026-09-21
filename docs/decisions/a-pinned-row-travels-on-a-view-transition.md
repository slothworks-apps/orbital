---
id: a-pinned-row-travels-on-a-view-transition
title: A pinned row travels on a view transition, driven from the store
status: in-force
type: adr
domain: sessions
related:
  - 2026-09-20-pinned-sessions-design
tags:
  - sidebar
  - motion
---
# A pinned row travels on a view transition, driven from the store

## The problem

Pinning a session moves its sidebar row out of ACTIVE (or HISTORY) and into
PINNED, and unpinning sends it back. React re-renders both lists in one commit,
so the row was simply absent from one place and present in another. The user
clicked a small control at the right edge of a row and then had to find that
row again somewhere else in the rail — the one thing the gesture was supposed
to make obvious, that *this* session is now held, was the thing it hid.

## What was chosen

The browser's View Transitions API, with the transition started inside the
store action rather than in either button.

- `lib/viewTransition.ts` — `withViewTransition(apply)` runs the state change
  inside `document.startViewTransition`, wrapping it in `flushSync` so React
  has actually committed by the time the browser diffs the new DOM against its
  snapshot. Without the flush the callback returns before anything changed and
  the browser animates a frame against itself.
- Sidebar rows carry a per-session `view-transition-name`; that name is how the
  browser pairs the old row with the new one and tweens between them.
- `theme.css` gives every named group the app's panel duration and curve, and
  silences the default root cross-fade so nothing but the rows moves.

The wrapping lives in `setSessionPinned` (and in `setSessionDismissed`, but
only where the dismissal takes a pin with it, which is the only case that moves
a row). There are three ways to flip a pin — the sidebar row's button, the
detail panel's, and the absorption toast's Undo — and a row that slid when
flipped from one of them and jumped when flipped from another would read as a
bug, not as a shortcut.

## Why not the alternatives

**A layout-animation library** (Framer Motion's `layout`, or a hand-rolled
FLIP). It works in every browser, but it means every row measuring itself on
every render and a dependency whose job overlaps with CSS the platform now
ships. The rail already re-renders on every session update; adding a measure
pass to that path to animate a gesture the user makes a few times a day is the
wrong trade.

**Animating from the buttons.** Two call sites today, and the toast's Undo
makes three — the store is where they already agree on what pinning means, so
it is where they should agree on how it looks.

## What it costs

`startViewTransition` is Chromium and Safari; Firefox has no implementation at
the time of writing. `withViewTransition` falls through to a plain synchronous
`apply()` there, which is exactly today's behaviour — the row still moves, just
without the travel. The same fall-through covers `prefers-reduced-motion`,
where a row crossing the rail is precisely the large positional travel the
setting asks us to drop, and jsdom, which is why the test suite never touches
the transition path.

`flushSync` inside the callback is safe only because every caller is an event
handler. A caller that reached `setSessionPinned` from a render or an effect
would get React's warning and a deferred update; nothing does today, and the
helper says so where the next person will read it.
