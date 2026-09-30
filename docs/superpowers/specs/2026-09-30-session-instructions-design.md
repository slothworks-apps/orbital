---
id: 2026-09-30-session-instructions-design
title: Session instructions — Orbital's tips and the user's own text, appended to every Orbital session
status: active
type: spec
domain: sessions
related:
  - 2026-09-21-settings-sections-design
  - settings-sections-split-by-kind
  - 2026-09-30-narrate-out-of-band-design
  - 2026-09-20-interactive-decisions-design
  - a-code-span-that-is-a-path-is-pressable
  - 2026-09-28-background-tasks-design
  - 2026-09-30-a-session-spawns-sessions-design
  - subagents-only-for-orbital-sessions
tags:
  - server
  - runner
  - settings
  - system-prompt
---
# Session instructions

## Problem

Orbital renders some of what a session does better than a terminal
would: an `AskUserQuestion` call is a card with buttons, a path in a code
span opens the file, a background command gets a row with live output and
a stop button. The model does not know any of that. It writes a numbered
list and asks for a number, reports a path in a sentence, runs a ten
minute test suite in the foreground. The user pays for the gap every
turn, and the only lever today is a CLAUDE.md in every project, which
also reaches terminal sessions that gain nothing from it.

## Rule

Every session Orbital runs itself gets an appendix to its system prompt,
built from two layers:

- **Orbital's tips** — short instructions shipped with the app, each
  telling the model one thing Orbital can do and how to make use of it.
  On by default, one switch for the whole layer.
- **The user's instructions** — free text the user writes once, applied
  to all Orbital sessions. Off until there is text; keeps its own switch
  so the text can be parked without deleting it.

Terminal sessions get nothing. They are not started by Orbital and there
is no honest way to reach their prompt; the sessions that matter are the
ones Orbital starts ([[subagents-only-for-orbital-sessions]]).

## 1. How the appendix reaches the session

The runner already composes `systemPrompt` at every start as the
`claude_code` preset with an optional `append`: today that appendix is
the Narrate commentary prompt, read from the settings store through a
`commentary` dep ([[2026-09-30-narrate-out-of-band-design]]). This spec
makes the appendix a composed string and moves its assembly out of the
runner.

**Preset plus append, never a replacement.** Replacing the preset would
drop the CLI's own instructions and its CLAUDE.md loading. The appendix
sits after the preset, and `settingSources` stays as it is.

**One composer.** A new module, `server/src/runner/sessionInstructions.ts`,
holds the tip list and a pure function that turns settings into the
appendix:

```
composeAppendix({
  tipsOn: boolean,          // session_instructions_tips
  tipsOff?: string[],       // reserved, see § 6; nothing passes it yet
  commentary: boolean,      // narrate_commentary
  customOn: boolean,        // session_instructions_custom
  customText: string,       // session_instructions_custom_text
}): string | null
```

The blocks, in order, separated by a blank line:

1. every tip, in the order of `SESSION_TIPS`, while `tipsOn` (minus any
   id in `tipsOff`)
2. the Narrate commentary prompt, while `commentary`
3. the user's text, trimmed, while `customOn` and the trim is non-empty

The user's text goes last so that, where it contradicts a tip, it wins:
later instructions carry more weight, and the user's word should be the
last one. When no block survives the function returns `null` and the
runner sends the bare preset, exactly as today.

**The runner takes one dep instead of `commentary`.**
`appendix?: () => string | null`, read at every `start` — a fresh
session, a revive after sleep, and a session started by
`spawn_session` alike, since all three go through `start`.
`server/src/index.ts` wires it as a closure over the settings store that
calls `composeAppendix`. The `commentary` dep and the runner's
`NARRATE_COMMENTARY_PROMPT` constant move into the composer; the runner
tests that assert on the commentary string move with them.

**When a change applies.** At the next start. A session whose process is
awake keeps the appendix it started with until it sleeps
(`SLEEP_AFTER_IDLE_MINUTES`) or is ended; the same rule the commentary
switch has, and the Settings copy says so.

**Not the titler, not the narrator.** Both run their own queries with
their own system prompts on Orbital's behalf. They are not sessions and
the user does not talk to them.

## 2. The tips

Each tip is an object `{ id, title, text }` in `SESSION_TIPS`, a
constant in server code, not a row in the database: tips change with
the version of Orbital and the user never edits them, so there is
nothing to store. `id` is stable once shipped, because a later per-tip
switch will store it (§ 6); `title` heads the tip in the Settings
preview; `text` is what the model reads. The list is a list, not one
string, so a fourth tip is one entry and nothing else, and a per-tip
switch later is a filter on it.

**The array's order is the order.** Tips ship as one unit with the code,
so their sequence is versioned with them and reviewed in the same diff;
a separate ordering field would say the same thing twice. The composer
emits them as written and the preview shows the same sequence.

| id | title | text |
|---|---|---|
| `ask-user-question` | Choices through AskUserQuestion | When you offer the user a choice between options, call the AskUserQuestion tool. Do not write a numbered list and ask for a number: Orbital shows the tool call as a card with buttons, and a list in prose is not clickable. |
| `paths-in-code-spans` | Clickable file paths | Refer to a file as its path, optionally with `:line`, alone inside an inline code span. Orbital turns such a span into a link that opens the file; a path inside a sentence or a command is plain text. |
| `long-commands-in-background` | Long commands in the background | Run commands that take more than a moment — test suites, builds, dev servers, watchers — in the background. Orbital lists background tasks with their live output and lets the user stop each one; a foreground command shows nothing until it ends. |

