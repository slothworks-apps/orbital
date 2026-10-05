# Changelog — Orbital for Mac

All notable changes to the desktop app. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow `version` in `desktop/package.json`.

## [Unreleased]

## [0.20.5] — 2026-10-05
### Fixed
- A session started from Orbital whose background agent is still running now stays shown as working, also when Orbital has lost track of that agent, instead of asking for your input too early.

## [0.20.4] — 2026-10-04
### Added
- When you scroll up in a transcript, a quiet button takes you back to the latest message and says when something new has arrived below. Sending a message, or ⌘↓, also takes you back to the bottom.

## [0.20.3] — 2026-10-04
### Fixed
- A question's answer options now show their whole text instead of cutting off long descriptions or long paths.
- A session that another session starts on your request now lands under the same tag you gave the first one, instead of falling back to the default.

## [0.20.2] — 2026-10-04
### Changed
- Updated dependencies, including the Claude Agent SDK.

## [0.20.1] — 2026-10-04
### Added
- Opening Orbital in a browser tab without the access token shows a "not signed in" screen that says where to find the sign-in link, covers a token that has changed, and offers a Reload button.
- Sessions started by Orbital are told to stop the dev servers and watchers they started once the work is done, so a finished session no longer looks busy.

## [0.20.0] — 2026-10-03
### Added
- The file viewer and the image preview can open files outside the session's folder when the session itself named them, such as a screenshot an agent saved to a temporary folder.
### Changed
- In the Desk theme, live session cards show their tag colour and a WORKING or IDLE label.
### Security
- Orbital's local server accepts only requests that carry its access token. The desktop app signs in on its own, a browser tab signs in through the link the server prints, and requests from other websites are refused.

## [0.19.1] — 2026-10-03
### Changed
- The Desk theme is redrawn in Orbital's own look: tag colours appear only on tag elements, status labels match the rest of the app, a placeholder shows where a dragged mat will land, and mats can scroll.
### Fixed
- The planet preview and the sloth appear only in the Planets theme.

## [0.19.0] — 2026-10-03
### Added
- When a session started by Orbital hits your plan's usage limit, it waits for the limit to reset and then continues on its own. You can cancel or undo this per session, and messages you send while it waits are queued.
- A Limits group in Settings → Sessions turns automatic continuing on or off and sets the text sent when a session continues.
- A waiting session shows when its limit resets on the map, in its header and in the sidebar; the transcript notes when the wait started and when the limit reset.
- A Limits page, opened from the sidebar, shows how much of each usage window you have used, when each one resets, and which sessions are waiting.

## [0.18.8] — 2026-10-03
### Added
- A path to an image file in the transcript (in text, code or tool rows) can be clicked to open the image in the full-size preview.
### Changed
- The model's thinking appears in the transcript as ordinary text instead of a collapsed block.

## [0.18.7] — 2026-10-03
### Removed
- Orbital no longer renames sessions automatically, and the setting for it is gone. The rename button beside a session's title still names it from its contents, for terminal sessions too.

## [0.18.6] — 2026-10-03
### Fixed
- After Orbital restarts, the composer no longer marks Claude Code's built-in commands such as /compact as unknown.

## [0.18.5] — 2026-10-03
### Added
- Paired phones can do more than read: they can send messages with photos, answer questions and permission requests, and start new sessions on the Mac.
- Settings → Mobile has a relay secret field. It is sent to your relay and carried in the pairing QR code, and Orbital says so when the relay refuses it.
- The "Browse…" button in the New session dialog opens the Mac's own folder picker.
### Changed
- The harness is redesigned. It opens from a tab on the edge of the session panel or with ⌘⇧H, and a step waiting for your approval shows as NEEDS YOUR OK on the map and counts as needing your input.
- Harness messages Orbital sends on your behalf look different from your own in the transcript, and "Decide myself" stops a review that is still running and leaves the decision to you.
- Harness templates can be global or belong to one project, and can be saved as drafts, duplicated and moved.
- Harness step records are kept after you remove a harness or go back a step, and can be copied as Markdown or read in a full window. A harness can be carried into a new session when its session ends partway through.
- The harness reviewer uses the session's model unless the template names another one.
### Fixed
- When an answer to a question or a permission request fails to reach the session, the card can be answered again instead of staying stuck.

