---
id: 2026-09-23-edit-diffs-in-the-transcript
title: Edit diffs in the transcript
type: spec
status: done
domain: web
related:
  - the-line-diff-is-ours
  - the-diff-separates-on-luminance
  - diff-hues-are-content-not-state
  - one-syntax-palette-for-all-code
  - file-viewer-owns-a-second-language-table
  - 2026-09-19-file-viewer-design
  - the-transcript-scrolls-on-its-own-raf-loop
tags:
  - transcript
  - detail-panel
---
# Edit diffs in the transcript

Reviewing what a session actually changed is one of the commonest reasons
to drop back to the terminal. Until now an `Edit` call expanded into its
raw input JSON — `old_string` and `new_string` as two escaped blobs in a
`<pre>` — which is the data a diff is made of and not a diff.

This is web-only. No server field is added, and none is needed.

## Where it lives, and where it does not

At the tool call, in the transcript. **Not** in the file viewer.
[[2026-09-19-file-viewer-design]] lists "no diff" as a non-goal and that
boundary still holds: the viewer is a snapshot of a file at the moment it
opened, with no before side to diff against and no relationship to any
particular tool call. Its refusal states, its line targets and its degrade
tier are all about *one file as it is now*. A diff is about *one change*,
which is a property of a tool call, so it belongs on the tool call. The two
meet only where the diff says "open the file to read the result" and the
row's existing path button does that.

## What the SDK actually gives us

Checked against `@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`, not
assumed. Three tools edit files, and **there is no multi-edit form** — the
current SDK's `ToolInputSchemas` has no `MultiEdit` member:

| tool | input | both sides? |
|---|---|---|
| `Edit` (`FileEditInput`) | `file_path`, `old_string`, `new_string`, `replace_all?` | yes |
| `Write` (`FileWriteInput`) | `file_path`, `content` | no |
| `NotebookEdit` (`NotebookEditInput`) | `notebook_path`, `new_source`, `cell_id?`, `cell_type?`, `edit_mode?` | no |

The tool *outputs* are richer — `FileEditOutput` and `FileWriteOutput` both
carry `originalFile` and a `structuredPatch`, `NotebookEditOutput` carries
`old_source` — but **none of it reaches the browser**.
`server/src/transcript/parser.ts` keeps a `tool_result`'s text blocks and
its images and drops everything else, so what the web sees of a result is
the sentence the CLI writes. Using the structured payload would mean a
server change and a wire change; this spec deliberately does neither.

So: `Edit` gets a real diff. The other two get their new text, and the UI
says what it does not know.

## What each case renders

The expanded body of an editing tool row is its change, replacing the
INPUT JSON entirely (every other tool keeps the JSON untouched). The
collapsed row gains a `+n −m` skim, before the running dot.

- **`Edit`** — `DIFF`, the line diff of `old_string` against `new_string`.
  It is a diff of the *replaced region*, not of the file, so it carries no
  line numbers: Orbital does not know where in the file the region sits and
  will not invent a number. `replace_all` adds one line — *applied to every
  occurrence in the file, not only the one shown* — because the diff shows
  one occurrence and the count of the others is not knowable either.
  Identical strings say so rather than drawing an empty frame.
- **`Write` onto a new file** — `NEW FILE`, every line drawn as an
  addition. This is the one case where the missing side is genuinely empty,
  so the additions are true and the `+n` skim is true.
- **`Write` over an existing file** — `CONTENTS WRITTEN`, the new text in
  neutral ink with *Replaced the whole file. Orbital does not have the
  previous contents.* Not drawn as additions: colouring a whole file green
  would be a claim that all of it is new. No `+n −m` either — an overwrite
  has exactly one side Orbital knows.
- **`Write`, outcome unknown** — the call is still running, or failed, or
  the CLI reworded its result. Same as the overwrite case with the
  uncertainty stated.
- **`NotebookEdit`** — `CELL SOURCE` / `CELL INSERTED` / `CELL DELETED`.
  An insert's source is additions; a replace's is neutral, with the same
  sentence about the previous source; a delete has nothing to draw.
