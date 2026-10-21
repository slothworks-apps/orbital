---
id: 2026-10-21-question-card-go-back-design
title: Question card — change an answer before it is sent
status: done
type: spec
domain: web
related:
  - 2026-09-20-interactive-decisions-design
tags:
  - detail-panel
  - settings
---
# Question card — change an answer before it is sent

Builds on `2026-09-20-interactive-decisions-design` (the `QuestionCard`).
Canvas: `Feature - Question Card.dc.html`, artboards 9e–9j (9e in situ,
9f states, 9g Desk, 9h Settings, 9i phone, 9j metrics/keys/behaviour —
the source of truth for every value and key not repeated here).

## Why

Today the card is answered top-down and each answer locks the moment it
is given; the answer to the last open question sends the whole card. Two
things keep going wrong, repeatedly:

- a misclick on an option is final;
- a later question makes an earlier answer wrong (question 3 shows that
  the answer to question 1 no longer fits), and there is no way back.

Claude Code's own CLI does not have this problem: its picker has a tab
per question plus a Submit tab, ←/→ move between them, and nothing is
sent until the review step is confirmed. Orbital should give the same
freedom.

## Behaviour

**Going back is always possible until the card is sent.** Any answered
question can be reopened and changed, from any point — while a later
question is open, and from the review step. Changing one answer does not
clear the others. This does not depend on the setting below.

**The review step is optional** — setting *Review answers before
sending*, **on by default**.

- **On:** answering never sends. Once every question has an answer, the
  card shows a review of all answers with a Send action. From the review
  any question can be reopened. Applies to every card, including a card
  with a single question (one click more than today, by choice).
- **Off:** answering the last question that is still unanswered sends
  the card, as today. Going back works until that moment.

**No tab row** (9f A). The stack of questions is the map: answered
questions sit above, collapsed to their answer, and the whole answered
block is the control that reopens it; the header ticks from 9b F index
the stack and a click on a tick opens that question (desktop only). The
first unanswered question is open; questions after it show only chip and
question and cannot be opened yet. One block is open at a time.

After a reopened question is answered again, the card moves to the first
question that still has no answer, or — when all are answered — to the
review (setting on) or sends (setting off). With the setting off,
re-answering an earlier question while a later one is still unanswered
does not send; only an answer that completes the card sends.

Reopening a question shows its current answer: the chosen option marked,
a multiSelect with its ticks restored, free text back in the Other…
field with the caret at its end (`readAnswer` already reads an answer
back). Re-answering replaces the old answer; esc or *Keep* (the phone's
44 px button) returns without a change. Unconfirmed multiSelect ticks of
a question that was open when another one was reopened are kept. A
multiSelect's confirm reads *Confirm n* when it does not send the card,
*Send n* only when it does.

**The Desk map's quick answer.** The Desk map's needs-input card offers
the options of a single single-select question as buttons
(`DecisionBlock` in `web/src/map/desk/DeskMap.tsx`). With review on, a
click there records the answer as a draft and opens the session's
detail panel on the review; nothing is sent from the map (9g). The
clicked chip takes the chosen state, the card is selected, one mono line
says the answer is a draft, and the pill stays NEEDS INPUT. A different
chip replaces the draft; the chosen chip again only opens the panel. The
Desk card never offers Send. With review off, the click sends at once,
as today. The planet map's popover offers no one-click options, so it
is unaffected.

Once the card is sent, it locks into today's answered form. Nothing
changes for answered history, read-only cards (terminal sessions, ended
sessions), or a subagent's refused question.

**Composer.** While a question is open (including a reopened one), typed
composer text answers *that* question, as today for the active one. While
the review is showing, the composer is a plain composer (no accent, no
"answers the question" hint) and ⏎ is held: typed text stays in the box,
is never folded into the answers, and becomes a normal reply after Send
— the 9c rule for a click that answers first. ⇧⇥ from the composer
focuses Send (9f D). The composer's send button stays disabled during
the review, on the desktop and on the phone (9i). A send that reaches the
store some other way while the review shows (the map's `/compact`, the
phone's go-back) is refused with a quiet toast and its text put back in
the composer — never sent, never folded into the answers.

**Send failure.** Today a failed POST takes the last answer back and
reopens the last question. With review on, a failure returns the card to
the review with all answers kept; with review off, it keeps today's
behaviour.

**Keyboard** (9j KEYS). ←/→ move between questions, 1–4 in the review
reopen question n, ⏎ on an answered block reopens it, ⌘⏎ sends from
anywhere in the card during the review. All only while focus is in the
card and never in a text field — the Other… field and the composer keep
←/→ and digits. Digits by physical key (`digitFromEvent`), no ⌥+letter.
After an answer focus moves to the first row of the next open block, or
to Send in the review, so ⏎ ⏎ on the last question is two presses.

## Setting

- Key `questions_review_before_send` in `DEFAULT_SETTINGS`
  (`server/src/db/database.ts`), value `'true'`, read client-side by the
  default-on convention `!== 'false'`.
- **One setting for both devices.** It is stored on the Mac and the
  phone obeys the Mac's value (`GET /api/settings` is already on the
  allowlist). The toggle lives in the desktop Settings; *my call:* the
  phone shows no toggle of its own — its settings screen holds only the
  phone's own preferences.
