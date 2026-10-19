---
id: a-finished-turn-is-done-not-needs-input
title: A finished turn is announced as Done, and only once it has settled
status: in-force
type: adr
domain: notifications
related:
  - what-a-session-waits-for-is-a-label
  - the-connected-phone-notifies-itself
tags:
  - notifications
  - mobile
  - desktop
---
# A finished turn is announced as Done, and only once it has settled

## The problem

The server's `needs_input` status covers two situations: something is parked
on the human (a permission prompt, a question, a harness gate waiting for an
OK), or the turn simply finished. The map tells them apart and says NEEDS
INPUT or DONE (`what-a-session-waits-for-is-a-label`). `SessionNotifier`
did not. Every `working → needs_input` transition became "Needs your input",
on the phone's banner, the phone's system notification, the phone wake and
the Mac's native notification.

A turn also often ends only for a moment. The harness sends its next step as
soon as a turn ends, and the CLI wakes itself when a background agent or
task reports back. The user was told a session needed them, opened it, and
found it working on its own.

## The decision

- A `needs_input` transition is held for a short settle period before it is
  reported. A session that leaves `needs_input` before then reports
  nothing.
- When the settle period ends, the notifier reads what the session's latest
  upsert says it wants. If it has a `pendingDecision` or a harness gate that is
  waiting, the notification says "Needs your input". Otherwise it says
  "Done". A session whose harness reviewer is reading its work reports
  nothing, because the reviewer comes back to it on its own.
- Both stay under the existing Needs input setting. Someone who turned it on
  to hear when a turn finishes still hears it, now with the right word.
- A session that stays in `needs_input` and only later asks for the human
  is held and settled again. This happens when the reviewer hands a harness
  gate back to the user, or when a question follows a turn already reported
  as Done. No status transition carries that ask, and the earlier settle
  reported Done or nothing. It is held only when the latest upsert flips
  from not asking to asking and no report is already held, so an ask that
  was already reported is not repeated.
- Notifications carry a `kind`, so consumers stop comparing body strings.
  The phone's amber needs-input banner is reserved for the `needs_input`
  kind.
- The map and the notifier share one predicate, `asksForHuman` in
  `shared/src/parked.ts`, for "something is parked on the human". The
  notifier keeps one exception of its own: a gate the reviewer is reading
  reports nothing.
- The relay's push text is neutral: "Orbital" / "A session has an update".
  The relay cannot read what a wake is about, and a wake is now sent for a
  Done as well as for a session that needs input, ends or fails. The old
  "A session needs your input" would be false for most of them. The text
  stays fixed and names no session, as before.

## Alternatives ruled out

- **Not announcing a finished turn at all.** A finished turn is the most
  common reason to want a notification while you are doing something else.
- **Only the settle period, keeping the old wording.** A session that
  finished and stayed finished would still claim to need an answer it does
  not need.
- **Keeping "A session needs your input" as the push text.** A push for a
  finished turn would repeat the mistake this decision fixes. The relay
  could tell the kinds apart only if the Mac told it, and the relay is
  meant to learn nothing about a session.
- **A status of its own for DONE on the server.** The status vocabulary is
  shared with terminal sessions and the CLI's registry. The label rule
  (`what-a-session-waits-for-is-a-label`) already splits the two from data
  the upsert carries.