## [0.18.1] — 2026-10-02
### Added
- Orbital works with the Android app: a phone paired from Settings → Mobile can list your sessions and read their transcripts through the relay.

## [0.18.0] — 2026-10-02
### Added
- Two map themes beside Planets. Archipelago shows tags as islands, sessions as ships and subagents as rowboats. Desk lays sessions out as cards on one mat per tag, lets you answer simple decisions on the cards, and keeps history in a drawer.
- You can attach any kind of file to a message. Images are sent as images; other files are passed to the agent by their path, and a file dropped onto the desktop app keeps its original path.

## [0.17.2] — 2026-10-02
### Changed
- Orbital no longer comes with a default relay. To use phone access, enter the address of your own relay under Settings → Mobile → Advanced.

## [0.17.1] — 2026-10-01
### Added
- A Settings → Mobile section for pairing a phone: a switch to turn phone access on, the relay connection status with a "Try again" button, the Mac's name, a pairing code with a QR code, and a list of paired phones you can remove.
- When a phone asks to pair, a dialog shows a short code to compare with the one on the phone before you confirm.

## [0.17.0] — 2026-10-01
### Added
- Groundwork for using Orbital from a phone: the Mac can connect to an end-to-end encrypted relay that sees only encrypted traffic, and pair phones through it. There is no screen for it yet.

## [0.16.1] — 2026-10-01
### Added
- Session harness (experimental): attach a checklist template to a session and it works through the steps one by one, with progress in a Harness panel and a header chip. Templates are edited in Settings and can be drafted from a description or from an existing session, and an optional mode lets a read-only reviewer approve steps for you.
- MCP servers that need authentication get a Log in action in the /mcp dialog; Orbital opens the login page in your browser and reconnects the server when you come back.
### Changed
- Orbital's built-in session instructions tell Claude to put the context you need into the same message when it asks you a question.
### Fixed
- In a question that allows several answers, text typed into "Other…" is sent together with the options you ticked.
- Shutting Orbital down while a session's harness work is still finishing no longer causes an error.

## [0.16.0] — 2026-10-01
### Added
- Typing /mcp in the composer opens a dialog for the running session's MCP servers, with each server's status, origin, tool count and error. You can reconnect a failed server, switch a server on or off for the project, and add, edit or remove your own servers.

## [0.15.0] — 2026-10-01
### Added
- Settings → Sessions → Instructions: turn on Orbital's tips for sessions and add your own text, sent to every session Orbital starts.
### Fixed
- The tips list in Settings starts collapsed every time you open Settings.

## [0.14.0] — 2026-09-30
### Added
- A running session can start new, independent sessions of its own, and Orbital remembers which session started them.
### Changed
- A successful file edit's tool row shows only the diff, without the "updated successfully" result; failed edits still show the error.

## [0.13.2] — 2026-09-30
### Added
- The detail header shows the branch's pull request (click to open it) and its added and removed line counts next to the branch name; both can be turned off in Settings → Appearance.
- Work-time statistics count the time a session spends waiting for you separately from tool time.
### Fixed
- After switching branches, the header no longer shows the previous branch's pull request or parent branch.
- The waiting count wraps between its parts instead of breaking in the middle.

## [0.13.1] — 2026-09-30
### Added
- An inline code span that holds only a file path (optionally with a line number) can be clicked to open the file viewer.

## [0.13.0] — 2026-09-30
### Added
- A session's permission mode can be switched from its header while it runs, taking effect right away.
### Changed
- The experimental walkthrough is narrated by a separate reader outside the session, so it works on running, ended and terminal sessions and no longer adds turns to the session. Settings → Experimental gains a narration model picker and a commentary switch.
### Removed
- Asking questions from a walkthrough step.

## [0.12.6] — 2026-09-30
### Added
- A skill viewer: click a slash command in the composer to read the skill or command file behind it.
- The rewind button has a tooltip.
### Changed
- With a planet selected, the New session dialog starts in that session's folder and with its tag, so the new planet appears next to it.
### Fixed
- A session stopped by Stop or by a rewind is no longer shown as failed.

## [0.12.5] — 2026-09-30
### Added
- Rewind: use the rewind button or /rewind to pick an earlier message and continue the conversation from there. The rows that would be removed are previewed before you confirm, and Orbital tells you if the CLI refuses the rewind.
### Changed
- Transcripts show only the conversation's current branch, so turns removed by a rewind and leftovers from an interrupted tool call no longer appear; statistics are recalculated to match.
- Clicking a planet closes any open subagent or background task panel, so you get back to the parent session.

