---
id: 2026-10-04-transcript-jump-to-bottom-design
title: The transcript shows the way back to its bottom
type: spec
status: draft
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

1. **When it shows.** The indicator is shown whenever the transcript is not
   at its bottom, and hidden when it is. "At the bottom" is the same test
   that decides stick-to-bottom today (`isNearBottom` with its default
   threshold), so the indicator and the following can never disagree: the
   indicator is visible exactly when a new message would *not* be followed.
   Positions produced by the scroller's own animation do not change it, for
   the reason the stick flag ignores them (see
   [[the-transcript-scrolls-on-its-own-raf-loop]]).

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

5. **What a click does.** It calls the existing `Scroller.toBottom()`,
   without new motion: eased over a short distance, an instant jump past
   `INSTANT_ABOVE_VIEWPORTS`, always instant under `prefers-reduced-motion`.
   The transcript is stuck to the bottom again, and the indicator goes away
   when the bottom is reached.

6. **Sending re-sticks.** When the user's own optimistic turn (a `local:`
   user message, see `isPendingTurn` in the store) arrives among the
   entering rows, the transcript sticks to the bottom again and scrolls
   there, as a click would. Sending is choosing to continue the
   conversation. This is detected inside `TranscriptView` from the rows it
   is given, so it needs no new prop and covers every composer that goes
   through `sendPrompt`, the phone's included.

7. **Reset.** A `resetKey` change (switching session or subagent) puts the
   indicator in its hidden state with nothing new, because arrival already
   jumps to the bottom.

8. **Calm.** The indicator appears and disappears with a gentle transition.
   The change into *new* is a slow state change, made once. Nothing blinks,
   pulses, bounces or repeats, and nothing makes a sound (`why-orbital`,
   "Nothing blinks", "Silence by default").

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
- The indicator is a component of its own, rendered by `TranscriptView`
  outside the scroll container so it does not scroll with the rows.

## Phone

Built for the phone too, with nothing extra: `mobile/screens/SessionScreen`
renders the same `TranscriptView`, so the indicator and the re-stick on send
reach the phone with the component. No route, no WS topic and no allowlist
change is needed. What differs is only layout, which belongs to the design
brief below: a touch-sized target, and a place clear of the composer, the
offline divider and a parked decision card.

## Testing

- Unit tests for the state-transition function: hidden → above on scrolling
  away; above → new on rows entering; new stays new on more rows; any state →
  hidden on reaching the bottom; own turn → hidden and stuck; reset → hidden.
- No render tests: whether the indicator shows its props is not worth a test
  (see the root `CLAUDE.md`), and jsdom computes no scroll metrics.
- Checked by hand in the built app and on the phone emulator: scroll up in a
  working session, watch rows arrive, click back, send from scrolled-up.

## Out of scope

- A keyboard shortcut. `End` already scrolls the container natively.
- Jumping to the first row that arrived rather than to the bottom.
- Saying *what* arrived (a question waiting, a session ended). The map and
  the session's own cards already say that.

## Design brief for Claude Design

Placement and look are designed in Claude Design. The prompt to give it:

> Design a "jump to bottom" indicator for Orbital's session transcript, for
> the desktop detail panel, the subagent panel and the phone's session screen
> (artboards for each).
>
> It has two states and is otherwise hidden:
> 1. *Above the bottom* — the reader has scrolled up; the indicator offers the
>    way back.
> 2. *Above the bottom, something new below* — rows arrived while the reader
>    was away.
>
> Constraints:
> - No number or count, ever. The second state is a quiet difference from the
>   first, not a badge.
> - Calm per Orbital's principles: no blinking, pulsing, bouncing or
>   attention-pulling colour. Appearing, disappearing and the change into the
>   second state are slow, gentle transitions. No alarm or accent colour
>   reserved for sessions waiting on the user.
> - It floats over the transcript and must not cover the last row's content
>   in a way that hides text being read, the composer, a parked decision card
>   (Allow/Deny), or the phone's "NOTHING NEWER · MAC ASLEEP" divider.
> - On the phone it is a comfortable touch target and sits clear of the
>   composer and the on-screen keyboard.
> - It belongs to the transcript surface (opaque docked panels, not frosted
>   glass), and must read on every map theme.
> - It has an accessible label ("Jump to the latest message", and a variant
>   for the second state).
>
> Show both states on desktop and phone, and the transition between them as
> a short note on timing and easing.

## Next

Once the Claude Design artboards exist, implement against them and set this
spec to `done`.
