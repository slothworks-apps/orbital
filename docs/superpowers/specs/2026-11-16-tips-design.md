---
id: 2026-11-16-tips-design
title: Tips — short hints on the map about what Orbital can do
type: spec
status: active
domain: desktop
related:
  - why-orbital
  - 2026-10-19-whats-new-design
  - an-orbital-session-drives-orbital-through-a-catalog
tags:
  - tips
  - map
---
# Tips

Orbital keeps growing, and much of what saves the most work is invisible
until someone tells you: a session can start other sessions, one session can
run several others, a terminal session can be taken over. WHAT'S NEW tells
you about a feature once, the day it arrives; after that it is easy to
forget it exists.

A **tip** is one or two sentences about something Orbital can do that makes
running several sessions easier, with at most one button that tries it.
Tips sit behind a small button on the map, above the error log, and wait
there until you look.

## Scope

- **Who it is for:** everyone using Orbital on the Mac, most of all someone
  who has used it for a while and never found the features that are not on
  screen until asked for.
- **Where it lives:** on by default. It is a small, quiet button beside the
  one that is already there, and a tip that has to be turned on first would
  reach only the people who already read Settings.
- **What someone already using Orbital notices after updating:** a new
  button in the map's corner column, above the error log's `!`, with a quiet
  dot on it until they have seen every tip.
- **What can be set:** nothing. The button cannot be hidden, like the error
  log's.

## Behaviour

### The button

- It sits in the map's zoom column (`MapShell`), above the error log
  button, in every map theme.
- While there is a tip this Mac has not shown yet, it carries a quiet dot:
  no number, no motion, no colour that reads as an alarm. A fresh install
  starts with the dot; a later version that adds a tip brings it back.
- It never opens by itself, and a tip never appears anywhere else: not as a
  map notice, not in the New session dialog, not as a notification.

### What it opens

- One tip at a time, in a card beside the column, with Next and All tips.
  The card offers the tips this Mac has not shown yet first, then the rest
  in list order; Next after the last one starts over.
- All tips opens a dialog, in the error log's dialog shell, with every tip
  grouped under a heading; the ones not seen yet are marked.
- One thing is open at a time: the card, the All tips dialog or the error
  log. Opening one closes the other.
- A tip counts as seen the moment it is on the card, and every tip counts as
  seen once All tips is opened. Nothing is marked by time or by hovering.
  When none is left unseen, the dot goes.

### A tip

- One or two sentences, in the app's language (English).
- At most one action, optional. Two kinds:
  - open a place in Orbital: a Settings section, the New session dialog,
    Stats;
  - open New session with a prompt filled in, for tips that are done by
    asking a session.
- An action only opens something; it never starts a session or sends a
  message. Using it closes the card. It does not hide the tip; the tip is
  seen already.

### Where tips come from

- A hand-written list in `web/`, in the order they are offered. Each tip has
  a stable id and a group (the heading it sits under in All tips). What has
  been shown is a server setting on this Mac listing those ids, beside
  WHAT'S NEW's.
- A new tip is added in a PR like any other change. Nothing is fetched and
  nothing leaves the Mac.
- A tip names only what works on a default install. A feature in Labs is
  said to be in Labs; a feature behind Experimental gets no tip.

## The first tips

Draft wording; the final text is settled in the PR. Listed in the order they
are offered.

Groups: Sessions (`spawn-session`, `orchestrate`, `drive-orbital`,
`take-over`), Starting a session (`worktree`, `harness`, `profiles`),
Keyboard and input (`ide-selection`, `shortcuts`), Elsewhere (`phone`,
`stats`).

| id | tip | action |
|---|---|---|
| `spawn-session` | A session can start another Orbital session by itself. Ask it to hand a side task to a new session, in a worktree of its own when it touches the same repo. | — |
| `orchestrate` | One session can run several: it splits the work, starts a session for each part, sends them messages and reads their results. | New session with a prompt to split a task across sessions |
| `worktree` | New session can create a git worktree and name its branch, so sessions working in one repo do not step on each other. | Open New session |
| `harness` | A harness gives a session a checklist to follow: it ticks each step and can stop for your review. A session can write the template for you. | Open Settings → Harness |
| `drive-orbital` | A session can change Orbital for you: settings, tags and tag rules. Ask it instead of clicking through Settings. | — |
| `take-over` | A session running in a terminal can be taken over: Orbital quits the CLI there and the conversation goes on here. | — |
| `phone` | Pair your phone to answer a waiting session when you are away from the Mac. | Open Settings → Devices |
| `ide-selection` | Text you select in your IDE arrives in the composer as a quoted block. | — |
| `profiles` | Several Claude accounts side by side: each profile has its own sign-in, and New session picks which one a session runs on. | Open Settings → Profiles |
| `stats` | Stats show what your sessions cost, by period, project and model. | Open Stats |
| `shortcuts` | Every keyboard shortcut is listed in one place. | Open Settings → Shortcuts |

## Phone

Left out on purpose, with no idea to build it later. The phone is an
extension of the Mac for answering and following sessions; most tips are
about starting and organising work, which happens on the Mac, and the phone
has no room to spare for a hint button.

## Design

`Feature - Tips` in the Claude Design artifact, artboards 68a–68e: a bulb
button above the error log's `!` in the same shell, an accent dot for unseen
tips, the one-tip card beside the column, the All tips dialog, and how both
sit with the error log and the session panel. The tips on the canvas are
samples; the list is the one above.

## Not in this feature

- Tips that appear on their own, on the map, in New session or as a
  notification.
- Tips chosen by what you are doing at the moment.
- Hiding a single tip for good, or a setting to hide the button.
- Tips on the phone.