## [0.12.4] — 2026-09-29
### Changed
- The walkthrough is hidden behind an Experimental switch in Settings (⌘⇧. reveals it) and is off by default.

## [0.12.3] — 2026-09-29
### Changed
- The composer formats markdown as you type (lists, emphasis, code, headings, quotes) and still sends markdown. Slash commands show a hint for their arguments.

## [0.12.2] — 2026-09-29
### Added
- Background tasks: shells, monitors, workflows and MCP tasks a session starts show as a chip and a list, where you can read each task's output and stop it. Subagents can be stopped the same way, and a session with background work still running counts as working.
### Fixed
- Code blocks wrap their lines, and the copy button no longer covers the text.
- Moon orbits are spaced evenly and scale with the planet's size.
- The main window no longer has a highlight along its top edge.
- The task list's keyboard hint stays on one line.

## [0.12.1] — 2026-09-29
### Added
- When no text is selected, the prompt tells Claude which file you have open in your IDE (the path only), as the CLI does. The note does not appear in your message or in the session title.
### Changed
- Switching the model asks you to confirm first and explains what the switch means for context and token use.
- In a narrow composer, the Stop and Send buttons show only their icons instead of wrapping.

## [0.12.0] — 2026-09-28
### Changed
- State pills sit diagonally off the planet so they clear its rings, and planet labels stay readable at the zoom levels you use with the detail panel open.
### Fixed
- A failed compaction is no longer reported as a failed session, and its badge replaces the DONE pill.

## [0.11.3] — 2026-09-28
### Added
- Compaction tracking: a planet shows when its session is compacting, and a failed compaction gets its own badge that survives restarts. /compact covers both manual and automatic compaction.

## [0.11.2] — 2026-09-28
### Changed
- The context gauge uses fixed green, amber and red instead of the session's colour.
- Panels and windows share one style of highlight along their top edge, which dims when the window is in the background.
### Fixed
- The text cursor in text fields lines up correctly.

## [0.11.1] — 2026-09-25
### Added
- Windows open where you left them: the main window remembers its position, size and the page you were on, and detached windows reopen at the position and size you last gave one.

## [0.11.0] — 2026-09-24
- Internal changes only.

## [0.10.1] — 2026-09-24
### Added
- A subagent's answer appears in its panel while it is being written.
### Changed
- The map stays responsive when many sessions update at once, because only the planets that changed are redrawn.
- Long tool and subagent durations are shown in hours and minutes.
### Fixed
- A question asked from inside a subagent is refused and Claude is pointed to the parent session, instead of the question showing up on the parent.
- A finished subagent no longer goes back to RUNNING when its session updates.
- Coming back to a session no longer shows replies from the time you were away twice, or an old page of history in the wrong place.
- Side panels adjust their width when the window is resized.
- Pop-up menus stay inside their panel.
- The model change divider sits above the thinking block that starts a turn.
- A duration just below a unit boundary rolls over to the next unit.

## [0.10.0] — 2026-09-24
### Added
- Claude's answers stream into the transcript as they are written, instead of appearing only when each block is finished.
### Fixed
- Going back to a session that replied while you were looking at another one shows the reply without a reload.

## [0.9.0] — 2026-09-24
### Added
- The detail panel header has a subagent list that shows every agent the session launched, running or finished, and opens any of them.
- A detached session window too narrow for the session and a subagent side by side switches to showing the subagent alone.
### Changed
- Finished subagents leave the map on their own, so moons no longer need to be dismissed by hand.
### Fixed
- The detached window sizes itself correctly for the subagent panel when the page is zoomed.
- Menus keep focus on the right row when rows move, and mark the selected row clearly.
- A hidden detail panel no longer reacts to keyboard shortcuts.

## [0.8.3] — 2026-09-24
### Added
- The black hole on the map is now a trash: drop a planet on it to end the session, with an undo notice if you change your mind.
- Ended sessions can be reopened, and sending a message to an ended session reopens it.
- A setting under Appearance hides the trash from the map.
### Changed
- Sessions end only when you end them. An idle session is put to sleep and stays on the map until you end it.
- Ended sessions that are not pinned fade off the map.
- After a restart, Orbital no longer resumes sessions on its own; sessions cut off mid-turn are marked as interrupted.
### Removed
- Session lineage (the chain of cleared sessions) and its settings.
- The settings that ended idle sessions and released ended sessions from the map after a delay.
- Dismissing sessions from the map.