- **A failed call** — the label becomes `PROPOSED DIFF` /
  `PROPOSED CONTENTS`. A green-and-red diff for an edit that never landed
  would be a lie the RESULT block below it only half corrects.

Which sentence a `Write` gets comes from `writeOutcome`, a deliberately
narrow matcher over the result text (`File created successfully at:` and
`has been updated`). Anything it does not recognise is `unknown`. The
alternative — inferring "it must have existed" from silence — is the exact
fabricated before-side this spec exists to avoid.

## Size, and the transcript's scroll loop

[[the-transcript-scrolls-on-its-own-raf-loop]] re-reads `scrollHeight`
every animation frame while it is following a new message. An expanded row
holding thousands of nodes is therefore paid for on every one of those
frames, not once — and the diff of a large replacement is also real CPU on
the render path. Four ceilings, all in `web/src/lib/diff.ts`:

- The common head and tail are trimmed **before** any alignment runs. This
  is what makes a two-line change inside a two-thousand-line string cheap,
  and it is the case that actually happens.
- `DIFF_MAX_LINES` — per side, after that trim. Above it the alignment is
  not attempted.
- `DIFF_MAX_EDIT_DISTANCE` — the Myers `d` ceiling. Past this many changed
  lines the diff is over the render cap anyway, so an exact alignment would
  buy nothing visible.
- `DIFF_MAX_RENDERED_LINES` — rows in the DOM, with the remainder stated
  as a count.

Giving up on the alignment is not giving up on the diff: the result is
`coarse`, which renders every line of the changed region as removed and
every line of the new one as added, with a note saying the alignment was
skipped. The counts stay exact. Diffs are memoised on the tool input
object (a `WeakMap`), so a transcript re-rendering on every websocket
message pays for each edit once.

## Honesty about newlines

`splitLines` drops the empty element `split('\n')` produces for a text
ending in a newline — that element is punctuation, not a line, and keeping
it makes every comparison off by one. The newline itself is then tracked
separately per side, because a change that only adds or removes the final
line break moves no row and would otherwise render as "no change". When
the two sides disagree the diff says so, the way `\ No newline at end of
file` does in a unified diff.

## Syntax highlighting

Added 2026-09-23. Diff rows are highlighted with shiki, in the same
`github-dark-default` theme and through the same lazy loader the file
viewer already uses — [[one-syntax-palette-for-all-code]] is why that
theme and not the canvas's proposed token palette, and what the knowingly
accepted red/`bypassPermissions` hue collision costs.

**A row cannot be tokenized on its own.** A grammar carries state across
lines, so a line lifted out of a template literal or a block comment
tokenizes as something it is not. So the rows on screen are reassembled
into the two texts they came from — removals and context into *before*,
additions and context into *after* — each side is tokenized in one call,
and every row keeps a coordinate (`side`, `line`) back into its side's
grid. `diffSideTexts` is that split; it carries the line counts explicitly,
because one blank line and no lines both join to the empty string.

**It is still a fragment.** The hunking drops unchanged lines between
hunks, and an `Edit`'s replaced region rarely starts at a construct
boundary, so the grammar starts in its root state and can be wrong about a
region that opened before the fragment did. That is the honest limit of
highlighting something Orbital only ever sees a piece of, and every diff
viewer has it.

**The language comes from the path**, via `languageFromPath` in
`lib/highlight.ts` — the file viewer's table, lifted into the shared module
(and duplicated for now: [[file-viewer-owns-a-second-language-table]]). A
path with no extension resolves to the empty language, which short-circuits
before shiki is imported at all. A notebook resolves to `ipynb`, which
shiki does not know, so `NotebookEdit` cell sources stay plain — the cell's
type is not on the wire, so guessing python would be a guess.

**Nothing blocks a render.** Tokenizing is async behind a dynamic import;
plain text paints on the first frame and the colours swap in, the same
posture as the file viewer and the transcript's code blocks. Resolved
fragments are held in a bounded module cache keyed on language and text, so
the transcript re-rendering on every websocket message — and a row being
closed and reopened — does not re-tokenize, and concurrent asks for one
fragment share a single call.

