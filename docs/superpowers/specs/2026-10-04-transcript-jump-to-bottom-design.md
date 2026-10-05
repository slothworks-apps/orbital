---
id: 2026-10-04-transcript-jump-to-bottom-design
title: The transcript shows the way back to its bottom
type: spec
status: done
domain: web
related:
  - why-orbital
  - the-transcript-scrolls-on-its-own-raf-loop
  - transcript-pages-older-history-on-scroll
tags:
  - transcript
  - motion
---

# The transcript shows the way back to its bottom

## Why

The transcript sticks to its bottom while the reader is there: a new
message is followed with the eased scroll in `panels/transcriptMotion.ts`.
Once the reader scrolls up to read older rows, it lets go, and that is
right — but from then on nothing says where the bottom is or that anything
has arrived below. New rows pile up out of sight, the way back is a long
manual scroll, and a prompt sent from the composer while scrolled up lands
out of view as well.

The reader should always have a one-click way back to the bottom, and should
be able to see — quietly — that something new is waiting there.

## Behaviour

1. **When it shows.** The indicator is shown exactly when the transcript is
   not stuck to its bottom, so it and the following can never disagree: it is
   visible exactly when a new message would *not* be followed. The stick flag
   has two thresholds (`stuckAfterScroll`, canvas 43e): it lets go once more
   than `LET_GO_BELOW_PX` is hidden below the viewport and sticks again only
   under `STICK_BELOW_PX`. Between them it keeps what it was, so a position
   on the edge cannot flicker the indicator. It is therefore never drawn at
   the bottom, and no room is reserved under the last row. Positions produced
   by the scroller's own animation do not change it, for the reason the stick
   flag ignores them (see [[the-transcript-scrolls-on-its-own-raf-loop]]).

2. **Two states, no number.** The indicator is either *above the bottom* or
   *above the bottom, with something new below*. It never shows a count.
   `why-orbital` rules out counters that pile up, and a number growing while
   someone reads history is exactly that.

3. **What counts as new.** A row counts when it arrives at the bottom while
   the transcript is not stuck — the same trailing run `enteringKeys`
   already computes for the arrival animation. Therefore none of these count:
   a page of older history landing above (`enteringKeys` excludes a
   prepend), folding or unfolding a run, an image finishing its load, the
   footer changing.

4. **When "new" clears.** Reaching the bottom by any route — the
   indicator, a manual scroll, a send — clears it. Scrolling up again starts
   from *above the bottom*, not from *new*.

5. **What a click does.** It sticks the transcript again, so the indicator
   starts leaving at the click, and calls `Scroller.jump()`: a timed
   ease-out (`jumpDurationMs`) that re-reads the bottom every frame. Past two
   viewports it first lands just short of the bottom and eases the rest.
   Under `prefers-reduced-motion` it is instant. In the session panel, focus
   then moves to the composer; on the phone, focus and the keyboard are left
   alone. ⌘↓ (`session.latest`) is the same action, from the transcript or
   the composer, while there is somewhere to jump to.

6. **Sending re-sticks.** When the user's own optimistic turn (a `local:`
   user message, see `isPendingTurn` in the store) arrives among the
   entering rows while the reader is above, the transcript sticks to the
   bottom again and jumps there, as a click would. Sending is choosing to continue the
   conversation. This is detected inside `TranscriptView` from the rows it
   is given, so it needs no new prop and covers every composer that goes
   through `sendPrompt`, the phone's included.

7. **Reset.** A `resetKey` change (switching session or subagent) puts the
   indicator in its hidden state with nothing new, because arrival already
   jumps to the bottom.

8. **Calm.** The indicator appears and disappears with a gentle transition.
   The change into *new* is a slow state change, made once. Nothing blinks,
   pulses, bounces or repeats, and nothing makes a sound (`why-orbital`,
   "Nothing blinks", "Silence by default"). The ink is neutral, never the
   accent or the amber of a session waiting for input. Screen readers hear
   "New messages below" once, politely, when *new* starts.

9. **Where.** Everywhere `TranscriptView` is used: the session transcript,
   the subagent panel and the phone's session screen. It applies to terminal
   sessions as well as Orbital's own: reading is not driving.

## Shape of the change

- A small pure function in `panels/transcriptMotion.ts` owns the state
  transitions: given the previous state and an event (scrolled to/away from
  the bottom, rows entered while unstuck, own turn entered, reset), it
  returns the next state. This is the piece unit tests cover.
- `TranscriptView` keeps the stick flag as a ref (it is read in layout
  effects and must not cause renders), and mirrors the indicator's state
  into React state only when it changes, so scrolling does not re-render the
  transcript on every frame.
- The indicator is a component of its own (`panels/JumpToBottom.tsx`),
  rendered by `TranscriptView` outside the scroll container so it does not
  scroll with the rows. `TranscriptView`'s `surface` prop picks its
  geometry: the session panel, the subagent panel or the phone.

## Look

Canvas `Feature - Jump to bottom` (43a–43e) is the design. *Above* is a round
↓ at the bottom-right of the transcript viewport, the emptiest corner of
ragged-right prose. *New* widens it leftwards to say "NEW BELOW" while the
arrow stays put. A scrim fades the last rows into the panel under it. On the
phone it is larger, with a 48px touch target.

## Phone

Built for the phone too, with nothing extra: `mobile/screens/SessionScreen`
renders the same `TranscriptView`, so the indicator and the re-stick on send
reach the phone with the component. No route, no WS topic and no allowlist
change is needed. What differs is only the geometry (canvas 43c): a
touch-sized target anchored to the composer's top edge, clear of the offline
divider and the keyboard. ⌘↓ does not exist there.

## Testing

- Unit tests for the state-transition function: hidden → above on scrolling
  away; above → new on rows entering; new stays new on more rows; any state →
  hidden on reaching the bottom; reset → hidden. And for the two thresholds
  of `stuckAfterScroll`.
- No render tests: whether the indicator shows its props is not worth a test
  (see the root `CLAUDE.md`), and jsdom computes no scroll metrics.
- Checked by hand in the built app and on the phone emulator: scroll up in a
  working session, watch rows arrive, click back, send from scrolled-up.

## Out of scope

- Background-task output and the file viewer (43, Scope).
- Jumping to the first row that arrived rather than to the bottom.
- Saying *what* arrived (a question waiting, a session ended). The map and
  the session's own cards already say that.

## Not taken from the canvas

- 43a's composer hint reads "⏎ send · ⌘↓ latest". The real hint carries
  more (newline, paste image) and ⌘↓ is listed in Settings → Shortcuts, so
  the hint is left as it is.
- 43e keeps *new* if the reader leaves the bottom again before
  `FORGET_NEW_MS` has passed. Here leaving the bottom always starts from *above*.
