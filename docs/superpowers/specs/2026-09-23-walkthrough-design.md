---
id: 2026-09-23-walkthrough-design
title: The walkthrough — a guided reading of what a session changed
status: done
type: spec
domain: sessions
related:
  - walk-me-through-what-the-agent-did
  - walkthrough-narration-is-a-turn-in-the-session
  - an-orbital-tag-marks-a-walkthrough-turn
  - 2026-09-23-edit-diffs-in-the-transcript
  - one-syntax-palette-for-all-code
  - 2026-09-18-transcript-folding-design
  - 2026-09-22-subagent-transcript-panel-design
  - 2026-09-23-ide-bridge-design
  - subagents-only-for-orbital-sessions
  - selected-session-lives-in-the-url-query
  - ephemeral-title-queries
tags:
  - walkthrough
  - transcript
  - review
---
# The walkthrough — a guided reading of what a session changed

An agent finishes a piece of work and the person who dispatched it has to
stand behind it: explain it in a review as their own. Today the only route is
the diff, read backwards. Orbital holds the two halves nobody else joins — the
transcript and the working tree — and the walkthrough is the join, read as a
guide, in the order the work happened. The idea and its arguments are
[[walk-me-through-what-the-agent-did]]; this document is what gets built.

Agreed in chat on 2026-09-23, before anything was written:

- **A separate page, not a mode of the transcript.** A wizard, full screen,
  only for walkthroughs.
- **Mechanical spine, model on top.** The steps and their attribution are
  computed from the transcript and never lie about which turn wrote a line.
  A model may regroup steps into intents and narrate them, on request.
- **You can ask the session from a step.** The walkthrough is not read-only;
  a question about a step goes to the session that did the work.
- **Orbital's own sessions only.** Asking and narrating need a session the
  Runner can continue, and terminal sessions cannot be. Orbital is meant to be
  the developer's right hand, not a viewer for the terminal, so the feature is
  not offered there at all rather than offered thinner.

## Vocabulary

- **A writing call** is a `tool_use` whose tool is one of `EDITING_TOOLS`
  (`Edit`, `Write`, `NotebookEdit`), or an `Agent` dispatch whose own
  transcript contains a writing call.
- **A run** is a maximal sequence of `tool_use`/`tool_result` messages with no
  assistant text between them.
- **A step** is a writing call, or a group of them, drawn from a run that
  contains at least one. A run with no writing call is not a step. Within one
  run, each writing `Agent` dispatch is its own step, and the run's direct
  writing calls (`Edit`, `Write`, `NotebookEdit`) form one further step; a run
  can yield several steps this way, and there is no gap between them. Every
  step a run yields shares its **narration**: the assistant text immediately
  before the run, in the same user turn.
- **A gap** is everything between two steps that is not a step: the reads,
  searches, shell commands and subagents that changed nothing. A gap is kept
  as a summary, never dropped.

## The spine

`server/src/walkthrough/spine.ts`, pure, over the `ChatMessage[]` the
transcript route already produces (`entriesToMessages`). One function, taking the session's messages and each dispatched subagent's messages keyed by the `Agent` call's `toolUseId`:

```ts
buildWalkthrough(messages: ChatMessage[], subagents: Map<string, ChatMessage[]>): Walkthrough
```