## [0.8.2] — 2026-09-24
### Added
- Tooltips show the keyboard shortcut for their control.
### Changed
- The app is signed and notarized by Apple, so macOS permissions you grant survive updates.
### Fixed
- Only one tag can be the default tag.

## [0.8.1] — 2026-09-24
### Fixed
- When a session starts, resumes or ends, its live transcript no longer shows duplicate messages or misses any.
- Groups of planets on the map settle faster and more compactly, and stay steady while you zoom.
- Planets no longer settle on top of the black hole's label, and selecting a planet no longer moves its neighbours.

## [0.8.0] — 2026-09-24
### Added
- A full set of ⌘ keyboard shortcuts for sessions and navigation: next session, next session that needs input, interrupt, clear, end, pin, tag, change model, detach, settings, stats and more.
- The application menu and a new Settings → Shortcuts section list every shortcut.
### Fixed
- Number keys pick an answer to a question on any keyboard layout, and no longer do so while a modifier key is held.
- The window buttons return to their place every time the main window is shown.

## [0.7.1] — 2026-09-23
### Added
- The main window drops the grey macOS title bar, so the map runs to the top edge, and the window can be dragged from its top band.
- The stats and walkthrough pages share one header bar; Esc goes back to the map and ⌘1 opens the map.
- ⌘1, and opening a walkthrough, from a detached window act in the main window.
- When the session's path runs out of room, the header buttons fold into a ⋯ menu.
### Changed
- The detail panel header no longer lists every subagent as a chip; the moons and the subagent panel show them instead.
- Planets keep a clear gap between their labels and state pills at every zoom level.
### Fixed
- Skill contents, image notes and other messages the CLI inserts on its own no longer show up as your messages or become session titles; existing titles are fixed too.
- A selected planet's label no longer overlaps the selection brackets.
- The badge for a detached session no longer covers the planet's state pill.

## [0.7.0] — 2026-09-23
### Added
- End session in the detail panel header, after a confirmation, for sessions started in Orbital.
### Changed
- The detail panel's close button is a collapse chevron, and Clear has an eraser icon. The Clear dialog no longer offers "Clear only".
- The session's status and its context gauge sit on one row in the header, and terminal sessions are marked TERMINAL there.
### Fixed
- A running sequence of tool calls keeps showing its latest call, so the transcript no longer jumps with every call.

## [0.6.1] — 2026-09-23
### Added
- A detached session window can show the subagent panel, and the window grows to fit it.
- Searching dims the planets that do not match instead of hiding them.
### Changed
- Older transcript history loads as you scroll up, replacing the "Load older" button.
- A planet whose turn has simply finished no longer pulses as if it were waiting for you.
### Fixed
- A new session's first prompt appears in its transcript.
- Loading older history no longer adds a second copy of the latest messages.
- The New session button sits centred in the visible part of the map, even when panels are open.
- Neighbouring planets no longer overlap each other's labels.

## [0.6.0] — 2026-09-23
### Added
- Walkthrough: a guided, step-by-step reading of what a session changed, with questions about each step and narration.
- A session can be detached into its own window.
- Subagent panel: click a moon, or "OPEN →" on an agent in the transcript, to watch that subagent's transcript live, read-only.
- Claude's thinking appears in its own collapsed block instead of as ordinary text.
- Tool calls show how long they took.
### Changed
- Finished subagents stay on the map as moons until you dismiss them.

## [0.5.1] — 2026-09-23
### Added
- IDE bridge: when your IDE has the workspace open, the session sees your current selection and can attach it to a prompt.
- The @ file picker lists the files open in your IDE.
- Files can be opened in your IDE, and proposed edits can be approved from the IDE's diff view.
- Syntax highlighting in file diffs, and an option to show edit diffs already expanded as a short preview.
- A setting for how a guarded approval is confirmed: press and hold, or press twice.
### Fixed
- Permission cards and command notices match the design.

## [0.5.0] — 2026-09-23
### Added
- Sessions started in Orbital can ask for tool permissions, which you approve or decline in the transcript.
- Plan mode: approve or reject the plan from the transcript.
- The output of slash commands the CLI answers itself, such as /context or /usage, appears as notice rows in the transcript.
- File edits in the transcript are shown as diffs.

