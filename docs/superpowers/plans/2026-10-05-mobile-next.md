---
id: 2026-10-05-mobile-next
title: Mobile, next — implementation plan
type: plan
status: done
domain: remote
related:
  - 2026-10-05-mobile-next-design
  - 2026-10-02-mobile-app-design
  - desktop-vs-phone-feature-map
  - phone-opens-files-the-session-named
tags:
  - mobile
  - relay
  - harness
  - file-viewer
  - limits
---
# Mobile, next — implementation plan

> **For agentic workers:** use superpowers:subagent-driven-development. One
> implementer per task; tasks inside a track run in order; tracks run in
> parallel only where the waves below say so.

**Goal:** the five phone features of
[[2026-10-05-mobile-next-design]] — answer a harness gate; open images and
files by tapping; subagent transcripts and task output; the ⋯ sheet with
pins; limit waits and the context readout — with the Mac-side routes,
allowlist entries and the `file_get` message they need.

**Spec:** `docs/superpowers/specs/2026-10-05-mobile-next-design.md`. Its
§ 8 records the owner's decisions of 2026-10-05 on where the canvas and the
server disagreed; tasks that depend on one name it ("Decision n"). Where a
decision departs from the canvas, the decision wins.

**Canvas:** `.design/feature-mobile-next.dc.html` (artboards 10a–10l) in the
worktree, and `.design/feature-mobile.dc.html` (9a–9p) for the frame,
tokens and glyphs it builds on.

## Global constraints

- Worktree `/Users/tomin/Projects/slothworks/orbital/.claude/worktrees/mobile-next`,
  branch `feat/mobile-next`. Every command runs from there. Stage only the
  files your task owns (below); other tracks commit into the same branch.
  **Never `git add` anything under `.design/`** — it is git-excluded on
  purpose. Conventional subjects (`feat(mobile): …`, `feat(server): …`,
  `feat(shared): …`, `test(…)`); no attribution trailers or footers.
- **Literal values come from the canvas file's inline CSS**: sizes, radii,
  paddings, inks, alphas, durations, easings, copy. Open
  `.design/feature-mobile-next.dc.html`, find the artboard (`id="10b"` …)
  and read the `style` attributes; name the artboard in a comment
  (`canvas 10b`). Never tune by eye, never invent copy the canvas has. The
  script at the bottom of the file holds the sample data and the state
  logic of each artboard (e.g. `gateLabel`, `wTitle`, `tStates`) — read it
  for what changes between states. Implementers do not use DesignSync.
- **The fidelity pass is not yours.** Screenshots against the canvas, on a
  real phone, are done by the main session after every track has merged
  (Task Z2). Your "done" is behaviour, tests and a clean build.
- Calm (`docs/why-orbital.md`, spec § 0): no spinners, no countdowns, no
  amber outside NEEDS INPUT / NEEDS YOUR OK, no red, a gate never moves,
  asleep stops every motion.
- Phone code lives in `web/src/mobile/`. Nothing in `web/src/panels/`
  imports from `mobile/`. Desktop files are touched only where a task says
  so, and their default behaviour must not change.
- Comments name constants, never restate their values.
- Tests only where they can catch a real regression (root `CLAUDE.md` →
  Tests): routes, the allowlist, the `file_get` boundary, parsing, pure
  phone logic (grouping, copy selection, cache eviction, navigation). No
  tests for rendering, class names, sizes, inks or motion.
- Commands:
  - server: `cd server && env ORBITAL_STATIC_DIR= ORBITAL_MIGRATIONS_DIR= npx vitest run <file>`;
    whole suite `env ORBITAL_STATIC_DIR= ORBITAL_MIGRATIONS_DIR= npm test -w server`
  - shared: `npm test -w @orbital/shared`
  - web: `npm test -w @orbital/web -- <file>`; typecheck
    `npm run typecheck -w @orbital/web` (a bare `npx tsc --noEmit` checks
    nothing)
  - lint: `npm run lint` (no new errors)
  - phone build + bundle guard: `npm run build -w @orbital/mobile`
- Docs: `atlas validate` before committing a doc.
- Versions and changelogs are Task Z1's, not yours.

## Hotspots and who owns them

A file below is edited by exactly one task. If your task needs a change in
a file you do not own, stop and report it; the controller sequences it.