**Every failure degrades to today's plain text, never to an empty block:**
no extension, a language shiki does not know, a failed dynamic import, any
shiki error, or a token grid whose line count disagrees with the rows it
would line up with. The last one matters most — an off-by-one grid would
colour each line with its neighbour's tokens, which is worse than no
colour.

**What highlighting is not allowed to touch:** the `+`/`−` sign column
(its own flex child, never inside the highlighted span), `whitespace-pre`,
and the frame's horizontal scroll. Only opacity is ever applied to a token
colour — added lines at full strength, removed and context lines dimmed, so
the add/remove separation stays a luminance separation.

## Files

- `web/src/lib/diff.ts` — `diffLines`, the hunking, the ceilings. Pure.
- `web/src/lib/fileEdit.ts` — tool call → `FileChange`, `writeOutcome`,
  `changeCounts`, the diff cache.
- `web/src/lib/highlight.ts` — shiki, and `languageFromPath`.
- `web/src/lib/codeTokens.ts` — `diffSideTexts`, `tokenizeFragment`, the
  fragment cache.
- `web/src/panels/DiffView.tsx` — `ChangeView`, `changeSectionLabel`.
- `web/src/panels/ToolRow.tsx` — picks the change body over the INPUT JSON.

## Design status

**Reconciled, 2026-09-23, against artboard `20d` of `Feature - Transcript
blocks.dc.html`** — "EDIT DIFFS — WHAT WE KNOW, SHOWN HONESTLY", whose
values table sits under "H · DIFF COLOUR — WHY LUMINANCE". (Artboard ids
are per-file: `Feature - IDE bridge.dc.html` also has a `20d`, and it is a
different drawing. Always name the file.)

Two decisions came out of the pass:

- [[the-diff-separates-on-luminance]] — the diff body takes 20d's
  luminance system and **supersedes** [[diff-hues-are-content-not-state]],
  whose six hues were drafted before any artboard existed. Green and red
  survive in one place only, the `+n −m` skim, at 20d-G's values.
- [[one-syntax-palette-for-all-code]] — the five *syntax token* values in
  20d's table are deliberately not adopted; shiki's
  `github-dark-default` stays, and the red/`bypassPermissions` hue
  collision is knowingly accepted. This was decided by the owner ahead of
  the artboard and the pass did not reopen it.

### What 20d prescribes that this spec still answers differently

The canvas draws a diff; it does not decide what Orbital knows. Where the
two disagree, the disagreement is about data, and it is settled here.

- **Line numbers.** 20d-A draws an old and a new number gutter, and 20d-C
  hatches the number column to say a side is unknown. Orbital has neither
  number: an `Edit` carries `old_string` and `new_string` and no offset,
  so the diff is of a *replaced region* and the spec refuses to invent a
  position for it (§ What each case renders). No gutter is drawn, and the
  hatch the artboard puts on the gutter is used on the "unknown" banner
  instead, where it says the same thing about the same missing data.
- **Hunk headers naming the enclosing symbol** (`@@ 41 · refreshToken()`).
  Needs the file offset and a parse of the enclosing scope. Neither is
  available for the same reason. The gap marker keeps 20d's band and ink
  and states the count of dropped lines instead.
- **`next hunk` paging.** 20d-F opens on the first hunk at 14 lines, then
  appends one hunk at a time to 40 lines total, then sends the reader to
  the file viewer. `DIFF_PREVIEW_LINES` matches 20d's 14 exactly, but the
  progressive middle step does not exist: a row opens fully, and
  `DIFF_MAX_RENDERED_LINES` is the only other ceiling. Adding the paging
  is a real feature, not a fidelity fix.
- **Long lines wrap with a hanging indent** (`white-space:pre-wrap;
  word-break:break-word`). The implementation keeps `whitespace-pre` and
  scrolls the block sideways, because a wrapped line without a built
  hanging indent breaks the column the signs stand in — the one thing a
  diff cannot afford — and 20d specifies the wrapping without specifying
  the indent. **Open question for the owner**, not a silent decision.
