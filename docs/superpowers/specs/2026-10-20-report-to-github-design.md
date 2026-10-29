---
id: 2026-10-20-report-to-github-design
title: Report an error or send feedback to Orbital's GitHub, from Orbital
status: done
type: spec
domain: sessions
related:
  - 2026-09-17-error-surface-design
  - errors-are-recorded-not-announced
  - branch-status-comes-from-git-and-gh-processes
tags:
  - errors
  - feedback
  - gh
  - web
---
# Report an error or send feedback to Orbital's GitHub, from Orbital

## Why

The error log keeps every error with its full stack and context
([[2026-09-17-error-surface-design]]), and its copy button already formats a
record "the way a person pasting it into an issue wants". The pasting is the
part left to the user: open GitHub, find the repository, pick the template,
paste, fill in the version and the macOS. Most people stop before the end, so
the errors that reach the maintainer are the ones somebody cared enough to
carry by hand.

Feedback that is not an error has no door in the app at all.

Why it gets in although it is neither following sessions nor replacing the
CLI ([[why-orbital]] → What gets in): the CLI has its own `/bug` for the
same reason, and every report that arrives with its version and record makes
Orbital better for everyone who uses it. It is the one way back to the
people who build Orbital — not a precedent for sending anything else to
GitHub.

## What we are building

Two entry points, one way out:

- **Report** on a row of the error log — the record becomes a bug report.
- **Send feedback** in Settings — free text becomes an idea or a bug report.

Both open the same **review step**: a title and a body the user can edit,
showing exactly what will be published. Nothing leaves the Mac without it.
The repository is public and an error record carries paths, the working
directory, the stack and response bodies untrimmed — the review is where the
user removes what they do not want published.

From the review the issue goes out one of two ways:

1. **`gh` (the primary way).** When `gh` is installed and logged in — the
   same `GET /api/gh-status` the PR indicator uses — the server runs
   `gh issue create --repo slothworks-apps/orbital --title … --body …`.
   The answer is the issue's URL, shown in the review step as a link once it
   is created.
2. **A prefilled form (the fallback).** Without `gh`, the button opens
   `https://github.com/slothworks-apps/orbital/issues/new?title=…&body=…` in
   the browser with the same title and body the review showed. No template:
   GitHub ignores `body` on an issue form, and the body is already written.
   The user submits on GitHub. Below the button one line says that with `gh`
   it would go straight from here.

### What the body holds

Markdown with `##` sections, one shape per way in (canvas `Feature -
Feedback` 61g PREFILL, built in `web/src/lib/issueReport.ts`):

- **From the error log:** the title is the kind and the message; the body is
  *What happened* (the message), *Record* (`formatRecordForCopy` verbatim in
  a `text` fence) and *Environment* (one line: Orbital, Claude Code, macOS).
  The body is one editable markdown field.
- **Something broke:** an empty title; *What happened*, *How to reproduce*
  (optional) and four environment fields — Orbital version, how it runs,
  Claude Code version, macOS — filled in and editable.
- **An idea:** an empty title; *What gets in the way* and *What I would
  like*.
- **Never:** transcripts, file contents or session names beyond what the
  record already says.

Two limits shape it:

- **`gh` cannot set labels for an outside contributor.** Labels need triage
  rights on the repository, so the `gh` path sends no `--label`; the
  templates' `labels:` only apply to issues filed through the form. The
  `Label issues` workflow labels an unlabelled issue by its first heading:
  *What happened* is `bug`, *What gets in the way* (or the form's *What gets
  in your way*) is `enhancement`.
- **A URL is about 8 KB.** On the fallback path the record is cut to fit,
  with a note where it stops — what comes before and after it stays whole —
  and the whole body goes to the clipboard: "Full record copied — paste it
  into Logs".

### Before sending: is it already reported?

The review step searches the repository for issues like this one, open and
closed, and lists up to five with their state. The user can open one and
add to it instead, or send theirs anyway; the list never blocks sending.

- The query is the title's words, minus what names this machine or this run
  — paths, URLs, hex, numbers — and minus GitHub's search qualifiers.