```ts
interface Walkthrough {
  steps: Step[];
  /** Steps and gaps interleaved, in transcript order. */
  timeline: Array<{ kind: 'step'; id: string } | Gap>;
  files: FileSummary[];
  /** Present when a narration turn was found in the transcript (§ Narration). */
  narration: Narration | null;
  /** A narration turn was found but its answer held no parsable JSON block. */
  narrationFailed: boolean;
  /**
   * The last narrate turn has no answer yet and its window is still open.
   * `narration` and `narrationFailed` then stay those of the last *answered*
   * narrate turn, so the rail keeps its intents while the new one is written.
   */
  narrationPending: boolean;
  /** Ids of the last message the spine saw — what "stale" is measured against. */
  lastMessageId: string | null;
}

interface FileSummary {
  path: string;
  /** Every step that wrote this path, in order. */
  steps: string[];
  /**
   * No line counts here. The close screen shows the sum of the steps'
   * `changeCounts`, over `Edit`s and created files only — an overwrite has
   * one side and adds nothing — and the browser computes that sum from the
   * steps' calls, because the diff lives in the browser (§ The spine). It is
   * a sum of the changes shown, not the file's net difference: Orbital does
   * not hold the file's contents and will not claim a "net 0".
   */
  /** The first step created the file (`Write`, outcome `created`). */
  created: boolean;
  /** The last step's fate on this path, if any — `reverted` is what the close screen gathers. */
  fate: 'revised' | 'reverted' | null;
  /**
   * A call on this path failed (`isError`) and no later successful writing
   * call on the same path followed it, in transcript order, sub-steps
   * included. Retrying a failed `Edit` is routine; the retry closes it. The
   * close screen lists what is left under still open.
   */
  notApplied: boolean;
}

interface Step {
  /**
   * The `toolUseId` of the first writing call in the step. Stable while the
   * transcript grows, which the ordinal is not — a question asked about step
   * 3 must still find its step after the answer added a step 9.
   */
  id: string;
  ordinal: number;
  /** The assistant text that opened the run; empty when the run followed a user turn directly. */
  narration: string;
  /** The writing calls, as the transcript carries them. The browser builds the diffs. */
  calls: Array<{ call: ChatMessage; result: ChatMessage | null }>;
  /**
   * Reads, searches and commands inside the run, folded to a count per tool.
   * A run's non-writing calls fold into the first step it yields; a step
   * after the first in the same run carries none.
   */
  folded: Record<string, number>;
  /** A dispatch whose sub-steps these are; null for the session's own writes. */
  subagent: { name: string; prompt: string; steps: Step[] } | null;
  /** How later steps treated this one's work (§ Blind alleys). */
  fate: Array<{ kind: 'revised' | 'reverted'; byStep: string; path: string }>;
  /** Questions asked about this step and their answers (§ Asking). */
  questions: Array<{ question: string; answer: string | null; messageId: string }>;
  /**
   * From the earliest of this step's own calls to the latest of its own
   * results — except the first step a run yields, which also spans the
   * run's non-writing calls, since its `folded` claims them too. A later
   * step from the same run spans only its own calls. Null when none of them
   * carries a timestamp, never estimated.
   */
  durationMs: number | null;
}

interface Gap {
  kind: 'gap';
  durationMs: number | null;
  /** Tool calls between two steps, folded to a count per tool. */
  folded: Record<string, number>;
  /** Subagents dispatched here that changed nothing. */
  subagents: string[];
  /** Assistant text in the gap, joined — what the agent said it was doing. */
  said: string;
}
```

**Diffs are not computed on the server.** The step carries the raw
`tool_use` and `tool_result` messages, and the page builds the change with
`describeFileChange` and draws it with `ChangeView`, exactly as `ToolRow`
does. Two diff implementations would drift; the web already owns the one that
matches the transcript.

**A subagent's writes are a step in the parent's story.** An `Agent` call
whose transcript holds writing calls becomes its own step (§ Vocabulary)
whose `subagent` field carries the dispatch prompt and the agent's own steps,
built by the same function over the agent's messages. The agent's reads fold
into that step, not into the parent's gap. An agent that wrote nothing is
named in the enclosing gap. A run that dispatches more than one writing agent,
or mixes a writing dispatch with the run's own direct writes, yields one step
per dispatch plus one step for the direct writes — adjacent in the timeline,
narration shared, no gap between them. Subagent transcripts come from
`readSubagentEntries`, the reader the stats already use.

**Nothing is stored.** The spine is rebuilt from the file on every request.
A live session yields a walkthrough "so far", and the same call a minute
later yields a longer one.

### Blind alleys

The point of a chronological walkthrough is that abandoned attempts stay
visible. Two are detectable mechanically, on `Edit` calls to the same path:

- **revised** — a later `old_string` contains this step's `new_string`, or
  the later `old_string` is contained in it. The work was kept and changed.
- **reverted** — a later `new_string` equals this step's `old_string`. The
  work was undone.

`Write` over a path an earlier step wrote is *revised*; a `Write` whose
content equals the earlier step's replaced text is *reverted*. Deletions by
shell command are not detected — Orbital will not parse `rm` out of a `Bash`
call, so a file removed that way simply stops appearing in later steps.

A call whose result is an error changed nothing, so it takes no part in
detection on either side: it neither gets a fate from a later call, nor gives
one to an earlier step.