## [0.4.2] — 2026-09-23
### Added
- When choosing a model, an "Other" option takes any model ID and checks that it is valid.

## [0.4.1] — 2026-09-23
### Added
- The detail panel shows the session's live git branch and whether it is working in a worktree.
- The slash-command popup finds a command by any part of its name, including plugin commands, and opens wherever a word starts with / in the prompt.

## [0.4.0] — 2026-09-22
### Added
- Background mode: closing the window keeps Orbital running in the menu bar, and quitting asks first if sessions are still working.
- The stats page can be opened from the sidebar footer.
- A setting to show session stats in the detail header as a bar or as a button.
### Changed
- The session stats strip and the context gauge in the header line up at the same width.
- Selected options in segmented controls are a soft tint instead of a solid fill.
### Fixed
- After a lost connection, Orbital reconnects and catches up on session state and transcripts on its own.

## [0.3.0] — 2026-09-22
### Added
- Session stats: time, tokens and cost for each session, subagents included, and a stats dashboard with daily charts, a tool leaderboard and findings such as cache waste or error loops.
- A per-session stats page with a turn-by-turn timeline.
- A stats row in the detail panel that opens a quick stats dialog.

## [0.2.0] — 2026-09-22
### Added
- A "Delete sessions older than" setting in a new General settings section; pinned and active sessions are kept.
- After a restart, Orbital picks up sessions that were cut off.
- A setting to override which Claude Code executable Orbital uses.
- A new app icon.
- A session waiting only on its subagents reads WAITING FOR AGENT.
### Changed
- The map zooms further in and out, and Fit view frames the sessions in the space left between open panels.
- Tag path rules use regular expressions, with ~ for your home folder, and invalid patterns are flagged.
- The detail panel no longer shows the input/output/cache token grid.
- The app download is smaller.
### Fixed
- Links in a transcript open in your browser instead of replacing Orbital.
- The model list loads in the packaged app.
- Resumed terminal sessions show their context gauge again.
- The NEEDS INPUT pill no longer fades in on a planet that has already settled.

## [0.1.0] — 2026-09-21
### Added
- First release of Orbital for Mac: a space map of all your Claude Code sessions, where each session is a planet and its subagents are moons, so you can see at a glance what is working, what is waiting for you and what has ended.
- Sessions started in a terminal appear on the map automatically and update live. They are read-only and marked as such, and the sidebar can filter between all sessions, sessions run in Orbital and read-only ones.
- Start a new Claude Code session from the app: choose the working folder (recent folders are offered), the permission mode, the model and tags.
- A detail panel for each session with the full transcript, including tool calls and subagents, a message box for continuing the conversation, an editable title, tags and token usage.
- Pick up an ended session where it left off, stop a turn while it runs, or clear a session and optionally start a fresh one that carries over its context.
- Answer an agent's multiple-choice questions on an interactive card, including questions that allow several answers or an answer of your own.
- Choose the model when you start a session or switch it partway through; Orbital remembers each project's last model and lets you set a default.
- A ring around each planet shows how full the session's context window is.
- Sessions group into clusters by tag. Ended sessions drift into a black hole after a configurable delay, and you can drag a planet into it yourself, with an undo.
- Pin a session to keep it on the map and at the top of the sidebar however long it has been inactive.
- Tags with their own colours, and auto-tag rules that match a session's folder and tag new sessions for you, in an order you set by drag and drop.
- Optional automatic titles that rename an Orbital session as its subject changes; off by default, and a title you type yourself is never overwritten.
- A sidebar of active, pinned and past sessions with filters and paged history, which can collapse into a slim rail.
- Map navigation: pan, pinch, zoom toward the cursor, zoom buttons, and a click on empty space to deselect.
- Settings for the default permission mode and folder, how long an idle session waits before it ends, confirmation before clearing, and hiding ended sessions from the map.
- Native Mac notifications when a session you are not looking at needs your input or finishes; clicking one opens that session.
- Errors collected in one log with quiet toasts, and panels that keep the rest of the app working if one of them fails.
- Packaged as an unsigned Mac app for Apple Silicon. It runs its own local server, finds the Claude Code CLI installed on your Mac (or asks you where it is), and bills sessions to your Claude subscription the same way the CLI does.
