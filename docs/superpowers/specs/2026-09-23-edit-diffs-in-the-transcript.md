---
id: 2026-09-23-edit-diffs-in-the-transcript
title: Edit diffs in the transcript
type: spec
status: done
domain: web
related:
  - the-line-diff-is-ours
  - diff-hues-are-content-not-state
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

## Files

- `web/src/lib/diff.ts` — `diffLines`, the hunking, the ceilings. Pure.
- `web/src/lib/fileEdit.ts` — tool call → `FileChange`, `writeOutcome`,
  `changeCounts`, the diff cache.
- `web/src/panels/DiffView.tsx` — `ChangeView`, `changeSectionLabel`.
- `web/src/panels/ToolRow.tsx` — picks the change body over the INPUT JSON.

## Design status

**No canvas artboard covers diffs or edit tool rows.** `Orbital.dc.html`'s
`Feature - *` set has no diff file, and the `DesignSync` MCP was not
connected in the session that built this, so the canvas could not be read
at all. Every value in `DiffView.tsx` is therefore a transcript token
already in use — the result `<pre>`'s 10.5px mono at 1.6 leading, the tool
row's hairline border, `SectionLabel`'s muted ink — except the two change
hues, which [[diff-hues-are-content-not-state]] argues for.

**A design pass is pending.** When an artboard lands, `DiffView.tsx` is the
one file to reconcile against it.

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