- With `gh`, the search runs as `gh search issues` on the user's login.
  Without it — or when `gh` refuses — it runs on GitHub's public search API,
  which needs no login and allows a few searches a minute.
- When neither could search, the step says nothing about duplicates rather
  than "no similar issues".

The search sends the title to GitHub before the user presses send. That is
the text they are looking at in the review step and about to publish; the
body is never part of the query.

### Checking with Claude

The word search finds an issue told in the same words. A button in the
review step, **Check with Claude**, finds one told differently: the server
lists the repository's issues — open and closed, the newest 40
(`MAX_LISTED_ISSUES`), each with the opening of its body — and one model call
reads them beside the draft and names the ones that report the same thing,
each with a sentence on why.

- **Only when asked.** It costs a model call, so it never runs on its own
  ([[session-titles-only-on-demand]]).
- **No session.** `askOnce`, as the harness drafter: no tools, no
  transcript on disk, so nothing appears on the map or in history
  ([[ephemeral-title-queries]]), under the default Claude directory's
  account. The model is picked in a chip beside the button — Haiku by
  default, the last pick kept in the `issue_check_model` setting.
- **No tools, on purpose.** The server fetches the list itself (`gh issue
  list`, else the public REST API) and the model only reads
  ([[issue-duplicate-check-reads-without-tools]]).
- A number the model names that was not in the list is dropped, a reason is
  cut to one short line, and the data fence (`<<<` `>>>`) is taken out of
  everyone's text before it is fenced, so an issue cannot close the data
  block and talk to the model. When the list cannot be fetched, the model
  cannot be asked (it is given two minutes) or the reply does not parse, the
  step says the check failed, not that there are no duplicates; a failed
  call is recorded in the error log.
- **In Labs.** Nobody has used it yet and the title search covers the common
  case, so the CLAUDE row shows only while Labs → Check reports with Claude
  is on (`issue_check_enabled`).

### When gh does not answer

A slow network can let GitHub accept the issue and lose `gh`'s reply. So a
timeout is never "nothing was published": the server first looks for an
issue with exactly this title among the user's newest on the repository and
treats it as created when it finds one; otherwise the route answers 504
`timeout`, and the review says the issue may exist, links the user's issues
on GitHub, keeps the text and offers Try again.

### Not every error is Orbital's

A session or a compaction that failed because the Claude API was
overloaded, a usage limit was hit or the account is signed out is Claude's,
not Orbital's; reported to Orbital's GitHub it would reach someone who
cannot fix it. The log offers no Report on such a record (`fromClaude` in
`web/src/lib/errorRecord.ts`). Copy still works.

### Not in the website's demos

The site's demos run the real components on a fake server. Report, Send
feedback and the phone's Send feedback stay out of them (`lib/demo`): a
click there would file, or open, a real issue on GitHub.

### A reported error remembers its issue

An error row gains `issue_url`. When `POST /api/issues` carries the row's
`errorId` and the issue is created, the row keeps its address and the
`errors` topic publishes `{ event: 'reported', id, issueUrl }`. The log
shows the link on the row, and Report on it becomes the link — the same row
is not filed twice. The fallback path cannot learn the address, so a row
reported through the browser stays unmarked.

### Telling people about `gh`

The PR indicator and now this both depend on `gh`, and someone without it
has no way to learn that. Orbital says it **once** (canvas 61e, 61f): a
`tip` in the map's notice queue, queued on a launch where `gh` is not found
and dropped unseen if it appears first. × or Install ends it for good — a
flag in settings ([[why-orbital]] → Calm rules out reminders that repeat).

After that the explanation lives in Settings (61c, 61g GH LINE), under the
PR switch: the reason now names the command — `brew install gh`, or
`gh auth login --web` — with **Run in Orbital** beside it; without Homebrew
it links to cli.github.com instead. `GET /api/gh-status` gains `brew` for
that choice; a phone reading an older Mac gets no `brew` and keeps the old
line.