Wording is part of the implementation, not of this spec: the texts above
are the first draft and may be tightened while building, as long as each
keeps the shape *do X, because Orbital does Y*. A tip that has to explain
Orbital at length is too big; the model needs the rule and the reason,
not the feature.

## 3. Settings

Under [[settings-sections-split-by-kind]] this is a *Sessions* matter: it
changes what happens to a session, not what is drawn. *Sessions* gains a
third group after `CLEAR & LIFECYCLE`:

```
INSTRUCTIONS   Orbital's tips             toggle · expandable read-only tip list
               Your instructions          toggle · multi-line text field
```

**Orbital's tips.** The row's toggle is the layer switch. The row expands
to show every tip's title and its full text, read-only, so the user can
see exactly what is sent without being able to edit it there. The list
comes from the server (§ 4), never from a copy in the web bundle: the
preview must show what the running server sends.

**Your instructions.** A toggle and a multi-line field. The field saves
a moment after typing stops, with the same debounce the *Claude
directory* field uses, through the same `PATCH /api/settings` every
other row uses, and raises the header's *saved · just now* like any
preference change. The
description says the text is appended to every session Orbital starts,
that it applies from the next start, and that a per-project instruction
belongs in that project's CLAUDE.md instead.

**Built from what the canvas already has, without a new artboard.** The
rows are the existing `Row` and `Toggle`; the disclosure follows the
collapsible preview under *Default planet size*; the text field takes
the composer's textarea styling without its toolbar. Nothing here is a
new pattern, only a new combination, so the artboard is not drawn up
front. If the built result reads as foreign to the dialog, this is the
prompt to give Claude Design and the rows then follow the artboard:

> In `Orbital.dc.html`, Settings › Sessions (canvas 1h style), add a third
> group after `CLEAR & LIFECYCLE` with the mono kicker `INSTRUCTIONS`.
> Two rows in the existing `Row` layout (title, description, control on
> the right). Row 1 *Orbital's tips*: a toggle on the right; below the
> description a collapsed "Show the tips" disclosure that expands into a
> read-only list of three items, each a short title and two lines of body
> text in the description ink. Draw the collapsed state, the expanded
> state, and the layer-off state where the expanded list is dimmed. Row 2
> *Your instructions*: a toggle on the right; below the description a
> multi-line text field of about five lines, empty state with a
> placeholder, and filled state. Constraints: reuse the existing toggle,
> disclosure and text field styles from the canvas; no new colours; the
> group must read as part of Sessions, not as a new section.


## 4. Keys and routes

Three settings rows, seeded in `DEFAULT_SETTINGS` like every other:

```
session_instructions_tips           'true'
session_instructions_custom         'true'
session_instructions_custom_text    ''
```

`session_instructions_custom` defaults on so that typing text is enough:
the toggle exists to park the text, not to arm it.

`PATCH /api/settings` needs no change; it stores what arrives. The custom
text has no server-side cap. It is the user's own prompt on their own
machine, and a cap would only turn a long prompt into a silent
truncation.

**One new route.** `GET /api/session-instructions/tips` returns
`{ tips: [{ id, title, text }] }` from `SESSION_TIPS`, in its order, the
same array the composer reads. The Settings row fetches it when *Sessions* is opened.
Until it answers, the row shows the toggle and no list, for the same
reason the *General* read-only rows wait for `/api/health`: a placeholder
list could be read as the real one.

## 5. Testing

Worth a test, in `server/test`:

- `composeAppendix`: every switch alone, all off, the empty and
  whitespace-only custom text, the block order when all three are on,
  `null` when nothing survives, and one case with `tipsOff` naming a
  known and an unknown id so the reserved parameter is not dead code.
  The blank-line separator is asserted once, in the all-on case.
- `SESSION_TIPS` itself: every `id` is unique.
- the route returns the same ids in the same order the composer emits,
  so the preview and the appendix cannot drift apart.
- the runner passes the dep's return as `append` and sends the bare
  preset on `null`. This replaces the existing commentary assertions
  rather than adding to them.

In `web`, nothing: which section renders the rows and how the textarea
looks are not regressions a test can catch.

## 6. Out of scope

- **A per-project prompt.** That is what a project's CLAUDE.md is for,
  and the CLI already loads it.
- **Tips for terminal sessions.** No route to their prompt.
- **A switch per tip.** Discussed and deferred: three tips do not earn
  three more controls yet. The design leaves the door open without
  paying for it now — tips carry stable ids, the composer takes
  `tipsOff`, and when the switch is built it stores the ids that are
  *off* under a new key (`session_instructions_tips_off`, comma-separated),
  so a tip added in a later version is on for everyone who has not
  touched it. Nothing writes that key today and it is not seeded.
- **Editing a tip's text.** A user who wants a different wording turns
  the layer off and writes their own version in *Your instructions*,
  which keeps the shipped text updatable.

## 7. What ships

Server, web and therefore the DMG all change; the version question is
asked when the work is done, as the project rule requires.
