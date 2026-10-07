---
id: desktop-vs-phone-feature-map
title: Desktop vs phone — what each offers, and what the phone should get next
type: idea
status: backlog
domain: remote
related:
  - 2026-10-02-mobile-app-design
  - switch-model-and-mode-from-the-phone
  - phone-opens-files-the-session-named
  - mobile-follow-ups
  - why-orbital
tags:
  - mobile
---
# Desktop vs phone — what each offers, and what the phone should get next

An inventory taken on 2026-10-05 (desktop 0.18.x, phone 0.1.2), read from
the code: `web/src/panels`, `map`, `ui`, `stats`, `limits`, `walkthrough`,
`lib/keymap.ts` and `panels/Settings.tsx` for the desktop;
`web/src/mobile/**`, `server/src/remote/allowlist.ts` and
`PHONE_ALLOWED_TOPICS` in `server/src/remote/phoneSession.ts` for the phone.

The yardstick is [[why-orbital]]: the phone exists for oversight while away
from the Mac — seeing what runs and what waits, answering, nudging a session
along, starting work. Anything that needs the Mac's screen, filesystem, IDE
or keyboard, or that configures the Mac, stays on the Mac.

A pattern worth knowing before the table: **many routes are already on the
allowlist with no phone UI behind them** — model, permission mode, end,
reopen, clear, pin, tags, rename (`PATCH`), subagent transcripts, task output
and stop, the walkthrough. The `subagent:` and `task-output:` WS topics are
allowed too. For those features the cost is the phone's UI alone.

Verdicts: **There** (on the phone already; gaps noted), **Add — high**,
**Add — later**, **Never** (with the reason). Rows marked
**There (0.3.0)** were **Add — high** on 2026-10-05 and shipped in phone
0.3.0 ([[2026-10-05-mobile-next-design]]); their "Phone today" column is
left as it was read then.

## The map

### Sessions & list

| Feature | Desktop | Phone today | Verdict | Why / cost |
|---|---|---|---|---|
| Session list grouped by state | Sidebar: Pinned, Active, History | 9a: needs input, working, idle, ended (collapsed) | There | The phone's grouping by state is the better fit for oversight. |
| Tag filter | Tag chips over the sidebar | Tag chips, counts of live sessions | There | — |
| Origin filter (Orbital / terminal) | Sidebar ACTIVE heading | None; terminal rows carry READ-ONLY | Never | The READ-ONLY mark answers the same question on a short list. |
| Search sessions | ⌘K-style search field | None | Add — later | Client-side over the store; no route. Matters once the ended list grows. |
| Pinned sessions | PINNED section, pin button, shortcut | Not shown, cannot pin | There (0.3.0) | `PUT /api/sessions/:id/pinned` is allowlisted. Show a pinned group on top; pin from the ⋯ sheet. |
| Subagents per session | Moons on the map, subagent list | Expandable moons row on the list, count in the header | There (read) | Rows are not tappable — see Transcript. |
| Next session needing input (⌘-chord) | Keyboard command | The NEEDS INPUT group is at the top | There | The group is the phone's equivalent. |
| Offline / Mac asleep | n/a (the Mac is the host) | Cached list "as of", Retry | There | Phone-only by nature. |

### Transcript