- **`NEW` / `REPLACED` / `PROPOSED` / `NOT APPLIED` badges on the folded
  row** (20d-G). `ToolRow` shows the counts and the path; the badges are
  not implemented. They are row chrome rather than diff body, and 20d-G's
  own rule — "counts only for applied edits and new files" — is already
  what `changeCounts` does.
- **A running call's dimmed, dashed frame** (20d-D). The dashed `proposed`
  frame is implemented for a *failed* call (20d-E), which is what
  `isError` carries into `ChangeView`. A still-running edit is not
  distinguished, because whether the call is running is not threaded into
  the change view.

### What the pass changed

Bands, inks and signs for all three row kinds; the context ink; the gap
marker's band and ink; the note ink; the frame's radius, border and
background, plus the dashed `proposed` variant; the sign column's width
and centring and the text cell's insets; the removed-token opacity rule
(20d dims removed tokens only — added and context stay at full strength);
the "unknown" hatch banner; and the `+n −m` skim in `ToolRow.tsx`.

One conflict inside the artboard itself, reported rather than resolved:
its table says removed-line tokens sit at **opacity .55**, and its
prototype script sets **.6**. The table is taken as the specification.

## Testing

`web/src/test/diff.test.ts` covers the algorithm and the descriptor: no
change, pure insertion, pure deletion, whole-text replacement, a change on
the first line and on the last, creation from nothing and emptying to
nothing, both trailing-newline directions, a blank line added versus a
trailing newline added, context kept and gaps counted, hunks splitting and
merging, counts staying exact under truncation, both ceilings degrading to
`coarse`, and a huge text with one change staying exact and fast. Plus
`writeOutcome`'s three answers, `describeFileChange`'s refusals on
malformed input, the diff cache, and `changeCounts` refusing to count an
overwrite.

`transcript.test.tsx` adds only the branch — an `Edit` row opens on its
diff, every other tool still opens on its JSON. Styling values are not
pinned, per the repo's testing rule.

`web/src/test/codetokens.test.ts` covers the highlighting's two pieces of
real logic: `languageFromPath` (mapped and unmapped extensions, the last
segment only, the last dot of several, case, no extension, a dotfile name
versus a dotfile with a real extension, the label) and `diffSideTexts`
(reassembly, per-row coordinates, a context row addressed on the *after*
side, pure insertion and pure deletion, a blank line counted rather than
inferred from the joined text, the coarse all-removed-then-all-added
shape, and a property check that every coordinate really addresses its own
row's text). `tokenizeFragment`'s degrade paths are covered with
`tokenizeCode` stubbed: no language and no rows never reach shiki, a null
result and a line-count mismatch both resolve to plain text, and the cache
tokenizes one fragment once — refusals included — while sharing an
in-flight call. Colours and opacities are not pinned.

## How a row arrives

Added 2026-09-23, from canvas `Feature - Transcript blocks` 20f.

Settings → Appearance → TRANSCRIPT → **Edit diffs** decides whether an
editing tool's row arrives collapsed or open. The reasoning — why an
arriving diff is a preview rather than the change, why a hand-toggled row
stops listening to the setting, and why the row is in Appearance — is
[[an-arriving-diff-is-a-preview]].

Two things this adds to `DiffView`:

- `DIFF_PREVIEW_LINES` and a `preview` flag threaded through `ChangeView`
  into `DiffBody` and `ContentBody`. A preview keeps the first hunk only,
  cut to that many lines, and replaces the truncation and trailing-gap
  notes with one that points at the row rather than at the file.
- Nothing about the diff itself. The algorithm, the ceilings and the
  descriptor are untouched; the preview is a slice taken at render time,
  so a row opened by hand shows what it always did.

The companion row, **"Always expand an edit waiting for your permission"**
(default on), is honoured by `PermissionCard`, not here — `groupToolRuns`
routes a call its session is parked on away from `ToolRow` — and it renders
the change in full rather than as a preview.

`store.test.ts` covers the two selectors, including that they use opposite
default conventions. `transcript.test.tsx` covers that an edit arrives open
when the setting says so, that a `Bash` call never does, and that a row
closed by hand stays closed when the setting would open it.
