---
id: 2026-09-23-walkthrough-design
title: The walkthrough — a guided reading of what a session changed
status: draft
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
- **A step** is a run that contains at least one writing call. Its
  **narration** is the assistant text immediately before the run, in the same
  user turn. A run with no writing call is not a step.
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
  /** Ids of the last message the spine saw — what "stale" is measured against. */
  lastMessageId: string | null;
}

interface FileSummary {
  path: string;
  /** Every step that wrote this path, in order. */
  steps: string[];
  /**
   * The sum of the steps' `changeCounts`, over `Edit`s and created files
   * only — an overwrite has one side and adds nothing. This is a sum of the
   * changes shown, not the file's net difference: Orbital does not hold the
   * file's contents and will not claim a "net 0".
   */
  added: number;
  removed: number;
  /** The first step created the file (`Write`, outcome `created`). */
  created: boolean;
  /** The last step's fate on this path, if any — `reverted` is what the close screen gathers. */
  fate: 'revised' | 'reverted' | null;
  /** A step's call on this path failed (`isError`); the close screen lists it under still open. */
  notApplied: boolean;
}

interface Step {
  /**
   * The uuid of the first writing call in the run. Stable while the transcript
   * grows, which the ordinal is not — a question asked about step 3 must still
   * find its step after the answer added a step 9.
   */
  id: string;
  ordinal: number;
  /** The assistant text that opened the run; empty when the run followed a user turn directly. */
  narration: string;
  /** The writing calls, as the transcript carries them. The browser builds the diffs. */
  calls: Array<{ call: ChatMessage; result: ChatMessage | null }>;
  /** Reads, searches and commands inside the run, folded to a count per tool. */
  folded: Record<string, number>;
  /** A dispatch whose sub-steps these are; null for the session's own writes. */
  subagent: { name: string; prompt: string; steps: Step[] } | null;
  /** How later steps treated this one's work (§ Blind alleys). */
  fate: Array<{ kind: 'revised' | 'reverted'; byStep: string; path: string }>;
  /** Questions asked about this step and their answers (§ Asking). */
  questions: Array<{ question: string; answer: string | null; messageId: string }>;
  /**
   * From the first call's timestamp to the last result's. Null when the
   * transcript carries no timestamps for the run, never estimated.
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
whose transcript holds writing calls becomes one step whose `subagent` field
carries the dispatch prompt and the agent's own steps, built by the same
function over the agent's messages. The agent's reads fold into that step,
not into the parent's gap. An agent that wrote nothing is named in the
enclosing gap. Subagent transcripts come from `readSubagentEntries`, the
reader the stats already use.

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

Every detection names the step that did it, so the page can say "revised in
step 7" and link there. Anything subtler is the narration's job.

## Narration

The model layer. Decided in [[walkthrough-narration-is-a-turn-in-the-session]]:
the session itself is asked, as one more turn, rather than an ephemeral query
being fed the transcript. The model that did the work explains it from its own
context, the context is cached, and the mechanism is the same as asking a
question from a step.

**On request only.** A button on the cover starts it; nothing runs when the
page opens, because a narration is a turn on the owner's subscription. When
steps have been added since the narration was written, the cover says so and
offers a new one; the old one is still shown against the steps it covers.

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

**Reading it back.** The server finds the tagged user message, takes the next
assistant message, and parses the first fenced JSON block in it. Every step
id the JSON names that the spine does not know is dropped; every step the
JSON does not name becomes its own intent with no summary. An answer with no
parsable block yields `narration: null` with a `narrationFailed: true` flag on
the walkthrough, and the page says the narration did not come back rather
than hiding the button. The transcript is the store; there is no table.

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

**Delivery** is `POST /api/sessions/:id/messages`, the composer's route,
including its revival of an ended session. Two things it will not do:

- **A session in the middle of a turn** (`working`, or parked on a decision)
  has the field disabled with the reason. A question injected into a running
  turn is not the question it appears to be.
- **A session live in a terminal** is never offered a walkthrough at all
  (§ Where it is offered).

**The answer** is the next assistant text in the session. The page holds the
session's WS subscription as the detail panel does, so the answer streams
under the question on the step. On the next build of the spine, the question
and its answer attach to the step by the id in the tag, so a reopened
walkthrough shows the exchange where it happened. An answer that itself edits
a file produces a new step at the end, and the page says so.

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
`splitUserText`; the transcript's `command` shape is reused as is.

## The page

`/walkthrough/<sessionId>`, branched in `web/src/main.tsx` next to
`/stats`, parsed by a pure `parseWalkthroughRoute`. A real path because that
is how the other pages are done and the SPA fallback makes it free.

**Data:** `GET /api/sessions/:id/walkthrough` returns the `Walkthrough` above
plus the `ApiSession`. `404` when the id is unknown. A session with no writes
returns `steps: []`, and the page shows a cover that says so.

**Three screens:**

1. **Cover.** Session title and project, the counts — steps, files touched,
   blind alleys, subagents that wrote — the narration button (or its stale
   notice, or its failure notice), and start.
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
   open — steps whose result is an error, a live session still working.

**Where it is offered:** a control in the detail panel's header, for sessions
with `source` other than `terminal` and at least one writing call in the
transcript. It opens the page in the same window; Back returns to the map with
the session still selected.

**A live session grows under the page.** The page holds the session's WS
subscription anyway (§ Asking); when a message arrives it fetches the
walkthrough again. New steps append to the rail and the cover's counts
change; the step being read never moves, and a question is not lost to a
re-render. The header says the session is working and that steps may be
added.

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
- `parseWalkthroughRoute`.
- The walkthrough route: `404`, empty, and a fixture transcript.

Not worth testing: the three screens rendering their props, and any pixel.

## Out of scope

- Anything sendable — a PR description, a page for colleagues. A different
  audience and a different standard of truth; a second feature.
- Terminal sessions.
- `openDiff` and `getDiagnostics`.
- A walkthrough across several sessions, a branch or a pull request.
- Editing the narration by hand.
