---
id: 2026-09-24-backlog-sweep
title: Backlog sweep — the open fixes, the rest of the resource audit, subagent streaming
status: active
type: plan
domain: web
related:
  - 2026-09-24-streaming-output-design
  - a-reopened-session-shows-the-transcript-it-was-left-with
  - panel-widths-read-innerwidth-once-and-never-again
  - formattoolduration-has-no-hour-unit
  - a-thinking-block-opens-a-turn-above-its-own-model-divider
  - subagent-question-ignores-agent-id
  - the-open-time-snapshot-reverts-a-completed-panel-to-running
  - spacemap-zoom-accumulation-flakes-under-load
  - tags-rules-keyboard-test-is-flaky-under-the-full-suite
  - file-viewer-owns-a-second-language-table
tags:
  - backlog
  - subagents
  - transcript
---
# Backlog sweep — implementation plan

**Goal:** Close every open `fix` document that needs no new design, finish the
resource audit's last item, and extend today's streaming to the subagent
panel. Five tasks, file-disjoint, each run by one agent in its own worktree
and merged by the controlling session.

**Rules that bind every task** (read `CLAUDE.md`, `web/CLAUDE.md` and
`docs/CLAUDE.md` first):

- Tests only where they catch a real regression (root `CLAUDE.md` § Tests).
- No design values from the eye; nothing here changes what the canvas draws.
- When a task closes a `fix` or `chore` document, set its `status: done` and
  add a short "Fixed <date>" note saying what was done. When a task chooses
  one way over another, write an `adr` in `docs/decisions` (format: copy
  `docs/decisions/thinking-is-its-own-chatmessage-role.md`). Run
  `atlas validate` before committing.
- Verify before reporting: `npm run typecheck -w web` (and `-w server` where
  touched), `npx vitest run` in the touched workspace, `npx eslint <changed
  files>`. Two server tests (`health`, `staticServe`) fail when `ORBITAL_*`
  variables are in the environment; run them with
  `env -u ORBITAL_STATIC_DIR -u ORBITAL_RESOLVE_PATH -u ORBITAL_MIGRATIONS_DIR`.
- Commit on your branch with a message in the repository's style
  (`fix(web): …`, `feat(server,web): …`). Do not push. Do not touch
  `desktop/package.json`'s version.
- Refer to constants by name in comments, never restate their values.

---

## Task 1 — transcript formats: hours in `formatToolDuration`, thinking moves the model divider

Closes [[formattoolduration-has-no-hour-unit]] and
[[a-thinking-block-opens-a-turn-above-its-own-model-divider]]. Read both
documents first.

**Ruling on the hour form** (the fix doc asks for a design; none exists, so
this is decided here): past an hour the reading is two units, `2h 0m`,
`2h 14m`, `487m 12s` becomes `8h 7m`. Seconds are dropped past an hour, the
way seconds are already the unit dropped past a minute in `formatDuration`.
Below an hour nothing changes (`0.3s`, `42s`, `1m 4s`). Write the ADR for
this choice (`docs/decisions/tool-duration-drops-seconds-past-an-hour.md`).

**Ruling on the divider**: the narrow version. `insertModelDividers` in
`web/src/panels/TranscriptView.tsx` reads `model` off `thinking` rows as well
as `assistant` rows, so a turn that opens with thinking gets its divider
above the thinking block. No notion of turns is introduced.

- [ ] `formatToolDuration` in `web/src/lib/format.ts`: add the hour band;
      extend `web/src/test/format.ts` (or wherever its tests live) with the
      boundary cases (59m 59s, 60m, 8h 7m).
- [ ] `insertModelDividers`: widen the role check; add one test in
      `web/src/test/transcriptview.test.tsx` where a model switch's first row
      is a thinking block and the divider sits above it.
- [ ] Update `insertModelDividers`'s own doc comment ("consecutive assistant
      messages") to say what it anchors to now.
- [ ] Close both fix docs, write the ADR, `atlas validate`, commit.

## Task 2 — the rest of the resource audit: store memory, memoised bodies, batched socket commits