| Feature | Desktop | Phone today | Verdict | Why / cost |
|---|---|---|---|---|
| Transcript, paging older messages | `TranscriptView` in the detail panel | Same `TranscriptView`, pages of 30 | There | — |
| Folding tool runs, skill prompts | Shared | Shared | There | — |
| Edit diffs | Shared `DiffView` in tool rows | Shared | There | — |
| Images in the transcript, lightbox | Shared `ImageThumb` | Shared, bytes over the tunnel cache | There | Gap in [[mobile-follow-ups]]: an evicted blob URL blanks. |
| Streaming output | Shared | Shared | There | — |
| Compaction marks | Shared | Shared | There | — |
| Jump to bottom | Shared | Shared (`surface: 'phone'`) | There | — |
| Transcript check against the file | `useTranscriptCheck` in `App`/`SessionWindow` | Not mounted | Add — later | Same stall can hit the phone; the hook needs only `/messages`, which is allowlisted. Confirm first that the phone actually stalls. |
| Subagent transcript panel | Click a moon / subagent chip | Not reachable | There (0.3.0) | Route `GET …/subagents/:toolUseId/messages` and the `subagent:` topic are allowed; `TranscriptView` renders it. UI only: a pushed screen. |
| Background tasks: output, stop | Task chip → output panel, stop | Chip shows, does not open | There (0.3.0) | `GET …/tasks/:taskId/output`, `POST …/stop` and the `task-output:` topic are allowed. UI only. |
| Harness rows in the transcript | From `GET /api/sessions/:id/harness` | Route denied, so no harness rows (likely) | There (0.3.0) | Comes with the gate below. |
| File viewer (paths in the transcript) | `PathButton` → `FileViewer` | Path opens nothing | There (0.3.0, images) | `/api/files` is denied on purpose; [[phone-opens-files-the-session-named]] has the bounded design. New route shape + allowlist. |
| Rewind (pick mode) | Rewind button, `/rewind` | `/rewind` refused with a line | Add — later | `POST/DELETE …/rewind` not allowlisted; pick mode needs a touch design. Interrupt + a new message covers most phone cases. |
| Walkthrough of what a session changed | Own page, Narrate | None | Add — later | `GET …/walkthrough` and `/summary` are allowlisted; `…/narrate` is not. Reading a finished piece of work on the sofa fits; needs a phone layout of the page. |
| Session stats (quick dialog, row) | Header button, dialog | None | Add — later | `/api/stats/sessions/:id` denied. Retrospective, not oversight. |

### Composer & decisions

| Feature | Desktop | Phone today | Verdict | Why / cost |
|---|---|---|---|---|
| Composer (Tiptap, drafts kept) | `DetailPanel` composer | Shared `Composer`, return = newline | There | — |
| Slash-command completion | `GET /api/commands` | Same | There | Skill preview needs `/api/commands/content` (denied); unverified what the phone shows. |
| `@file` completion | `/api/files/complete` | None | Add — later | Denied: a path query; would need the same bounding as the file viewer. |
| Image attachments | Paste, drop, file picker | Camera, gallery, paste; downscaled | There | Images only; non-image files are refused. |
| File attachments (non-image) | Upload by path | Refused (`not_image`) | Never | The phone has no files of the Mac's to attach; a file from the phone has no path the session can read. |
| IDE selection slot | `IdeSlot` | None | Never | Needs the Mac's IDE. |
| Permission / plan cards | Shared cards | Shared, touch metrics | There | Gap: card stays tappable while the Mac sleeps ([[mobile-follow-ups]]). |
| Question cards | Shared | Shared | There | — |
| Composer as escape hatch (refuse with reason) | Yes | Yes | There | — |
| Harness gate (NEEDS YOUR OK): approve, decide myself, go back | Harness panel | Shown as NEEDS INPUT, cannot be answered | There (0.3.0) | The phone lists a session it cannot unblock. Needs allowlist entries for `GET …/harness`, `POST …/harness/steps/:index/approve`, `decide-myself`, `go-back`, and a step-summary sheet; `HarnessTranscriptRow` reuses. |
| Interrupt / Stop | Button, `StopDialog`, shortcut | Stop in the action row, shared `StopDialog` | There | — |

### Session control

