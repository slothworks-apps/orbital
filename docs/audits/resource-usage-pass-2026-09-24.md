---
id: resource-usage-pass-2026-09-24
title: "Resource usage pass: what Orbital costs while nobody is looking at it"
type: audit
status: active
related:
  - every-openable-moon-mounts-an-html-portal-and-they-accumulate
  - 2026-09-22-desktop-background-mode-design
  - ambient-changes-republish-only-watched-sessions
tags:
  - performance
  - web
  - server
  - desktop
---

# Resource usage pass: what Orbital costs while nobody is looking at it

Question: after a week of features, does Orbital take CPU, GPU, memory or file
handles away from the tools it runs next to (WebStorm, Docker)? The answer is
yes, mainly through the map's render loop and the server's indexer.

## Measured on 2026-09-24

The installed Orbital.app was attached to the dev server, with the window open
and idle. Samples came from `top` at 2 s intervals over 12 s.

| process | CPU | memory |
|---|---|---|
| GPU process | 22–28 % | ~1.2 GB |
| renderer | 15–19 % | ~180 MB |
| main process | 1–3 % | 54 MB |
| server (dev, tsx) | 0–5 % | 160 MB, ~700 open files |

Scale of `~/.claude/projects` at the time: 494 transcripts (1.4 GB, the largest
is 36 MB) and 512 session rows.

## Findings, by impact

### 1. The map redraws every frame, forever (web)

`<Canvas>` in `web/src/map/SpaceMap.tsx` sets no `frameloop`, so r3f renders
at the display refresh rate (60 or 120 Hz) whether or not anything moved. The
canvas runs at dpr 2 with antialiasing. Every frame runs a callback for each
planet, moon, cluster label and the black hole, plus the camera and the
physics step. The physics step runs its pairwise loop even when every body is
asleep.

Some motion never ends:

- moons orbit forever, including finished moons that nobody has dismissed yet
  (see [[every-openable-moon-mounts-an-html-portal-and-they-accumulate]]);
- the selection ring spins;
- working and needs-input planets blink and breathe.

None of that motion needs more than 30 fps.

The cost is multiplied by the `backdrop-filter` blurs on the sidebar and
detail panel (`Panel.tsx`, 22–28 px). The canvas under them changes every
frame, so the compositor recomputes the blur every frame. That is the most
likely source of the GPU process's share.

Electron does not help. Closing the window only hides it
([[2026-09-22-desktop-background-mode-design]]), so the renderer lives from
launch to quit. And on macOS a window that is visible but unfocused (second
monitor, or partly behind the IDE) is not throttled.

Proposed direction:

- `frameloop="demand"`, where each per-frame callback reports whether it still
  moves something;
- transitions (drag, fall, state blend, camera) run at full rate;
- ambient motion runs on a budget: ~30 fps focused, ~10 fps unfocused, none
  hidden (`useWindowFocused` already exists).

A fully idle map would then draw nothing.

**Fixed 2026-09-24** ([[2026-09-24-map-frame-budget-design]]). The canvas
runs `frameloop="demand"`. Every frame callback reports whether it still moves
something, and while anything does, `FrameScheduler`
(`web/src/map/frameSchedule.ts`) draws at most `map_fps_focused` or
`map_fps_background` frames a second. Both are Settings → Appearance sliders,
60 and 30 by default. A hidden window draws nothing. The cap covers ambient
motion and transitions alike: the proposed split between the two was dropped
([[map-frames-are-drawn-by-a-refresh-ticker-under-one-cap]]). Measured in
Chromium on a 60 Hz display: a map with no moons and nothing selected draws
0 fps, apart from two to four frames on each store change. With the reticle spinning it
draws 59 fps focused, 30 blurred, 15 at a 15 fps cap, and nothing while
hidden. A map with any moon keeps drawing at the cap, because moons orbit
forever. The sloth pauses while the window is unfocused or hidden. The
docked panels and map controls no longer blur the canvas
([[docked-panels-are-opaque-not-frosted-glass]]).

### 2. Every transcript write triggers a full index pass, and 36 sessions re-parse every time (server)

The `projects/` watcher in `server/src/index.ts` calls `indexProjects` after a
500 ms quiet period on any event, memory-file edits included. Each pass:

- stats every `.jsonl` file;
- runs one SELECT per file;
- fully re-parses every changed file (no offset tracking);
- rewrites every rule tag (`regenerateRuleTags`).

The pass starts with an `UPDATE` in `server/src/indexer/indexer.ts` that
blanks titles matching `'/%' AND NOT LIKE '% %'` and resets `indexedMtime`.
But `extractMeta` (`server/src/transcript/parser.ts`) falls back to exactly
such a bare command (`/clear`) when a transcript has no other prompt. Those
sessions are blanked, re-parsed and re-titled `/clear` on every pass, forever.
Verified: 36 such rows in both `orbital/index.db` and `orbital-dev/index.db`.

Proposed fix:

- move the title reset to a one-off migration;
- index only the path the event named;
- one transaction per pass;
- regenerate rule tags only when cwd, title or permission mode changed.

**Fixed 2026-09-24.** The title reset is now migration
`0013_reset_stranded_titles` and runs once per database, so a `/clear`
fallback title stays as it is. After boot, a watcher event indexes only the
transcript it named (`indexPaths`). The debounce has a max wait
(`PROJECTS_MAX_WAIT_MS`), so a session that never stops writing still gets
indexed. Each pass is one transaction, and rule tags are regenerated only
when a new row, a changed cwd or a first title appears. The indexer never
writes the permission mode. The full pass still runs at boot.