Every detection names the step that did it, so the page can say "revised in
step 7" and link there. Anything subtler is the narration's job.

## Narration

The model layer. Decided in [[walkthrough-narration-is-a-turn-in-the-session]]:
the session itself is asked, as one more turn, rather than an ephemeral query
being fed the transcript. The model that did the work explains it from its own
context, the context is cached, and the mechanism is the same as asking a
question from a step.

**On request only.** A button on the cover starts it; nothing runs when the
page opens, because a narration is a turn on the owner's subscription. The
button is disabled by the same busy rule as the question field (§ Asking) —
mid-turn is `working` or a parked decision, never `needs_input`. When steps
have been added since the narration was written, the cover says so and offers
a new one; the old one is still shown against the steps it covers.

**The turn.** Orbital sends a user message whose whole text is a
`<orbital-walkthrough kind="narrate">` block (§ The wire format) listing the
step ids with their paths and first narration line, and asking for a single
fenced JSON block:

```json
{
  "intents": [
    { "title": "…", "summary": "…", "steps": ["<step id>", "…"],
      "considered": ["…"], "abandoned": false }
  ]
}
```

- `intents` group steps in order; an intent may hold one step or many.
- `considered` is what the model says it weighed and did not do — the
  material "did you consider Y?" asks for.
- `abandoned` marks an intent the model says it gave up on, which the spine's
  `fate` may or may not have caught.