| File | Owner |
|---|---|
| `server/src/db/database.ts`, `web/src/panels/Settings.tsx`, `web/src/test/settings.test.tsx` | A4 |
| `server/src/remote/allowlist.ts`, `server/test/remoteAllowlist.test.ts` | A1 |
| `server/src/api/routes.ts`, `server/src/api/shape.ts`, `server/src/limits/service.ts`, `server/src/types.ts` | A2, then A3, then A4 (in that order) |
| `web/src/lib/types.ts`, `web/src/lib/api.ts`, `web/src/lib/limits.ts` | A2, then A3 |
| `shared/src/remote/messages.ts`, `shared/src/remote/client.ts`, `server/src/remote/phoneSession.ts`, `server/src/remote/service.ts`, `server/src/images/store.ts` | B1 |
| `web/src/mobile/state.ts`, `MobileApp.tsx`, `ui.tsx`, `boot.ts`, `constants.ts`, `forget.ts`, `composer.ts` | F1, then F2 |
| `web/src/mobile/screens/SessionScreen.tsx`, `screens/SessionComposer.tsx` | F2 |
| `web/src/mobile/sessionList.ts`, `screens/SessionListScreen.tsx`, `web/src/test/mobilelist.test.ts` | L1 |
| `web/src/panels/PathButton.tsx`, `ImageThumb.tsx`, `MessageView.tsx`, `web/src/lib/fileOpen.ts` | T2.1 |
| `web/src/mobile/transport/clientRef.ts`, `transport/imageResolver.ts`, `platform/imageCache.ts` | T2.2 |
| `web/src/store/store.ts` | nobody — the phone reuses the store's actions as they are |

## Waves

```
Wave 1 (parallel):  A1 → A2 → A3 → A4      B1        F1 → F2 (F2 after A2)
Wave 2 (parallel):  T1.1 → T1.2 → T1.3     (needs A1, A2, F2)
                    T2.1 → T2.2 → T2.3 → T2.4   (needs B1, F2)
                    T3.1 → T3.2            (needs A3, F2)
                    T4.1                   (needs A3, A4, F2)
                    T5.1                   (needs A1, A2, F2)
                    L1                     (needs A2, F2)
Wave 3:             Z1 (controller), Z2 (main session, fidelity)
```

---

## Track A — Server routes and allowlist

### A1: Allowlist entries

**Goal:** the phone may call the routes the spec adds, and nothing next to
them.

**Files:** `server/src/remote/allowlist.ts`, `server/test/remoteAllowlist.test.ts`.

**Do:** add to `ALLOWED_ROUTES`:
`GET /api/sessions/:id/harness`;
`POST /api/sessions/:id/harness/steps/:index/approve`, `…/reopen`,
`…/go-back`, `…/decide-myself`;
`POST /api/sessions/:id/rewind`;
`POST /api/sessions/:id/limit-wait/cancel`, `…/undo`. Nothing that opens
or runs anything on the Mac (spec Decision 8). Update the file's comment
block only if it names the denied set.

**Tests:** each new entry passes for its method and fails for the others;
denied neighbours stay denied — `DELETE …/rewind`, `POST …/harness`,
`PATCH …/harness`, `DELETE …/harness`, `POST …/harness/carry`,
`GET …/harness/steps/1/diff`, `GET /api/files`, `GET /api/files/image`,
`GET /api/limits`, `POST /api/limits/refresh`; `:index` spelled `..`,
`%2e`, empty, or with a trailing slash is refused.

**Done:** tests green; `remoteEndToEnd.test.ts` still green.

### A2: Snapshot fields

**Goal:** the phone can say "step n of m" and write the limit notice
without reading Mac settings.

**Files:** `server/src/api/shape.ts`, `server/src/limits/service.ts`,
`server/src/types.ts` (if the wait type lives there), `web/src/lib/types.ts`,
`web/src/lib/limits.ts`, tests in `server/test/` (existing harness/limits
test files or a new `server/test/phoneSnapshot.test.ts`) and
`web/src/test/limits*.test.ts`.

**Do:**
- `ApiSession.harnessStep: { index: number; total: number } | null` — the
  first step not done and the step count of the live harness; null without
  one (spec § 1 Server). Mirror in `web/src/lib/types.ts` (optional there,
  like the other late fields).