- The row sits in Settings → Sessions under a new `QUESTIONS` label,
  wording from 9h.

## State

Drafts are local to the device and not synced between devices (first
sent answer still wins; the loser's POST gets 404). Windows of one app
(the main window and a detached session window) share them: each write
is merged per decision id into what storage holds, and a window picks up
what another wrote through the `storage` event. They survive collapsing
the panel, switching sessions and **closing and reopening the window**:
they are kept in `localStorage` by decision id and removed once the
decision is settled — by `decision_resolved`, or on a fresh list when
the device that owns the decision answered and no longer waits on it (a
Mac that is asleep or did not answer keeps its drafts). What is new is *which
question is shown* — no longer derived as "the first unanswered" but a
separate per-decision cursor (a question index, or the review). The pure
rules move into `web/src/lib/questionCard.ts` and are tested there:
where the cursor goes after an answer, when an answer completes the
card, what sending requires.

**A draft is not a sent answer.** Today `decisionAnswers` holds both
what the window drafted and what it sent, and the card treats a
complete record as sent. With review on, a complete draft can sit
unsent, so the store separates the two (a draft map and a sent record,
or a sent flag per decision — builder's call). When the decision is
answered elsewhere (another window, the phone) the draft is dropped and
the card shows the real result. When the session is interrupted or ends
with the card unsent, the card locks to `UNANSWERED` (9d) and shows the
drafts dimmed, clearly never sent (9j drafts). An unsent draft is never
rendered as a sent answer. Every "is a question still open" check
(`DetailPanel`, `SessionComposer`, `sendPrompt`, `mobile/composer.ts`)
moves to the new cursor instead of "first unanswered".

`completedAnswers` still builds the POST body; the trigger moves from
"the last answer was given" to "the review's Send" (setting on) or "an
answer completed the card" (setting off).

## Scope

- **For whom:** everyone answering `AskUserQuestion` in an Orbital
  session.
- **Where it lives:** on by default, on purpose. Going back is not a
  setting — it only adds freedom. The review step is on by default too,
  for every card including a single-question one: the maintainer chose
  that because a misclick, or a later question that makes an earlier
  answer wrong, should never reach the model — which is better for
  everyone answering. The setting exists for whoever prefers today's
  one-click send; it is not the default.
- **What someone already using Orbital notices after updating:** cards
  no longer send by themselves; a review step appears before sending,
  and answered questions can be reopened. On the Desk map, a click on a
  needs-input card's option no longer answers: it records a draft and
  opens the session's panel on the review, where Send is.
- **What can be set:** *Review answers before sending* (on/off).

## Phone

Built for the phone too: the phone renders the same `QuestionCard`
(`SessionScreen`, `SubagentScreen`), so it gets going back and the
review with the shared component. It reads the setting from its Mac.

An older Mac returns no `questions_review_before_send`; the default-on
reading turns the review on, which needs nothing from the Mac — the
answer POST is unchanged. No `MAC_FEATURES` gate is needed.

On the phone (9i) a tap on an answered block is the only way to move;
there is no swipe and the header ticks are display only. Answered blocks
show `CHANGE` at all times (no hover), Send is full width in the thumb
zone.

## Testing

Pure rules in `questionCard.ts`: cursor movement after answer/reopen,
completion with the setting on and off (re-answering an earlier
question with a later one open must not send), review → Send builds the
same body as today. No tests of rendering or styling.

## Out of scope

- Changing an answer after the card has been sent.
- Syncing a draft between devices (Mac and phone, or two Macs).
- A per-device value of the setting.