**Reading it back.** The server finds the tagged user message and collects
its **answer window**: every assistant text up to the next user turn someone
typed, running past a tool run that wrote nothing and past a machine-only user
turn (a task notification, a reminder — wrapping with no typed text, no
command name and no walkthrough tag; a slash command is typed), and stopping at the first run with a writing call (§ Asking
has the same window, for a question's answer). Those
texts are never a step's narration or a gap's `said` — the window is read
once, for the tag that opened it, not folded into the surrounding story.

Within the joined answer, the first bare ` ``` ` or ` ```json ` fenced block
(the language tag read case-insensitively) that parses as JSON and carries an
`intents` array wins; any other block, or prose around it, is ignored. Every
step id the JSON names that the spine does not know is dropped; every step
the JSON does not name becomes its own intent with no summary. An answer
whose window holds no such block yields `narration: null` with a
`narrationFailed: true` flag on the walkthrough, and the page says the
narration did not come back rather than hiding the button. The last
*answered* narrate turn wins: while a newer one waits for its answer the spine
reports `narrationPending`, keeps the previous narration, and the cover says
*Narrating…* with the button disabled; a narrate turn whose window closed
without an answer (interrupted, superseded) changes nothing. The transcript is
the store; there is no table.

**In the transcript**, the turn folds behind a chip — `walkthrough · narrate`
— the way a command expansion does, because the parser treats the tag as one
of its noise blocks. Nothing typed, so the chip is the whole turn.

## Asking

Each step has a field. The question goes as a user message: the human text is
the question, and a `<orbital-walkthrough kind="ask" step="<id>">` block
carries the context — the path(s), the tool call uuids, and the change as the
transcript holds it, so the model can answer about the exact edit rather than
its memory of one. In the transcript the block folds behind `walkthrough ·
ask`, and the question reads as an ordinary user turn.

**Delivery** goes through the walkthrough's own route,
`POST .../walkthrough/ask { step, question }` (§ The page), which builds the
tagged text and hands it to the same delivery and revival the composer's
`POST /api/sessions/:id/messages` uses. Two things it refuses before that:

- **A session in the middle of a turn** — `working`, or parked on a decision
  (`pendingDecision`) — is `409 busy`, and the field on the page is disabled
  for the same reason. `needs_input` alone is *not* the middle of a turn: it
  is every live Orbital session's state between turns, which is exactly when
  a walkthrough is read, so it never refuses. A question injected into a
  running turn is not the question it appears to be.
- **A session live in a terminal** is `409 terminal_session`, though this
  case cannot be reached from the page — a walkthrough is never offered
  there at all (§ Where it is offered).
- A question naming a step the spine does not have, or holding no question
  text, is `400 unknown_step` / `400 missing_question`.

**The answer** is the assistant text collected in the tagged turn's answer
window (§ Narration, "Reading it back"). The page holds the session's WS
subscription as the detail panel does, so the answer streams under the
question on the step. On the next build of the spine, the question and its
answer attach to the step by the id in the tag, so a reopened walkthrough
shows the exchange where it happened. An answer that itself edits a file
produces a new step at the end, and the page says so.

## The wire format

[[an-orbital-tag-marks-a-walkthrough-turn]] decides that these turns are
recognised by a tag Orbital itself writes into the message text, not by a
table and not by their wording.

```
<orbital-walkthrough kind="narrate">
…steps…
</orbital-walkthrough>
```

```
<orbital-walkthrough kind="ask" step="<uuid>" n="3">
…context…
</orbital-walkthrough>
```

`step` is the id the spine joins on. `n` is the step's ordinal *at the time of
asking*, carried only so the transcript chip can say `step 3` without
rebuilding the walkthrough; it is never used to find the step.

`NOISE_BLOCK` in `server/src/transcript/parser.ts` gains the tag, so
`splitUserText` folds it in both producers (indexed and live). The chip label
comes from the `kind` and `n` attributes, read by a small helper next to
`splitUserText`. The transcript's `command` shape gains one optional field,
`walkthrough`, the parsed tag, and the spine reads that field rather than the
body.

**Only a top-level block is the turn's tag.** `splitUserText` reads the tag
from the `NOISE_BLOCK` match whose name is `orbital-walkthrough`, never from
the text at large. A tag quoted inside a `<system-reminder>`, a
`<command-contents>` or a `<task-notification>` — this repository's own spec,
ADR and tests contain the literal tag, and the CLI pastes file snippets into
user turns — is swallowed whole by its enclosing block and leaves an ordinary
user turn.

**Nothing inside the tag can close it.** Everything embedded between the open
and close tag — the ask turn's JSON body, and the paths and first narration
lines of both turns — has `</` written as `<\/` (`escapeInTag`). In the JSON
`\/` is a valid escape the model reads as `/`; elsewhere it reads the same to
a person. A step that edited a file containing `</orbital-walkthrough>`
therefore cannot end the block early and leak its tail into the question.

## The page

`/walkthrough/<sessionId>`, branched in `web/src/main.tsx` next to
`/stats`, parsed by a pure `parseWalkthroughRoute`. A real path because that
is how the other pages are done and the SPA fallback makes it free.

**Data:** `GET /api/sessions/:id/walkthrough` returns the `Walkthrough` above
plus the `ApiSession`. `404` when the id is unknown. A session with no writes
returns `steps: []`, and the page shows a cover that says so.

`GET /api/sessions/:id/walkthrough/summary` is the same parse, a smaller
answer — `{ steps, files, blindAlleys, subagents }` — for the header's entry
control (§ Where it is offered), which needs the count but not the spine.
Its `blindAlleys` counts steps a later step *reverted* only; the cover below
counts more (narration-marked abandonment too), so the two numbers can
differ, and the header shows only `steps` and `files` to avoid the
discrepancy.

Two more routes send a turn into the session (§ Asking, § Narration):
`POST /api/sessions/:id/walkthrough/narrate` and
`POST /api/sessions/:id/walkthrough/ask { step, question }`. Both refuse
`409 terminal_session` (a terminal owns the session) and `409 busy` (mid-turn
— § Asking's rule); `narrate` also refuses `400 no_steps` on a walkthrough
with nothing to narrate, and `ask` refuses `400 missing_question` and
`400 unknown_step`. Neither refusal reaches the page in the ordinary case —
both are also checked client-side (§ Asking, "Delivery") — but the server
never trusts the client's copy of the session's state.

**Three screens:**

1. **Cover.** Session title and project, the counts — steps, files touched,
   blind alleys, subagents that wrote — the narration button (or its stale
   notice, or its failure notice), and start. The blind-alley count here
   includes an intent the narration marked `abandoned`, on top of what
   `fate` caught mechanically — richer than the header's, which only ever
   asks for `steps` and `files` (above).
2. **Steps.** Linear, previous/next, with a rail listing every step for a
   jump. Intents from the narration group the rail when they exist. One step
   shows: its intent title and summary (or its own narration when there is
   none), each change as `ChangeView`, its `fate` marks linking to the step
   that revised or reverted it, the folded reads as one line, a subagent's
   sub-steps expandable in place, *open in editor* per file when
   `session.ide` is not null, the question field, and the exchanges already
   asked. A gap between steps is one line in the flow: what the agent read,
   ran and said between the two changes.
3. **Close.** Every file touched with its final state and the steps that
   touched it; the abandoned work gathered in one place; and what is still
   open — failed calls that no later successful writing call on the same
   path made good (`FileSummary.notApplied`'s rule; the failed call keeps its
   NOT APPLIED frame inside its step either way, and the rail's `not applied`
   mark follows the file rule), and a live session still working.

Every screen opens with the same top bar: back to the map, the crumb, the
project, and the session's status as a word — `WORKING` while working,
`WAITING` in `needs_input` with a pending decision, `IDLE` in `needs_input`
or `idle`, `ENDED` — never the raw status string.

**Where it is offered:** a control in the detail panel's header, for sessions
with `source` other than `terminal`. The header asks the summary route above
and shows the control once it answers `steps > 0` — absent below that, never
disabled, since the loaded transcript is paged and cannot say by itself
whether an older turn wrote. It re-asks whenever the session's status leaves
`working`, so a session that makes its first edit while selected gains the
control as soon as that turn ends, and keeps the control through that re-ask
rather than blinking it out. It opens the page in the same window; Back
returns to the map with the session still selected. A detached session window
does not offer it: the page would replace a window that holds only the panel.

**A live session grows under the page.** The page holds the session's WS
subscription anyway (§ Asking); when a message arrives it fetches the
walkthrough again. New steps append to the rail and the cover's counts
change; the step being read never moves, and a question is not lost to a
re-render. The header says the session is working and that steps may be
added.

"Never moves" is by id, not by position. A dispatch step appears only once
its subagent has written, so with parallel agents or a background dispatch a
step is inserted *before* the one being read. The page's screen therefore
names its step by id (`Screen = { kind: 'step'; id }` in `derive.ts`) and
derives the index on every render; next and previous walk the current step
ids. If the id is gone, the screen falls to the last step, or to the cover
when no steps are left. Arrow keys held with ⌘, ⌥ or ⌃ are the browser's,
never a step.

**Opening in the editor** uses the existing `POST /api/sessions/:id/ide/open-file`.
`openDiff` is deliberately not used — it blocks until the human acts and
belongs to the permission flow. `getDiagnostics` on the close screen ("and
nothing broke") is a later step and is not built here.

The look of all three screens is Claude Design's; this document does not
place anything. What it fixes is the content each screen carries and the
behaviour above.

## When things go wrong

- Unknown session — `404`, and the page says the session is not known.
- Transcript missing behind an existing row — an empty walkthrough, as the
  messages route already treats it.
- Narration answer without a JSON block — `narrationFailed`, steps fall back
  to their own narration, the button stays.
- Revival of an ended session fails — the same error the composer shows,
  recorded as every error is ([[errors-are-recorded-not-announced]]).
- The editor is gone by the time *open in editor* is clicked — the route's
  `404`, and the control disappears with the next session publish.

## Design status

**Reconciled 2026-09-23 against `Feature - Walkthrough.dc.html`**, artboards
21a–21h. The canvas draws the five screens, the entry control and the two
chips as this spec asked, and its behaviour notes (fate as ink, stale
narration never re-run, asking waits for idle, steps append while working)
match the decisions here. A first pass found the points below, where the
canvas drew data Orbital does not have; the canvas was corrected the same
day and now agrees on every one. They stay listed so the reasons survive:

- **Line-number gutters and symbol-naming hunk headers** (`@@ 41 ·
  refreshToken()`). Already answered for 20d in
  [[2026-09-23-edit-diffs-in-the-transcript]]: an `Edit` carries no offset,
  so `ChangeView` draws no gutter and states the count of dropped lines.
  The walkthrough reuses `ChangeView` unchanged.
- **The syntax palette.** The canvas's prototype tokenizes with its own six
  `oklch` hues. [[one-syntax-palette-for-all-code]] decides shiki's
  `github-dark-default` for every code surface, and `DiffView` dims only
  removed-line tokens (`TOKEN_OPACITY`). The canvas is to be corrected, not
  the code.
- **A `Delete` step and a `DELETED` tag** (canvas step 9, `src/net/retry.ts`).
  No tool deletes a file; deletion is a shell command, which the spine does
  not parse (§ Blind alleys). A file created and later removed by `rm` shows
  as created and nothing more, unless the narration names the intent as
  abandoned. The canvas's own open question — "confirm both are computable
  from the transcript alone" — is answered: *revised* and *reverted* on
  `Edit`/`Write` are; "the file is deleted" is not.
- **Per-file net counts on the close screen** (`net 0`, `+38 → deleted`,
  `restored`). Orbital sums the changes it showed; it does not hold the
  file and will not claim a net. `FileSummary` carries the sum, `created`,
  and the last fate — "restored" is said only when a step's fate is
  *reverted*.
- **"A reviewer can be walked through this in about 12 minutes."** An
  estimate with nothing behind it; not shown.
- **Durations** (`14.2s`, `2m 41s`) are computable from message timestamps
  and are added to `Step` and `Gap` as `durationMs`, null when the
  transcript has none.
- **The chip's `step 1`.** The tag carries the ordinal as `n` for the label
  (§ The wire format); the join is still on the uuid.
- **"A step is one file-changing call."** The canvas's rule text; its own
  steps 6 and 7 carry two files each, which is this spec's run definition.
  The drawing is right, the sentence is loose.

## Testing

Worth testing, per the repository's rule:

- `buildWalkthrough`: runs split on assistant text; a run without a write is
  a gap; a run with one is a step; narration taken from the text before, and
  empty after a user turn; folded counts; a step id that is stable when
  messages are appended; `revised` and `reverted` on `Edit` and on `Write`;
  a subagent with writes as a step with sub-steps and one without as a gap
  entry; questions attached to their step by tag.
- The wire format: the tag folds in `splitUserText`; the chip label from
  `kind`; the narration parser on a good block, no block, malformed JSON,
  unknown step ids, missing step ids.
- A tag quoted inside another block is not the turn's; an ask context that
  quotes the closing tag round-trips whole; a retried failure is not open; a
  pending narrate turn keeps the previous narration; a machine-only user turn
  does not close an answer window; the step being read survives a step
  inserted before it, and a vanished one clamps.
- `parseWalkthroughRoute`.
- The walkthrough route: `404`, empty, and a fixture transcript.

Not worth testing: the three screens rendering their props, and any pixel.

## What is built

As of 2026-09-23:

- `server/src/walkthrough/tag.ts` — the wire format: builders and parser, the
  chip label.
- `server/src/walkthrough/spine.ts` — `buildWalkthrough`: runs, steps, gaps,
  fate, files, durations, tagged turns read back.
- `server/src/walkthrough/narration.ts` — `parseNarration`.
- `server/src/walkthrough/subagents.ts` — subagent transcripts keyed by the
  dispatching call.
- `server/src/walkthrough/types.ts` — the wire shape, mirrored in
  `web/src/lib/types.ts`.
- `server/src/api/routes.ts` — `GET …/walkthrough`, `GET …/walkthrough/summary`,
  `POST …/walkthrough/narrate`, `POST …/walkthrough/ask`; `deliverToSession`
  now serves the composer and the walkthrough alike.
- `web/src/walkthrough/` — `route.ts` (the path, and `mapHref` back to the
  map), `useWalkthrough.ts`, `derive.ts` (screen navigation, the rail, blind
  alleys, and the busy rule as `midTurn` and `refusalOf`), `WalkthroughPage.tsx`,
  `TopBar.tsx`, `Cover.tsx`, `StepScreen.tsx`, `StepRail.tsx`, `StepBody.tsx`,
  `GapLine.tsx`, `AskField.tsx`, `CloseScreen.tsx`, and `parts.tsx` (the
  canvas's tinted buttons, the agent's-words bar, jump links, counts).
- `web/src/panels/DetailPanel.tsx` — the entry control; `web/src/ui/UtilityButton.tsx`
  — `WalkthroughGlyph`.

Not built, by decision: `getDiagnostics` on the close screen; the canvas's
`next hunk` paging inherits `ChangeView`'s behaviour.

## Out of scope

- Anything sendable — a PR description, a page for colleagues. A different
  audience and a different standard of truth; a second feature.
- Terminal sessions.
- `openDiff` and `getDiagnostics`.
- A walkthrough across several sessions, a branch or a pull request.
- Editing the narration by hand.