- `LimitWait.autoContinue: boolean` and `continueText: string`, filled from
  the two settings when the wait is published (spec § 5 Server). Mirror.
- `limitWaitCopy`: when the wait carries `autoContinue` / `continueText`,
  use them; otherwise the settings argument, so the desktop reads what it
  reads today.

**Tests:** `harnessStep` with no harness, mid-run, at a gate, finished
(null or `index === total`, pick one and pin it); the wait's two fields
follow a settings change on the next publish; `limitWaitCopy` prefers the
wait's fields.

**Done:** server and web suites green; typecheck clean.

### A3: Route parameters and publishing

**Goal:** the phone's reads fit one relay frame; renames and retags reach
every client.

**Files:** `server/src/api/routes.ts`, `server/src/files/taskOutput.ts` (only
if the tail reader needs the bound passed through), `web/src/lib/api.ts`,
tests in `server/test/` (routes) and `web/src/test/api.test.ts`.

**Do:**
- `GET …/subagents/:toolUseId/messages?limit=n`: the newest n, `droppedCount`
  raised by what was left out; absent → unchanged.
- `GET …/tasks/:taskId/output?maxBytes=n`, clamped to `OUTPUT_TAIL_BYTES`;
  absent → unchanged; a non-number → ignored.
- `PATCH /api/sessions/:id` and `PUT /api/sessions/:id/tags` publish the
  session's upsert on `sessions` (as `PUT …/pinned` does).
- `configureApi` gains optional `subagentPageSize` and `taskOutputMaxBytes`;
  `api.subagentMessages` and `api.taskOutput` append `limit` / `maxBytes`
  when they are set.

**Tests:** the two parameters (absent, set, over the cap, garbage); the two
publishes (a subscribed hub sees one upsert each);
`configureApi` appending the parameters (and not appending them
by default).

**Done:** suites green; desktop behaviour unchanged with nothing configured.

### A4: Clear keeps what it cleared

**Goal:** spec § 4 Server and Decision 7 — on the Mac, for the desktop and
the phone alike, Clear's new session keeps the cleared session's folder,
tag(s), model and permission mode; the two inherit settings go.

**Files:** `server/src/api/routes.ts` (`POST …/clear`),
`server/src/db/database.ts` (the two defaults), `web/src/panels/Settings.tsx`
(the "New session inherits" row and the two "used by Clear" clauses),
`server/test/routes.test.ts`, `server/test/database.test.ts`,
`web/src/test/settings.test.tsx`.

**Do:** the new session takes `row.model` (null stays null, so it runs on
the default) and `row.permission_mode` (null → the default mode) and copies
the old session's `manual` and `manual_removed` tag rows; nothing reads
`inherit_tags` or `inherit_permission_mode` any more. Remove their defaults
and the Settings row; drop "and used by Clear" / "and to sessions created
by Clear" from the two descriptions. A value already stored in a database
is left alone and ignored. The Settings layout change is checked by the
main session in Z2; take nothing from the eye here.

**Tests:** the existing inherit test in `routes.test.ts` is rewritten: with
the old settings set to `'false'` and different defaults, the new session
still has the old cwd, model, mode and effective tags; a session with a
null model and mode gets null / the default mode; a removed rule tag stays
removed. The settings tests that toggled the two checkboxes go;
`database.test.ts` loses the two defaults.

**Done:** suites green; Clear on the desktop dev app keeps the tag and mode
of a session whose tag and mode differ from the defaults.

---
---

## Track B — The `file_get` message

### B1: `file_get` end to end

**Goal:** the phone reads files the session may show, in blob frames (spec
§ 2 Server and shared).

**Files:** `shared/src/remote/messages.ts`, `shared/src/remote/client.ts`,
`server/src/remote/phoneSession.ts`, `server/src/remote/service.ts` (pass the
file reader into `PhoneSession`), `server/src/images/store.ts` (export
`sniffDims`), `server/src/files/preview.ts` only if a text-bytes reader with
a cap is cleaner there, tests `server/test/remotePhoneSession.test.ts`,
`server/test/remoteClient.test.ts`, `shared` client tests.

**Do:**
- `PhoneMessage` gains `{ t: 'file_get', id, session, path, as: 'image' |
  'text' }`; `path` bounded by `FILE_PATH_MAX_CHARS`, no control characters.
  `blob_meta` gains optional `size`, `w`, `h`. `PROTOCOL_VERSION` unchanged.