| Feature | Desktop | Phone today | Verdict | Why / cost |
|---|---|---|---|---|
| New session | Dialog: dir, mode, model, prompt, tags | 9d: dir, mode, model, prompt, photos | There | Gaps: no custom "Other…" model, no tag, no harness start. |
| Switch permission mode | `ModeSwitcher` | Label only | Add — later | Routes allowlisted; `ModeCards touch` exists. UI only — [[switch-model-and-mode-from-the-phone]]. |
| Switch model | `ModelSwitcher` | Label only | Add — later | Same idea, same cost. |
| End session | Strip button, `EndDialog` | None | There (0.3.0) | `POST …/end` allowlisted. Sessions end only by hand, so ending from the phone keeps that rule. Goes in the ⋯ sheet. |
| Clear and start over | Strip button, `ClearDialog` | None | There (0.3.0) | `POST …/clear` allowlisted; the harness "continue" option has to come along. |
| Reopen an ended session | Yes | A send revives it | There (by sending) | `POST …/reopen` allowlisted if an explicit action is wanted. |
| Rename / regenerate title | Click the title, ⟳ | None | There (0.3.0, rename) | `PATCH /api/sessions/:id` allowlisted; `retitle` is not. |
| Change tag | Tag menu, shortcut | None | There (0.3.0) | `PUT …/tags`, `GET /api/tags` allowlisted. |
| Start a harness | Strip button, templates | None | Add — later | Needs harness routes and the template list; heavier than the gate. |
| MCP servers dialog (`/mcp`) | Dialog: enable, reconnect, login, config | `/mcp` refused with a line | Never | Login opens a browser on the Mac, config is the Mac's files. A read-only status line could come later. |
| Open in a new window | Detached session window | n/a | Never | Desktop window chrome. |
| Limit wait: "continues at …", cancel, undo | `LimitWaitNotice` in the transcript | Not shown | There (0.3.0) | `limitWait` already rides on the session; cancel/undo routes need the allowlist. Showing the wait is the cheap half. |

### Map & overview

| Feature | Desktop | Phone today | Verdict | Why / cost |
|---|---|---|---|---|
| 2D space map, planets, moons | three.js map | Glyphs on the list | Never | The list is the phone's map; three.js stays out of the bundle (bundle guard). |
| Tag clusters, planet size, labels | Map | n/a | Never | Map-only. |
| Map themes (archipelago, desk) | Settings → Appearance | n/a | Never | Map-only. |
| Black hole / trash, declutter | Map | n/a | Never | Map-only. |
| Context gauge (header, arc on planets, /compact badge) | Header gauges, planet arc | None | There (0.3.0) | `contextUsedTokens` is already on the session the phone holds; a small bar in the 9b header is UI only. |
| Git: branch | Header where-line | `⎇ branch` on rows and header | There | — |
| Git: worktree, PR, line changes | Header | None | Add — later | Data rides on the session from the store; `POST /api/branch-status/refresh` is not needed for reading. |
| Fit, deselect, frame rate | Map commands, settings | n/a | Never | Map-only. |

### Settings

| Feature | Desktop | Phone today | Verdict | Why / cost |
|---|---|---|---|---|
| Notifications rules | Settings → Notifications | 9f, the phone's own five rules | There | — |
| General (runtime, data, retention) | Settings → General | n/a | Never | Configures the Mac's runtime and disk. |
| Sessions (defaults, instructions, limits) | Settings → Sessions | Reads defaults for 9d | Never | Mac configuration; the phone consumes it through `/api/sessions/defaults`. |
| Permissions (guarded requests) | Settings → Permissions | n/a | Never | A security setting changed where the Mac is. |
| Tags & rules editor | Settings → Tags & rules | n/a | Never | Rule editing with previews is desk work; `/api/tag-rules*` denied on purpose. |
| Harness templates editor | Settings → Harness templates | n/a | Never | Authoring, not oversight. |
| Appearance | Settings → Appearance | n/a | Never | Map-only. |
| Mobile (pair, revoke) | Settings → Mobile | Pair / pair a different Mac | Never | Pairing is confirmed on the Mac by design; `remote` topic is absent from the phone. |
| Shortcuts | Settings → Shortcuts | n/a | Never | No keyboard on the phone. |
| Experimental | Hidden section | n/a | Never | Desktop dev toggles. |

