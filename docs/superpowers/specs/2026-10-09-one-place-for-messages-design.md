---
id: 2026-10-09-one-place-for-messages-design
title: On the Mac, every message shows in one place, between the panels
status: done
type: spec
domain: desktop
related:
  - 2026-10-08-notifications-off-by-default-design
  - errors-are-recorded-not-announced
  - why-orbital
tags:
  - notices
  - toasts
  - web
---
# On the Mac, every message shows in one place, between the panels

## Problem

The Mac shows short messages through two systems that look and behave
differently:

- **The notice toast** (`ui/MapNoticeHost`, queue `useMapNotices`): messages
  about the app that wait for the user — a new version, the notifications
  tip. Top centre of the visible map strip, between the sidebar and an open
  right panel; one at a time, the rest as dots; nothing goes by itself.
- **The toast** (`ui/Toasts`, store slice `toast`): the reply to something
  the user just did — "Paired with …", "Record copied as Markdown",
  "… ended · Undo", and every request failure (`reportError` and the store's
  own catches). Bottom centre of the whole window, so with a panel open it
  sits off the map's centre and can cover the panel; one slot, a newer
  toast replaces the older; three looks (`info`, `error`, `rewind_refused`);
  only the Undo toast goes by itself.

To the user these are the same thing — a short message over the map — and
the differences in place, look and behaviour read as accidents.

## Goal

One place, one look family and one set of rules for every message on the
Mac, through one queue in code. The phone is out of scope (see below).

## Design

### Where messages come from: unchanged

Code keeps setting `useOrbital.toast` (`error`, `info`, `rewind_refused`)
as it does today. The phone keeps reading it for the composer line
(`mobile/composer.ts` `phoneError`). No call site changes.

### A bridge from the toast to the queue

On the Mac, one hook mounted by `App` watches `useOrbital.toast`:

- when a toast appears, it pushes an entry with the fixed id `toast` and the
  kind `feedback` into `useMapNotices`. The queue therefore holds at most
  one reply, and a newer reply replaces the one showing rather than
  queueing behind it;
- when the toast becomes `null`, it dismisses that entry.

The entry's `Body` renders the current toast from the store, so a
replacement needs no new entry.

### Replies come first

`NOTICE_KINDS` gains `feedback` at the head:
`feedback › update › changelog › pairing › usage › tip`. A reply shows at
once; a notice that was showing steps back into the dots and returns, with
the existing fade, when the reply ends.

### Closing

- × clears the toast (`clearToast`), which ends the entry.
- An action that already did its job clears the toast: Undo, as today.
- Detail on an error opens the errors log and ends the reply (see Drawn
  below); `rewind_refused` still goes on the next send.
- Dismissing a reply does not mark an error seen
  ([[errors-are-recorded-not-announced]]): only the log does.

### What goes by itself

- `info` goes after `FEEDBACK_NOTICE_MS`; the countdown waits while the
  pointer is over the card. The Undo toast's own timer (`UNDO_TOAST_MS` in
  the store) is replaced by this rule.
- `error` and `rewind_refused` stay until ×, until a newer reply replaces
  them, or (rewind) until the next send. Their record is in the errors log
  either way.
- Notices never go by themselves, as before.

`why-orbital.md` rules out "anything that disappears behind your back";
that is about the state of the work. A reply to the user's own action has
its record elsewhere — the log, Settings, the sidebar's history — and a
reply that never goes would hold back the notice under it.

### Removed

`ui/Toasts.tsx` and the bottom toast. `MapNoticeHost` draws every message,
so every message follows the panels' widths.

### Look

The notice card (`ui/MapNotice`) is too heavy for "Copied". The reply's card
is drawn in `Feature - Notice toast` 3a–3e (see Drawn below), from this
prompt:

> Add a feedback variant of the notice toast (1a) for the Mac: the reply to
> something the user just did — "Paired with Pixel 9", "Record copied as
> Markdown", "Planet X ended · Undo", or an error ("Could not stop the
> session · Detail"). Same place (top centre of the visible map strip,
> between the sidebar and an open right panel), same width limit, same
> glass/hairline family and the same dots above when other notices wait.
> Constraints: one line of text plus at most one action and ×; an error
> variant marked only by the errors-log red (oklch(66% .2 25)) dot, no red
> fill; info variant disappears by itself after a few seconds, error stays
> until ×; must read as calmer and smaller than the update notice it
> temporarily covers. Show: info, info with Undo, error with Detail, rewind
> refused (27c), and the swap back to a waiting update notice with dots.

## Phone

Left out on purpose. The phone has different needs — a small screen, its
notice pinned above the session list, request failures said on the
composer's line — and deserves its own design rather than a copy of the
Mac's. It keeps reading `useOrbital.toast` exactly as today. The one piece
of this change in its bundle is the new `feedback` kind in the shared
`lib/noticeQueue`, which the phone never pushes, so it behaves as before.
An `idea` records the phone's side.

## Tests

- The queue's order with `feedback` at the head (`lib/noticeQueue`).
- The bridge: a toast pushes the entry, `null` dismisses it, a newer toast
  replaces the one showing without a second entry, and only `info` starts
  the countdown.

Not tested: the card's look.

## Versions

Reaches the desktop only: a line in `desktop/CHANGELOG.md`, and a bump of
the desktop version asked for when the work is done.

## Built 2026-10-09

As specified, with these details:

- **Where it lives.** `ui/FeedbackNotice` holds the bridge
  (`useFeedbackNotice`, mounted next to each `MapNoticeHost`), the reply's
  provisional card and `FEEDBACK_NOTICE_MS` — canvas 4a's "Undo 10 s", now
  the time for every `info` reply. The store's `UNDO_TOAST_MS` timer is gone.
- **The countdown starts over** when the pointer leaves the card, rather
  than resuming where it stopped.
- **A reply sits over the dialogs.** A notice stays under the docked panels
  (z-8); a reply lifts the host over the dialogs' overlay (z-50), because
  it often answers something done inside one — Settings, the pairing
  dialog. Only the card and the dots take clicks, so the empty sides of the
  narrower reply leave the map usable.
- **The session window** has no map. It mounts `MapNoticeHost inWindow`
  for its replies, top centre across the whole window. The website's demos
  mount the same as the window they stand for.

## Drawn 2026-10-09: `Feature - Notice toast` 3a–3e

The artboard arrived after the first build; where it differs from the
sections above, the artboard wins and the code follows it:

- **The card** (3a–3d): one line, 40 px tall, as wide as its text up to the
  column, a long message ending in …; no head line, no fill colour, a
  fainter hairline and a shorter shadow than the notice. The action is
  plain bright text, not the accent.
- **Timing** (3a, 3b): `info` goes after `FEEDBACK_NOTICE_MS`, one with an
  action (Undo) after `FEEDBACK_UNDO_MS`; the pointer over it holds it.
  Canvas 4a's longer Undo window no longer applies.
- **Every action ends the reply** (3c): Detail opens the errors log and
  closes the toast, the refused rewind's included, whose action is now
  labelled Detail too (3d).
- **The dots** (3a, 3c): a reply is not one of them. They count the
  notices it covers, all hollow, since none of them is showing; one covered
  notice draws no dots, as before. `noticeDots(count, covered)`.