Closes [[a-reopened-session-shows-the-transcript-it-was-left-with]]. Read
it, and read `select()` in `web/src/store/store.ts` — a return to a
deselected session already refetches and replaces its transcript, so
dropping the transcript on deselect costs nothing the user can see.

- [ ] **Drop a deselected session's transcript.** When `ui.selectedId`
      moves away from a session (in `select()`, and in the paths that set
      `selectedId: null` — `App.tsx`'s escape layer, `DetailPanel`'s
      collapse, `SpaceMap`'s click-away, `setDetached`), delete
      `transcripts[id]` and `historyLoaded[id]` for the session left behind.
      Keep a session's transcript while it is selected or open in this
      window's subagent panel. Prefer one store subscription (like the
      existing `useOrbital.subscribe` near the end of `store.ts`) over
      touching every caller. Optimistic `local:` turns of the session left
      behind are dropped with it — the file echo is what `select()` fetches.
      Test: select A, select B, A's transcript is gone; select A again, it is
      fetched.
- [ ] **Memoise `Planet` and `Moon`** (`web/src/map/Planet.tsx`,
      `web/src/map/Moon.tsx`) with `React.memo`. Check what props they take:
      a prop that is a fresh object or closure each render defeats the memo,
      so stabilise those at the call site (`useCallback`/`useMemo`) rather
      than writing a custom comparator. Measure before and after with a
      sessions-topic event on a map of ~30 planets (a quick `console.count`
      or React Profiler in a throwaway test is enough) and put the numbers in
      the commit message.
- [ ] **Batch socket commits per animation frame.** In
      `web/src/lib/ws.ts`, or in the store's handlers, coalesce the
      `sessions`-topic `upsert`/`status` events that arrive within one frame
      into one store commit. Do NOT batch `session:<id>` events — the
      transcript relies on their order and the delta path
      (`applySessionEvent`, `event: 'delta'`) already coalesces on the
      server. Keep `ws.test.ts` green; add a test that two `sessions` frames
      in one tick produce one store write.
- [ ] Close the fix doc, `atlas validate`, commit.

## Task 3 — one viewport-width source, and the file viewer's duplicate language table

Closes [[panel-widths-read-innerwidth-once-and-never-again]] and
[[file-viewer-owns-a-second-language-table]]. Read both first.

- [ ] Add `useViewportWidth()` in `web/src/lib/useViewportWidth.ts`: a
      `resize` listener on `window`, updated at most once per animation
      frame, returning `window.innerWidth`. jsdom drives it by setting
      `window.innerWidth` and dispatching `resize`.
- [ ] Replace every render-time `window.innerWidth` read in
      `web/src/App.tsx`, `web/src/SessionWindow.tsx`,
      `web/src/panels/DetailPanel.tsx`, `web/src/panels/Sidebar.tsx` and
      `web/src/map/SpaceMap.tsx` with the hook. `web/src/ui/usePopupPosition.ts`
      reads it inside an event handler, not during render — leave it. The
      pure `parse*Width`/`resolvePanelPairWidths` helpers in `store.ts` keep
      their viewport argument; only the source of the number changes.
- [ ] Test: with a stored detail width near the ceiling, shrinking
      `window.innerWidth` and dispatching `resize` re-clamps the pair
      (`resolvePanelPairWidths` output changes without any store write).
      One test, in `web/src/test/layout.test.ts` or `app.test.tsx`, whichever
      already mounts the pair.
- [ ] `web/src/panels/FileViewer.tsx`: delete `LANGUAGE_BY_EXTENSION`,
      `extensionOf` and `languageFor`; call `languageFromPath` from
      `web/src/lib/highlight.ts`. Existing file-viewer tests must stay green.
- [ ] Close the fix doc and the chore, `atlas validate`, commit.

## Task 4 — subagents: streaming into the panel, a completed agent stays completed, a subagent's question is refused

Extends [[2026-09-24-streaming-output-design]] (read it and the ADR
[[streamed-text-rides-as-offset-deltas-on-the-rows-id]] first — the server
mechanism already exists in `server/src/runner/runner.ts`: `onStreamEvent`,
`flushStream`, `streamedIdFor`). Closes
[[the-open-time-snapshot-reverts-a-completed-panel-to-running]] and
[[subagent-question-ignores-agent-id]].