- `PhoneSessionOptions` gains a `files` dependency: `(session, path, as) →
  { status, bytes?, mediaType?, size?, w?, h? }`, built in `service.ts` from
  the session row, `resolveForSession`, `readImageFile` and the text read
  capped at `PHONE_TEXT_PREVIEW_MAX_BYTES` (a server constant). Answers as
  the spec lists (200 / 403 / 404 / 413 / 415), then chunks with
  `chunkBlob` exactly as `onBlobGet` does.
- `RemoteClient.getFile(session, path, as, { onProgress?, idleTimeoutMs? })`
  next to `getBlob`, sharing its reassembly; `onProgress(received, total)`
  per chunk; the timeout re-arms per chunk.

**Tests (security boundary first):** inside cwd → 200 and the bytes;
outside and not named → 403; named absolute → 200 via realpath (the `/tmp`
→ `/private/tmp` case); missing file → 404; unknown session → 404; text
over the cap → 413 with `size`; binary as text → 415; non-image as image →
415; `w`/`h` for a PNG; a malformed `file_get` (control character, too long,
missing `as`) is dropped. Client: progress per chunk in order, idle timeout,
non-200 `blob_meta`, tunnel lost mid-file. End to end through the real
relay in `remoteClient.test.ts`: a PNG named in a fixture transcript read
in more than one chunk.

**Done:** server, shared and web suites green; relay untouched.

---

## Track F — Phone foundation

### F1: Navigation, sheets, constants

**Goal:** the screens and sheets every feature track plugs into, so wave 2
never edits the same file twice.

**Files:** `web/src/mobile/state.ts`, `MobileApp.tsx`, `ui.tsx`,
`constants.ts`, new stub files listed below, `web/src/test/mobilestate.test.ts`.

**Do:**
- Navigation: `Screen` gains `subagent`, `task`, `file`; state carries the
  pushed item (`{ sessionId, toolUseId }`, `{ sessionId, taskId }`, `{
  sessionId, path, line, ref?, messageId? }`). `back()` from a pushed
  screen returns to its session, not the list; the hardware back button
  follows the same rule. Actions `openSubagent`, `openTask`, `openFile`.
- `MobileApp` renders the three screens from stub components:
  `screens/SubagentScreen.tsx`, `screens/TaskScreen.tsx`,
  `screens/FileScreen.tsx` (each a placeholder returning the header and
  "‹" only).
- `ui.tsx`: `BottomSheet` (the canvas's dropdown shell: backdrop tap
  cancels, content swappable in place for confirms) and `ConfirmSheet`
  (eyebrow, title, body, a cyan primary and an outlined Cancel directly
  below; canvas 10b GO BACK, 10g STOP TASK, 10i /END and /CLEAR).
- `constants.ts`: `FILE_IDLE_TIMEOUT_MS`, `FILE_CACHE_MAX_BYTES`,
  `PHONE_TEXT_PREVIEW_MAX_BYTES`, `PHONE_OUTPUT_LINES`,
  `PHONE_OUTPUT_TAIL_BYTES`, `PHONE_SUBAGENT_PAGE`, with the spec's values
  and a doc comment each. `PHONE_OUTPUT_TAIL_BYTES` must leave room for JSON
  escaping inside `MAX_INNER_BYTES`; say so in its comment.

**Tests:** `back()` for every screen, pushed screens included; opening a
pushed screen keeps the session id.

**Done:** green; the app builds and every existing screen behaves as before.

### F2: The session screen's slots

**Goal:** `SessionScreen` and the composer take every feature's parts
without wave 2 editing them. Starts after A2 (it uses `harnessStep` and the
`configureApi` fields).

**Files:** `web/src/mobile/screens/SessionScreen.tsx`,
`screens/SessionComposer.tsx`, `composer.ts`, `boot.ts`, `forget.ts`, new
`web/src/mobile/stateWords.ts`, the stub files below,
`web/src/test/mobilecomposer.test.ts`, new `web/src/test/mobilestatewords.test.ts`.