### Notifications

| Feature | Desktop | Phone today | Verdict | Why / cost |
|---|---|---|---|---|
| Needs input / ended / failed | Native macOS notifications | Local notifications while connected, relay push otherwise, in-app banner | There | Push is generic once the OS kills the socket (by design, the ADR). |
| Sound | Opt-in | Opt-in, own channel | There | — |
| Error log, toasts | Error log panel, toasts | Errors feed the notifier only | Add — later | `/api/errors` denied; failures already notify. A log is for fixing the Mac, done at the Mac. |

### Stats & limits

| Feature | Desktop | Phone today | Verdict | Why / cost |
|---|---|---|---|---|
| Stats page (tiles, charts, findings) | `/stats` | None | Never (for now) | Retrospective analysis on a wide screen; not oversight. Revisit only if asked. |
| Plan limits page | `/limits` | None | Add — later | Useful before starting work from the phone. Needs `GET /api/limits` on the allowlist and the `limits` topic in `PHONE_ALLOWED_TOPICS`. |

### Other

| Feature | Desktop | Phone today | Verdict | Why / cost |
|---|---|---|---|---|
| Keyboard shortcuts, command menu | `lib/keymap.ts` | n/a | Never | No keyboard; touch has its own targets. |
| IDE bridge (open in IDE, diagnostics) | `/api/sessions/:id/ide/*` | n/a | Never | Needs the Mac's IDE. |
| Detached windows, window frames, tray, background mode | Electron | n/a | Never | Desktop window chrome. |
| Session spawns sessions (`spawn_session`) | Server-side | New sessions appear on the list | There | Reaches the phone through the `sessions` topic. |
| Session instructions, autoheal, auto title | Server-side | Same effect | There | Server-side; nothing to build. |
| Terminal sessions (read-only) | Shown | Shown READ-ONLY, ended ones revivable | There | — |

## Decided next (2026-10-05)

The owner's call on the table above: the phone is where you are *not* at the
desk, so what it needs most is to see what happened and to move a session
along. Switching model and permission mode is a desk concern and waits
([[switch-model-and-mode-from-the-phone]], later).

Next, as one batch:

1. **Answer a harness gate.** The phone already counts a waiting gate as
   NEEDS INPUT and cannot clear it — the one place it shows work it cannot
   move. New allowlist entries and a step sheet.
2. **See images, including by tapping a path.** An agent saves a
   screenshot and names its path; on the phone that path opens nothing
   today. Visual feedback matters most away from the desk. Images first,
   bounded to paths the session named ([[phone-opens-files-the-session-named]]);
   text files can follow on the same route.
3. **Open a subagent's transcript, and a background task's output.** Routes
   and topics allowed, shared `TranscriptView` — UI only.
4. **A ⋯ sheet on the session: end, clear, rename, pin, tag.** Every route
   allowlisted; it also settles what the canvas's `⋯` holds.
5. **Show a limit wait and the context gauge in the 9b header.** Both read
   data the session row already carries; cancel/undo of a wait needs two
   allowlist entries.

The screens for these are drawn in Claude Design before they are built.

**Shipped** in phone 0.3.0 (#23), all five. What is left on the phone is
the **Add — later** rows.

## Never on the phone

- **The map** — the list is the phone's map, and three.js stays out of the bundle.
- **IDE bridge and IDE selection** — needs the Mac's IDE.
- **Detached windows, tray, window chrome** — desktop-only by nature.
- **Keyboard shortcuts** — no keyboard.
- **MCP dialog** — login and config happen on the Mac.
- **Non-image file attachments** — the phone has no paths the session can read.
- **Mac configuration (General, Sessions, Permissions, Tags & rules,
  Harness templates, Appearance, Mobile, Experimental)** — you configure
  the Mac at the Mac. The allowlist denies `/api/settings` and
  `/api/tag-rules*` on purpose.
- **Stats page** — retrospective analysis, not oversight. Revisit if asked.