- [x] **Subagent streaming, server.** Today `pump()` drops `stream_event`
      frames whose `parent_tool_use_id` is set. Route them into a stream
      state keyed by `parent_tool_use_id` (one `StreamState` per running
      agent, not one per session) and publish their deltas on
      `subagent:<sessionId>:<toolUseId>` with the same `delta` shape the
      session topic uses, plus `droppedCount` like the topic's `message`
      events carry. The complete subagent frame (the existing
      `parent_tool_use_id != null` branch) flushes first and converts with
      `streamedIdFor` against that agent's stream, so the final block reuses
      the delta's id. The `SubagentTranscripts` buffer stores complete
      messages only; a panel opened mid-stream sees the tail grow and then
      the complete block replace it, as the spec allows. Tests in
      `server/test/runner.test.ts` next to `describe('streaming output')`:
      a subagent stream publishes deltas on its own topic and nothing on
      `session:<id>`; two agents streaming at once do not mix rows.
- [x] **Subagent streaming, web.** `SubagentEvent` in `web/src/store/store.ts`
      gains the `delta` variant; `applySubagentEvent` applies it exactly as
      `applySessionEvent` does (create a partial row, grow by offset, ignore
      a delta behind the row, replace on the complete message with the same
      id). Reuse the `streamEnds` bookkeeping. `SubagentPanel` renders a
      partial row like any other; the caret rule is `TranscriptView`'s
      already. Tests in `web/src/test/subagentstore.test.ts`.
- [x] **Last known live agent.** In `web/src/panels/SubagentPanel.tsx`, keep
      a `lastKnownLive` ref that is written whenever the live lookup
      resolves, and fall back to it (not to `panel.subagent`) when the live
      lookup misses. Do not add a second writer to `subagentPanel.subagent`
      — the ADR
      `the-panel-reads-its-agent-live-not-the-snapshot-it-opened-with`
      explains why. Test: open on a working agent, apply an `upsert` that
      ends it, then an `upsert` with `subagents: []`; the header stays
      `completed`. Amend that ADR with a "Consequences" note pointing at the
      new ref.
- [x] **A subagent's question is refused.** `Runner.decide()` reads
      `opts.agentID`; when it is set and the tool is a question, resolve
      `{ behavior: 'deny', message: 'Orbital cannot relay a question asked
      from inside a subagent; ask the parent session instead.' }` and park
      nothing. Permission asks from a subagent keep today's path (the parent
      session's card can answer them). Ruling: refuse rather than route —
      nothing observed on this machine has ever asked, and a card the panel
      renders read-only is a promise nobody can keep. Test in
      `server/test/runner.test.ts`. Write the ADR
      `docs/decisions/a-subagents-question-is-refused-not-relayed.md`.
- [x] Close both fix docs, add a line to the streaming spec's § 1 saying
      subagents now stream, `atlas validate`, commit.

## Task 5 — two flaky tests

Closes [[spacemap-zoom-accumulation-flakes-under-load]] and
[[tags-rules-keyboard-test-is-flaky-under-the-full-suite]]. Read both.

- [ ] `web/src/test/tagsrules.test.tsx`, "opens a row from the keyboard and
      Escape closes the row before the panel": find the synchronous read
      after a keypress and make it `await waitFor(...)`/`findBy…`; if that
      is not it, give the `userEvent` setup `delay: null`. Nothing in the
      component changes.
- [ ] `web/src/test/spacemap.test.tsx`, "accumulates presses made during a
      run, and stops at the end of the range": drive the clock
      deterministically (fake timers / an injected `now`) instead of counting
      elapsed ticks, so 20 is 20 under any load. If the test cannot be made
      deterministic without changing the component, report that instead of
      changing the component.
- [ ] Prove it: run the FULL web suite (`npx vitest run` in `web/`) five
      times; every run green. Put the five results in the commit message.
- [ ] Close both fix docs, `atlas validate`, commit.