**Run in Orbital** starts an ordinary session in the home directory that
runs the command; it is on the map like any other and the user ends it. The
canvas says it runs through Claude Code's `!` shell mode, but that mode does
not exist headless: through the SDK a `!command` prompt is read by the model,
which runs it with the Bash tool. So the session's prompt asks the agent to
run exactly that command, and the user approves it as any other command.
`gh auth login --web` waits for the browser, so its prompt asks the agent to
run it in the background and show the one-time code as soon as gh prints it.

## Server

- `POST /api/issues` — `{ title, body, errorId? }`. Resolves
  `gh` with `resolveGh()`, passes the body as an argument, and returns
  `{ url }`; 409 `{ error: 'missing' | 'logged_out' }` when `gh` cannot
  file it, 502 with what `gh` said otherwise. An optional `errorId` marks
  the error row as reported. The repository is fixed in the server;
  a request cannot name another one.
- `GET /api/issues/similar?title=` — `{ issues }`, or `{ issues: null }`
  when GitHub could not be searched.
- `POST /api/issues/duplicates` — `{ title, body, model }` → `{ matches }`, each
  match an issue with `why`; 502 `{ error: 'list' | 'reply' }` names the
  half that failed.
- `GET /api/issues/environment` — `{ osVersion, ghLogin }`: the macOS
  version, and the account `gh` is logged in as, for the review step's
  "as @login · gh". The CLI version is already in
  settings (`claude_code_version`) and the way Orbital runs is the web
  build's own (`import.meta.env.DEV`), so the web builds the whole body and
  shows it in the review before anything is sent.
- None of these routes is in the phone's allowlist or the control catalog:
  publishing under the user's GitHub name happens only after a person
  reviewed it, never from a session.

## Web

- `ErrorLog.tsx`: **Report** after Copy on an expanded row, never on a dev
  record; once reported it becomes `#n ↗` (61a, 61g REPORT CHIP).
- `Settings.tsx`: **Send feedback** in the sidebar foot, above the versions,
  opening the dropdown upward with *Something broke* / *An idea* (61c).
- The review dialog (`Report Dialog` in Claude Design, 61d, 61h) stacks over
  the dialog it was opened from. Fields on the left, similar issues and
  Check with Claude on the right; the PUBLIC line names the repository in
  every state. gh refusing shows its message verbatim and keeps the text.
- Motion: nothing jumps. Dialogs have a maximum height and scroll inside; a
  row that leaves the error log fades and then collapses so the rows below
  glide up; content-driven height changes in a dialog animate.

## Scope

> Promoted out of Labs on 2026-10-29 ([[labs-features-move-to-regular-settings]]): Check reports with Claude now lives in Settings → General → REPORTS, still off by default.

- **Who it is for:** everyone using Orbital who runs into an error or has
  something to say — and the maintainer, who gets reports with the version
  and the stack already in them.
- **Where it lives:** on by default. It extends surfaces that exist — a row
  action in the error log, an entry in Settings — and adds no panel or tab.
  It does add one map element: the `gh` tip, a notice in the map's queue,
  shown once and only to someone without `gh`. Check with Claude is in Labs.
- **What someone already using Orbital notices after updating:** a Report
  action in the error log, Send feedback in Settings, and — only if they
  have no `gh` — one tip on the map, once.
- **What can be set:** Labs → Check reports with Claude, and the check's
  model, kept for next time. Every send passes the review step, so there is
  no "send automatically" to turn off.

## Phone

- **Report** is left out: the phone has no error log, and its own errors
  already go out through Send diagnostics
  (`web/src/mobile/update/DiagnosticsSetting.tsx`).
- **Send feedback** is built for the phone as the fallback path only (61i):
  an entry in Settings → About opens a sheet with the two kinds, and either
  opens the prefilled form in the system browser, with the app version, the
  OS and the device filled in. It needs no route on the
  allowlist and no newer Mac, so no `MAC_FEATURES` gate. Sending through the
  Mac's `gh` from the phone is not worth a new allowlisted route now.

## Design

Claude Design: `Feature - Feedback.dc.html` (61a–61i) and the `Report
Dialog.dc.html` component.