### 3. One open file handle per historical transcript (server)

chokidar 4 no longer uses FSEvents on macOS and calls `fs.watch` per file. With
`depth: 2` over `projects/` that holds 494 transcript handles plus 161
`memory/` file handles, and the count grows with history.

A single `fs.watch(projectsDir, { recursive: true })` (FSEvents, zero per-file
handles), filtered to `<project>/<id>.jsonl`, would remove both. `tail.ts`
already watches a directory this way. The registry and GitStore watchers can
follow the same pattern.

**Fixed 2026-09-24.** Every server watch is now `fs.watch` on a directory:
`projects/` (recursive), `sessions/`, `ide/`, and each repository's git
directory. chokidar has been removed. A throwaway server against the same
`~/.claude` held 26 open files, none of them under `~/.claude`, down from
709 ([[recursive-fs-watch-instead-of-chokidar]]).

### 4. An editor selection change republishes every session of the workspace (server)

`ide/store.ts` coalesces selection bursts, then `republishCwds`
(`server/src/index.ts`) upserts *every* session row for that cwd: 140 for
acme-monorepo, 72 for orbital. Dragging a selection in WebStorm therefore
means hundreds of full session upserts per flush over the WebSocket. Each costs
2–3 queries and a re-render in the browser.

Only live sessions need the update, or a small `ide` frame that the client
applies by cwd.

**Fixed 2026-09-24.** A branch or editor change now republishes only the
sessions that are live or open in a window (`session:<id>` has a
subscriber). Ended sessions that are open still get it, because the header
shows their branch and their composer sends the selection. Opening a session
republishes it, so one skipped while closed is fresh when it is opened
([[ambient-changes-republish-only-watched-sessions]]).

### 5. Scrolling up through history re-parses the whole file per page (server)

`GET /api/sessions/:id/messages?before=` parses the full transcript to return
100 messages, so scrolling a 36 MB session to the top is quadratic. Every image
in each page also goes through `images.put`, whose `prune()` lists the whole
images directory. The walkthrough summary does a full parse every time a web
session is selected.

Proposed fix:

- cache parsed messages by (size, mtime), since transcripts are append-only;
- skip `prune()` when the image already existed;
- cache the walkthrough the same way.

**Fixed 2026-09-24.** The messages route keeps the finished wire messages of
the last few transcripts (`TRANSCRIPT_CACHE_SESSIONS`), keyed by path and
checked against size and mtime, so a page after the first neither parses nor
decodes images. The walkthrough is cached the same way, and its stamp
includes the subagent files. `putBytes` skips pruning when the image already
existed, and it keeps the directory's size in memory instead of listing the
directory on every write. Paging the three largest transcripts (26–36 MB,
about 20 pages each) against a throwaway server went from 86–120 ms per page
to 3 ms after the first. A repeated walkthrough summary went from
125–230 ms to 3 ms.

### 6. Re-render and memory costs while sessions are active (web)

- There is no `React.memo` on `Planet` or `Moon`, so every sessions event
  re-renders all of them.
- Each WS message commits separately. Batching per animation frame would help.
- Transcripts of every session ever selected stay in the store for the app's
  lifetime. Because `historyLoaded[id]` stays true and the `session:<id>`
  subscription follows only the selection, a session you come back to shows a
  stale transcript. That makes this a correctness question, not only a memory
  one (not yet reproduced).

### 7. Smaller items

- **Physics at double speed on 120 Hz.** `simulation.ts` computes substeps as
  `max(1, round(dt / TICK_SEC))`, so a 1/120 s frame still advances a full
  1/60 s step. A 60 fps cap from finding 1 hides this, but the step should
  accumulate time instead. **Fixed 2026-09-24:** `stepSimulation` accumulates
  time in `SimState.accumulator` and runs whole ticks from it, so the sim
  runs at the same speed at 30, 60 and 120 fps.
- **Infinite CSS animations.** The sloth drift/bob (`theme.css`) and
  `orbital-pulse` keep waking the compositor. They should pause when the window
  is unfocused, and `orbital-pulse` has no reduced-motion guard. **Fixed
  2026-09-24:** the sloth pauses while the window is unfocused or hidden.
  `orbital-pulse` keeps running, as the spec decided, and now has a
  reduced-motion guard.
- **Orphaned forked server.** It survives a force-quit or crash of the desktop
  main process, because only `before-quit` kills it. The next launch attaches
  to it, so orphans do not multiply.
- **Stack overflow risk.** `entries.push(...parseTranscript(...))` in
  `server/src/stats/transcript.ts` can throw a RangeError on very large files.
  **Fixed 2026-09-24:** a loop and `concat` instead of spreading.

## What is fine

- **Timers.** No polling loops (the only periodic timer is the 15 s WS
  heartbeat). Stats and elapsed-time tickers run only while visible.
- **WebSocket.** Messages are per-session deltas, stringified once per publish.
  Reconnect is a fixed 3 s.
- **SQLite and memory.** SQLite runs in WAL mode. Server-side buffers are
  capped and released on session end.
- **SDK children** are reaped.
- **three.js cleanup.** Materials and textures are disposed or shared.
- **Electron.** No switches forcing rendering and no power-save blockers.
  `backgroundThrottling` is left at its default.
