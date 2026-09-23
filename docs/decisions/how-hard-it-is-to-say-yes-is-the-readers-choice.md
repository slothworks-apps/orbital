---
id: how-hard-it-is-to-say-yes-is-the-readers-choice
title: How hard it is to say yes to a guarded request is the reader's choice
status: in-force
type: adr
domain: web
related:
  - 2026-09-23-permission-and-plan-decisions-design
  - settings-sections-split-by-kind
tags:
  - permissions
  - settings
---
# How hard it is to say yes to a guarded request is the reader's choice

## The problem

The CLI marks some permission asks `defaultToNo` — ones it judges no stray
keystroke should approve. Orbital honoured that only by refusing a one-key
answer and colouring the card differently; the click itself was the same click
as any other.

The canvas (`Feature - Transcript blocks` 20b C) draws a real brake: Approve
fills left to right over 900 ms of held pointer and commits at the end, and it
offers a documented alternative where the first press arms the button and a
second sends it.

A brake is a real cost, though, and who pays it is not uniform. A press-and-hold
is a poor thing to ask of anyone whose hands do not cooperate, and it has no
honest keyboard equivalent — holding Enter repeats a keystroke, it does not
sustain a gesture. Choosing one gesture for everybody means choosing wrong for
somebody.

## What was decided

**All three, chosen by the reader**, in `permission_guard_gesture`:

- `hold` — the canvas's gesture, and the shipped default.
- `confirm` — arm, then confirm. Identical from a mouse, a trackpad and a
  keyboard, which is why it exists as a choice rather than as a fallback.
- `single` — no brake at all.

**From the keyboard, `hold` behaves as `confirm`.** This is a deliberate
divergence rather than an omission: there is no keyboard gesture that means
"sustained", so the alternative would be leaving keyboard users with either no
brake or an unusable one.

**An unreadable value falls back to `hold`,** not to `single`. Every other
default-off setting in Orbital reads the opposite way; a safety is the one
place where a typo must not quietly remove the protection.

**The row lives in Settings → Permissions,** which had been an empty, disabled
nav item. Under [[settings-sections-split-by-kind]] that section's sentence is
"what a session is allowed to touch", and how consent is given is the gate on
exactly that — where Appearance owns only what is drawn. This is the row that
makes the section real.

**Unguarded asks are untouched.** They approve on one click whatever the
setting says. The setting is about how hard it should be to say yes to the
dangerous ones, not about adding a step to everything.

## What follows from it

**`single` is a supported answer, not a discouraged one.** Someone running
Orbital on their own machine, watching every card go by, is entitled to decide
the brake is not worth it. Offering the option and then nagging about it would
be worse than not offering it.

**The armed state is visible in more than words.** The button's border and fill
both step up (`BUTTON_ACCENT_ARMED`), so the changed label is not the only
signal — a label alone is easy to miss on a card you are already looking at.

**A card that settles mid-gesture leaves nothing running.** Both timers are
cleared on unmount, which is what happens when another window answers the
decision while a hold is in progress.