**Do:**
- Header row 1: title, then `session/ContextReadout.tsx` (stub, T5) and
  `session/SessionMenuButton.tsx` (stub, T4). Row 2: the state line from
  `stateWords.ts`, `session/HarnessProgress.tsx` (stub, T1),
  `session/MoonsChip.tsx` (stub, T3, replacing today's moon dots), the
  model label and mode dot as now.
- `stateWords.ts` (pure): the header's state word for every case — the 9b
  words, NEEDS YOUR OK (gate waiting), REVIEWER READING (gate reviewing),
  WAITING FOR LIMIT · hh:mm / IDLE · LIMIT UNTIL hh:mm (canvas 10k `wState`),
  and the asleep "WAS … · as of" forms. Reuse `formatResetAt`.
- Transcript: `withHarnessRows` over the messages with the store's
  `harnesses`, `harnessRemoved`, `harnessEvents` (desktop `Transcript.tsx`
  does the same); pass `subagents`, `backgroundTasks`, `onOpenSubagent`,
  `onOpenTaskOutput` to `TranscriptView` (calling F1's navigation); the
  footer becomes `session/TranscriptTail.tsx` rendering
  `session/GateCard.tsx` (stub, T1), `session/LimitNotice.tsx` (stub, T5)
  and the existing offline divider.
- Selection: leaving the session for a pushed screen keeps `ui.selectedId`;
  only going back to the list clears it (the store's subscription would
  otherwise close its subagent and task views).
- Composer: `composer.ts` placeholder selection gains the reopened-gate
  case ("What should change in step n?") and the limit-wait case ("Queue a
  message for hh:mm…"); a mobile-state intent `focusComposer({ kind:
  'reopen', step })` focuses the field and shows the canvas's hint "to step
  n · stays a gate" (canvas 10b third phone). T1 only calls the action.
- `boot.ts`: `configureApi({ subagentPageSize: PHONE_SUBAGENT_PAGE,
  taskOutputMaxBytes: PHONE_OUTPUT_TAIL_BYTES })`; call `installFileOpen()`
  from a stub `web/src/mobile/files/open.ts` (T2 fills it).
- `forget.ts`: also call `clearHarnessCache()` (stub
  `web/src/mobile/harness/harnessCache.ts`, T1) and `clearFileCache()`
  (stub `web/src/mobile/files/fileCache.ts`, T2).

**Tests:** `stateWords` for every case, asleep included; the placeholder
selection (decision pending, reopened gate, limit wait, plain); the
selection rule on navigation (pushed screen keeps it, list clears it).

**Done:** green; typecheck and build clean; the session screen looks as it
does today apart from the moons chip stub and empty slots.

---

## Track T1 — Harness gate

### T1.1: The gate card and its answers

**Goal:** spec § 1 — 10b's card, Approve / Reopen / Go back, the folded
line, the Go back sheet, and 10c's reviewer state with Decide myself.

**Files:** `web/src/mobile/session/GateCard.tsx`, new
`web/src/mobile/harness/gate.ts` (pure), `harness/GoBackSheet.tsx`, new
`web/src/test/mobileharness.test.ts`.

**Do:** the card from the harness (`stepKind`, `state.summary`/`evidence`,
`openQuestions`, `startHead..endHead`, verify from the last `ticked` event,
next step). Answers through `act(...)` with `api.approveHarnessStep`,
`api.reopenHarnessStep`, `api.decideHarnessStepMyself`; Reopen then calls
`focusComposer`. Go back confirms in `ConfirmSheet`, then
`goBackToStep(...)` and sends the rewound text with the store's
`sendPrompt` (spec Decision 6). A failed answer leaves the card live
with one line under it. Thumbnails per Decision 4 (image paths named
in the summary/evidence, opened through F1's `openFile`); the range without
a count per Decision 5.

**Tests (`gate.ts`):** what the card shows per step state (waiting,
reviewing, approved-just-now → fold line, reopened, rewound); the image
paths it picks out of a summary; the Go back sheet's lines (with and
without a range, with something running).

**Done:** green; on the emulator against a dev Mac a gate is approved,
reopened, gone back and taken from the reviewer.

### T1.2: Steps sheet, record, header progress

**Goal:** 10b fourth phone and the header segments.

**Files:** `web/src/mobile/session/HarnessProgress.tsx`,
`harness/StepsSheet.tsx`, `harness/RecordSheet.tsx`, extend
`harness/gate.ts` and its test.

**Do:** segments + "n/m ▸" open the sheet; the rail from `railItems` /
`MARKER`; done rows open `RecordBody` (`wide: false`) in a pushed sheet.
Nothing animates.

**Tests:** segment colours per step state as the canvas's `segC` decides
them (state → tone, not the colour values).

**Done:** green.

### T1.3: Asleep and offline harness

**Goal:** 10c second phone; the card and sheet readable from cache.

**Files:** `web/src/mobile/harness/harnessCache.ts` (replace F2's stub),
`GateCard.tsx`, `StepsSheet.tsx`.

**Do:** cache the harness and its events per session with `asOf` when read
live; render from it while asleep; the three buttons collapse into the
locked line; uncached thumbnails are a dashed box.

**Tests:** cache parse (bad JSON → nothing), write-then-read.

**Done:** green; with the Mac's server stopped, the card and the sheet
still open.

---

## Track T2 — Images and paths

### T2.1: The open seam in `web/`

**Goal:** a press on a path or a thumbnail can be routed by the phone; the
desktop is unchanged.

**Files:** new `web/src/lib/fileOpen.ts`, `web/src/panels/PathButton.tsx`,
`ImageThumb.tsx`, `MessageView.tsx` (a context carrying the message id and
its image list), `web/src/mobile/files/open.ts` (replace F2's stub), tests
`web/src/test/fileopen.test.ts`.

**Do:** `configureFileOpen({ open, longPress? })`; with nothing configured
PathButton and ImageThumb behave exactly as now (file viewer, `Lightbox`),
and a path that is not pressable stays plain text. Configured, a press
calls `open({ kind: 'path' | 'ref', … , messageId })` and long-press calls
`longPress(path)` — on a link, and on a matched path that is not pressable
(`isPressablePath` false), which is then drawn as a plain mono span that
only carries the long-press (spec Decision 8: such a path is never a link).
The phone's `installFileOpen` sends presses to F1's `openFile` and
long-press to `copyToClipboard`.

**Tests:** default path (no config) does not call the hook and leaves
non-pressable paths as plain text; configured, a press calls it with the
message's id and a non-pressable path gets the long-press but no press;
the message context lists the images of a message in order (attached refs,
then image paths in its text).

**Done:** green; desktop transcript behaves as before (spot-check in the
dev app).

### T2.2: Fetching and the cache

**Goal:** bytes over `file_get`, one bounded cache for all images and text
previews.

**Files:** `web/src/mobile/transport/clientRef.ts` (add `getFile` to
`TunnelClient`), `transport/imageResolver.ts`, `platform/imageCache.ts`,
`web/src/mobile/files/fileCache.ts` (replace F2's stub), new
`files/fileResolver.ts`, new `files/route.ts` (pure), tests
`web/src/test/mobilefiles.test.ts`.

**Do:** `route.ts` decides image (`isImagePath`) or text
(`hasTextExtension`) from the path; nothing else ever reaches it, because
nothing else is a link. A 413 or 415 from the Mac becomes the
"can't be shown on the phone" answer with the size when known.
`fileCache.ts`: an index of entries `{ key, bytes, lastOpened, readAt, w, h
}`, eviction least-recently-opened first past `FILE_CACHE_MAX_BYTES`; ref
entries move under it. `fileResolver.ts` reads through `getFile` with
`onProgress` and `FILE_IDLE_TIMEOUT_MS`, always refetching a path online
and falling back to the entry asleep.

**Tests:** routing; 413 / 415 → can't be shown; eviction order and the
bound; a ref entry never refetched, a path entry refetched online; offline
→ entry with its age; offline and uncached → "waits for the Mac".

**Done:** green.

### T2.3: The viewer

**Goal:** 10d second phone and 10e's states, except NOT AN IMAGE OR TEXT
(replaced by T2.4's can't-be-shown line, spec Decision 8).

**Files:** `web/src/mobile/screens/FileScreen.tsx` (replace F1's stub), new
`files/ImageViewer.tsx`, `files/zoom.ts` (pure gesture math), test in
`mobilefiles.test.ts`.

**Do:** black full-screen viewer, chrome over the image, pinch to the
canvas's maximum, double-tap toggles the canvas's zoom ↔ fit, swipe between
the message's images, ‹ or swipe down back. States from the resolver:
loading (reserved box, byte bar), couldn't load + Retry, gone, cached chip,
not cached, can't be shown (T2.4). Attach touch listeners with `{ passive:
false }` (web `CLAUDE.md`: React's touch handlers are passive).

**Tests (`zoom.ts`):** clamping scale and pan to the image bounds,
double-tap toggle, the swipe-down threshold.

**Done:** green; on the emulator an agent's `/tmp` screenshot named in the
transcript opens, zooms and pages.

### T2.4: Text preview and "can't be shown"

**Goal:** 10d third phone, and the plain answer for a file that looked
viewable but is not.

**Files:** new `files/TextPreview.tsx`, `files/CantShow.tsx`,
`FileScreen.tsx`.

**Do:** read-only preview with line numbers, scroll to `:line`, Wrap
toggle, Copy path. Can't be shown: one plain line that this file can't be
shown on the phone, the path and size, Copy path — nothing that opens or
runs anything on the Mac. There is no canvas artboard for it; take its
type, inks and spacing from 10e's state captions and the 10d chrome, and
the main session settles it in Z2.

**Tests:** none beyond T2.2's routing (rendering only).

**Done:** green; a `.md` named in a transcript previews; a text file over
the phone cap says it can't be shown and copies its path; a `.pdf` path in
the transcript is plain text that long-press copies.

---
---

## Track T3 — Subagents and tasks

### T3.1: Moons chip, sheet and subagent screen

**Goal:** 10f.

**Files:** `web/src/mobile/session/MoonsChip.tsx` (replace F2's stub), new
`web/src/mobile/subagents/MoonsSheet.tsx`, `screens/SubagentScreen.tsx`
(replace F1's stub), new `subagents/model.ts` (pure), test
`web/src/test/mobiletasks.test.ts`.

**Do:** chip "n · ▣ m" opens the sheet (subagents then tasks, running
first); the screen uses the store's `openSubagent` (paged through A3's
`limit`), header from `taskStateFor` / `elapsedMsFor` /
`subagentModelFrom`, TASK FROM block, following-live with pause, RESULT
block and END OF SUBAGENT when done, the no-replies line and Open
<parent>. A moon without `toolUseId` is not openable.

**Tests:** sheet ordering; the header state per subagent state (running,
done, stream lost, asleep).

**Done:** green; a live subagent follows within a second on the emulator.

### T3.2: Task output screen and Stop

**Goal:** 10g and 10h.

**Files:** `screens/TaskScreen.tsx` (replace F1's stub), new
`subagents/StopTaskSheet.tsx`, `subagents/tasks.ts` (pure), extend
`mobiletasks.test.ts`.

**Do:** the store's `openTaskOutput` / `applyTaskOutputEvent`, lines capped
at `PHONE_OUTPUT_LINES` (`appendOutput` limit), follow / pause with "N new
lines", Stop only while running → `ConfirmSheet` → `stopTask`; end lines
per `tStates` in the canvas script; "stopped by you" only for a stop this
phone sent (Decision 3); 410/404 → OUTPUT GONE; paths in the output
open F1's `openFile`.

**Tests (`tasks.ts`):** state word and end line per task (running, exit 0,
exit ≠ 0, stopped by this phone, stopped otherwise, unknown, gone, asleep);
the new-lines counter while paused.

**Done:** green; stopping `npm run dev` from the phone ends it on the Mac.

---

## Track T4 — The ⋯ sheet

### T4.1: Menu, confirms, rename, tag, pin

**Goal:** 10i and 10j.

**Files:** `web/src/mobile/session/SessionMenuButton.tsx` (replace F2's
stub), new `web/src/mobile/menu/SessionMenuSheet.tsx`, `menu/RenameSheet.tsx`,
`menu/TagSheet.tsx`, `menu/sessionMenu.ts` (pure), test
`web/src/test/mobilemenu.test.ts`.

**Do:** items in the canvas's order; End/Clear confirm in place with the
"stops with it" / "keeps" lines; optimistic rename, retag (one tag,
replacing) and pin with rollback; Clear carries an unfinished harness and
opens the new session; terminal and asleep variants; the ended-session item
set (spec § 4). Clear's "keeps" lines are the session's own folder,
tag(s), model and mode — what the Mac keeps since A4 (spec Decision 7).

**Tests (`sessionMenu.ts`):** items per kind (Orbital live, Orbital ended,
terminal, asleep); End's "stops with it" lines from running subagents and
tasks; Clear's "keeps" lines from the session itself (a null model or mode
named as the Mac's default); Save disabled for an empty or unchanged title.

**Done:** green; a rename from the phone shows on the desktop at once.

---

## Track T5 — Limit wait and context

### T5.1: Readout, sheet and notice

**Goal:** 10k and 10l (the list row is L1's).

**Files:** `web/src/mobile/session/ContextReadout.tsx`,
`session/LimitNotice.tsx` (replace F2's stubs), new
`web/src/mobile/limits/ContextSheet.tsx`, `limits/context.ts`,
`limits/limitCopy.ts` (pure), test `web/src/test/mobilelimits.test.ts`.

**Do:** readout "used / window" + ring from `contextFractionFor` /
`contextWindowFor`, three brightness levels at the canvas's thresholds,
unmeasured and unknown-window forms; hidden for terminal sessions (Open
question 1); tap → sheet. Notice in its four states from `limitWaitCopy`
with the wait's own settings (A2), Cancel / Undo via
`api.cancelLimitWait` / `api.undoLimitWait` with no local change, queued
bubbles listed, asleep wording without Cancel, absolute times only (Open
question 9).

**Tests:** level per fraction at and around both thresholds; readout
formatting (unmeasured, unknown window, over window); notice copy per state
(waiting, cancelled, auto off, asleep, queued counts).

**Done:** green; on a dev Mac with a simulated wait the notice cancels and
undoes from the phone.

---

## Track L — The session list

### L1: 10a, all five in one list

**Goal:** 10a online and asleep.

**Files:** `web/src/mobile/sessionList.ts`,
`web/src/mobile/screens/SessionListScreen.tsx`,
`web/src/test/mobilelist.test.ts`.

**Do:** groups NEEDS INPUT, WORKING, WAITING FOR LIMIT, IDLE, then pinned
ended rows (headless, "· ended, pinned"), then the ENDED fold; pinned rows
first within a group in pin order with the pin mark; the gate reason "◆
Harness · step n of m needs your OK" from `harnessStep`, still diamond, no
elapsed time; the limit row's third line in its four forms (waiting,
cancelled, asleep, terminal never); moons rows 44 px ending in › opening
F1's `openSubagent` / `openTask`; tasks after a · in the collapsed summary;
the asleep variants' lines.

**Tests:** group membership and order (a waiting gate in NEEDS INPUT, a
reviewing gate not; a limit wait between WORKING and IDLE; pinned first;
pinned-ended above the fold; unpinned ended folded); the gate reason and
the limit third line per state; the collapsed summary with and without
tasks.

**Done:** green.

---

## Wave 3

### Z1: Integration (controller)

- Raise `MIN_SERVER_VERSION` to the desktop version this branch ships, once
  the owner picks the desktop bump (spec § 7). Ask with AskUserQuestion,
  proposal first: desktop minor, phone minor, relay none.
- Changelog lines under `## [Unreleased]` in `desktop/CHANGELOG.md` and
  `mobile/CHANGELOG.md`, plain words, one line per thing the user notices.
  The desktop's include Clear keeping the folder, tags, model and mode with
  the "New session inherits" settings gone (spec § 6 Desktop impact).
- Full verification: server, shared, web suites; typecheck; lint;
  `npm run build -w @orbital/mobile` (bundle guard).
- Spec: add an "As built" section for every decision a task took that the
  spec left open; set `status: done` once merged.
  Mark the feature map's five items as built; set
  `phone-opens-files-the-session-named` to `done`.

### Z2: Fidelity pass (main session)

Not an implementer task. The main session builds the phone app, runs it on
a real phone paired with a dev Mac, and compares every 10a–10l state with
the canvas (DesignSync, `Feature - Mobile next`), fixing values in place.
States that need setup: a harness at a gate and with the reviewer reading,
an agent screenshot in `/tmp`, a running and a failed background task, a
subagent, a pinned ended session, a simulated limit wait
(`/api/dev/...` where it exists), the Mac asleep (server stopped). On the desktop: Settings → Sessions without the "New session inherits" row (A4).
