---
id: feature-parity-with-the-claude-code-cli
title: Feature parity with the Claude Code CLI
type: audit
status: active
domain: sessions
related:
  - mcp-servers-in-the-session
  - take-over-a-live-terminal-session
  - subagent-model
  - more-than-one-session-open
tags:
  - sessions
  - sdk
---
# Feature parity with the Claude Code CLI

> Rows marked **Done** shipped after this audit was written (checked
> 2026-09-24); the rest of each row is left as it was read then.


The goal this audit measures against is **never opening a terminal again**. So
the question is not "does Orbital look like the TUI" but "is there anything you
still have to go back for". Rows are ordered by how much each one forces that
trip, not by how hard it is to build.

Measured against the CLI bundled with the SDK Orbital depends on —
`node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`, **v2.1.278** —
its `--help` flag list, its slash-command table read out of the binary, the
public command reference, and `@anthropic-ai/claude-agent-sdk/sdk.d.ts` for what
Orbital can actually drive. Every Orbital claim below was read in the code; the
file is cited.

One structural fact decides most of the table. `Runner.start()` passes the SDK
eight options and nothing else
(`server/src/runner/runner.ts:727-745`):

```
cwd, permissionMode, systemPrompt (claude_code preset),
settingSources: ['user','project','local'], canUseTool,
resume | sessionId, model, pathToClaudeCodeExecutable
```

Because `settingSources` names all three files, **everything the CLI itself
loads from disk already works in an Orbital session** — CLAUDE.md, skills,
custom slash commands, plugins, MCP servers, hooks, permission rules. Those are
parity, not gaps. What is missing is almost entirely the *second* half: the
control requests and callbacks that let a UI see and steer that machinery while
it runs.

## The four that actually block

1. **There is no permission prompt.** `canUseTool` parks `AskUserQuestion` and
   denies literally everything else
   (`server/src/runner/runner.ts:947-952`). You cannot answer "yes, run that."
2. **Plan mode cannot be left.** `ExitPlanMode` is a tool, so it hits the same
   deny. A plan-mode session can draft a plan and never execute it.
3. **Half of the slash commands look broken.** Typed commands do reach the CLI
   and do run — but commands that answer locally reply with
   `system/local_command_output`, and the pump drops every unrecognised `system`
   subtype (`server/src/runner/runner.ts:788-830`). `/context`, `/usage`,
   `/status`, `/permissions`, `/mcp`, `/agents`, `/doctor` all produce silence.
4. **You cannot read a diff.** An `Edit` renders as its raw input JSON
   (`web/src/panels/ToolRow.tsx:203-245`); `FileViewer` says "no watch, no
   reload, no diff" in its own header (`web/src/panels/FileViewer.tsx:21`).
   Reviewing what Claude changed is the most common reason to look at a
   terminal.

Just behind them: **thinking is invisible.** `sdkToChatMessages` handles
`text`, `tool_use`, `tool_result` and `image` and nothing else
(`server/src/runner/runner.ts:305-337`); the wire type has four roles
(`web/src/lib/types.ts:161`). Extended thinking is counted for stats
(`server/src/stats/compute.ts:197`) and never shown.

---

## Parity — Orbital already does this

| What it is | Where |
|---|---|
| Start, resume and drive a session on your Claude subscription, with the id pinned by the browser | `server/src/runner/runner.ts:727`, `server/src/api/routes.ts:420` |
| `CLAUDE.md`, project/user/local settings, permission rules | inherited — `settingSources: ['user','project','local']` (`runner.ts:731`) |
| Skills and custom slash commands run, including plugin-provided ones | same inheritance; catalog at `server/src/commands/catalog.ts:216-240` |
| Hooks configured in settings files fire | same inheritance; Orbital sets no `hooks` option and does not need to |
| MCP servers configured in `.mcp.json` / settings connect and their tools work | same inheritance (`strictMcpConfig` is deliberately not set for sessions) |
| `/`-completion while typing, from the session's own `supportedCommands()` plus a filesystem scan | `server/src/runner/runner.ts:1093-1113`, `web/src/panels/Composer.tsx`, `web/src/lib/composerTokens.ts` |
| Command completion anywhere in the prompt, not just position 0 | `docs/decisions/command-completion-is-not-anchored-to-position-0.md` |
| `@path` completion, confined to the session cwd | `GET /api/files/complete` → `server/src/files/complete.ts` |
| Images: paste, drag-drop and upload, sent as real `image` blocks, rendered in the transcript with a lightbox | `POST /api/attachments`, `server/src/images/store.ts`, `runner.ts:601-621`, `web/src/panels/useImageDrop.ts`, `web/src/ui/Lightbox.tsx` |
| Markdown, GFM tables and syntax-highlighted code in the transcript | `web/src/panels/MessageView.tsx:28-57`, `web/src/lib/highlight.ts` |
| Tool runs folded into one expandable group, with a `Bash ×3, Read +2 more` header | `web/src/panels/Transcript.tsx:95-114`, `223-340` |
| A slash command's expansion folded behind one line | `web/src/panels/MessageView.tsx:299-342`, `server/src/transcript/parser.ts:100-113` |
| Send while a turn is running — the message is queued onto the SDK input stream | `runner.ts` `enqueue`/`send`, `web/src/panels/DetailPanel.tsx:1005-1014` |
| Interrupt a running turn | `POST /api/sessions/:id/interrupt` → `runner.ts:1115-1128` |
| Switch model mid-session, context kept | `POST /api/sessions/:id/model` → SDK `setModel()` (`runner.ts:1135-1139`) |
| Model catalog from the SDK, plus a validated custom model id | `server/src/models/catalog.ts` |
| Context-window fill, from `getContextUsage()` with a usage fallback | `runner.ts:906-923` |
| Compaction seen and the gauge corrected | `compact_boundary` at `runner.ts:802-810` |
| Cost and token accounting, per session and overall, subagents priced on their own model | `server/src/stats/` |
| Interactive multiple-choice questions (`AskUserQuestion`) answered from the UI | `runner.ts:938-990`, `web/src/panels/QuestionCard.tsx` |
| Subagents shown live, and a turn stays `working` while they run | `server/src/transcript/subagents.ts`, `docs/decisions/subagent-liveness-from-sdk-task-events.md` |
| Read-only view of sessions running in a real terminal | `server/src/watcher/registry.ts` |
| Full history of every past session, searchable, tagged, auto-tagged | `server/src/indexer/`, `server/src/tags/` |
| Session title, rename, auto-title | `PATCH /api/sessions/:id`, `server/src/titler/` |
| File viewer for paths in the transcript | `GET /api/files` → `server/src/files/preview.ts` |
| Git branch / worktree / dirty state per session | `server/src/git/gitState.ts` |
| Idle auto-end, and autoheal of sessions orphaned by a restart | `runner.ts:623-635`, `server/src/runner/autoheal.ts` |

**Beyond the CLI**, and worth saying out loud because it is the reason the app
exists: one map of every session at once, native notifications when one needs
you (`desktop/src/lib/notifications.ts`), close-to-tray background mode
(`desktop/src/lib/background.ts`), tags and auto-tag rules, cross-session stats.
The terminal has no equivalent of any of these.

---

## Gap, reachable through the SDK

The SDK exposes it; Orbital has not wired it up.

| Gap | What it is | SDK surface | Why it blocks dropping the terminal |
|---|---|---|---|
| **Permission prompts** | Approve or deny a tool call, with the usual "allow once / allow always / deny" | `canUseTool` already registered — it just denies every tool but `AskUserQuestion` (`runner.ts:947-952`) | The single biggest one. Without it you must launch in `acceptEdits`/`auto`/`bypassPermissions` and hope; anything the CLI would have asked about dies mid-turn with a synthetic denial. **Done** ([[2026-09-23-permission-and-plan-decisions-design]]). |
| **Plan mode round-trip** | Claude drafts a plan, you approve it, it executes | `ExitPlanMode` through `canUseTool`; `planModeInstructions` to shape the plan | Plan mode is offered in the New session dialog (`web/src/panels/NewSessionDialog.tsx:376`) and cannot be completed. Any planned work starts in the terminal. **Done** ([[2026-09-23-permission-and-plan-decisions-design]]). |
| **Change permission mode mid-session** | The CLI's `Shift+Tab` cycle | `Query.setPermissionMode(mode)` | The mode is frozen at launch (`server/src/types.ts:7`, read-only at `DetailPanel.tsx:804`). Tightening after a risky stretch, or loosening to get unblocked, means a new session. |
| **Show local command output** | What `/context`, `/usage`, `/status`, `/mcp`, `/agents`, `/permissions` print | `SDKLocalCommandOutputMessage` (`system` / `local_command_output`) — currently dropped | Cheap, and it turns a third of the command menu from "does nothing" into "works". **Done** ([[locally-answered-slash-commands]]). |
| **Diff rendering** | Show an `Edit`/`Write` as a diff, and `/diff` for the whole working tree | The `tool_use` input already carries `old_string`/`new_string`; `SDKUserMessage.tool_use_result` carries the tool's structured Output (diff stats included); `Query.readFile()` for the after-state | Right now an edit is a wall of JSON (`web/src/panels/ToolRow.tsx:203-245`). Reviewing changes is the most common reason to look at a terminal, and Orbital already receives everything a diff needs. **Done** ([[2026-09-23-edit-diffs-in-the-transcript]]). |
| **Thinking blocks** | Render extended thinking | `thinking` content blocks in the assistant message; `Options.thinking`, `Query.setMaxThinkingTokens(n, display)` | You cannot see what Claude is reasoning about, which is most of what you watch a long turn for. **Done** ([[thinking-is-its-own-chatmessage-role]]). |
| **Todo / task checklist** | The CLI's `Ctrl+T` checklist | The `TodoWrite` `tool_use` block Orbital already receives — it renders as generic JSON today | On a long multi-step turn the checklist is the progress bar. Without it a 20-minute turn is opaque. |
| **Subagent transcript** | What a subagent actually did, not just that it ran | `Query.getSubagentMessages(sessionId, agentId)`, `listSubagents()`, `Options.forwardSubagentText` | Sidechain entries are skipped (`server/src/transcript/parser.ts:241`), so a delegated task is a black box. Designed already in `docs/superpowers/specs/2026-09-22-subagent-transcript-panel-design.md`. **Done** ([[2026-09-22-subagent-transcript-panel-design]]). |
| **Effort level** | `/effort low…max`, the CLI's `Option+T` | `Options.effort: EffortLevel`, or `Query.applyFlagSettings({ effortLevel })` | Choosing how hard a task is thought about is a per-task decision; today it is whatever the settings file says. |
| **Checkpoints and `/rewind`** | Restore files (and the conversation) to an earlier user message | `Options.enableFileCheckpointing` + `Query.rewindFiles(uuid, { dryRun })` | Undoing a bad stretch is a terminal trip. The dry-run preview would make this a good UI feature rather than a port. |
| **Fork / branch a conversation** | `/branch`, `/fork` — try a direction without losing this one | `Options.forkSession`, `Options.resumeSessionAt` | Orbital's Clear + startNew (`routes.ts:653`) restarts from the beginning; it is not a fork. |
| **Background tasks panel** | `/tasks`, `Ctrl+B`, stopping a runaway build | `Query.backgroundTasks(toolUseId)`, `Query.stopTask(id)`, `SDKBackgroundTasksChangedMessage` | Orbital consumes `background_tasks_changed` only to retire subagent moons and filters `local_bash` out entirely (`subagents.ts:84-88`). A background dev server is invisible and unkillable from the UI. |
| **MCP server visibility and control** | See which servers connected, reconnect, enable/disable one | `system/init.mcp_servers`, `Query.mcpServerStatus()`, `reconnectMcpServer`, `toggleMcpServer`, `setMcpServers` | Servers work but fail silently. Already written up in `docs/ideas/mcp-servers-in-the-session.md`. |
| **Streaming output** | Text appearing as it is generated | `Options.includePartialMessages` + `SDKPartialAssistantMessage` | Messages land whole (`runner.ts:844`). A long answer reads as a hang. **Done** ([[2026-09-24-streaming-output-design]]). |
| **Worktrees** | Run a session in its own `git worktree` | `EnterWorktree` / `ExitWorktree` tools; `--worktree` via `Options.extraArgs`; `Settings.worktree` for symlink/sparse config | Orbital *detects* a worktree (`server/src/git/gitState.ts:61-85`) but cannot create one. Parallel work on one repo still starts in a terminal. |
| **Output styles** | `/output-style` | `Query.updateSettings('localSettings', { outputStyle })`, `Query.reloadOutputStyles()` | Low weight, but it is a visible menu in the CLI with no counterpart. |
| **Subagent configuration** | Define agents for a session, pick the subagent model | `Options.agents`, `Options.agent`, `AgentDefinition.model`; `Query.supportedAgents()` | `~/.claude/agents` is deliberately not scanned (`commands/catalog.ts:215`), so the UI cannot even list them. Partly written up in `docs/ideas/subagent-model.md`. |
| **Tool scoping per session** | "this session may not run Bash" | `allowedTools`, `disallowedTools`, `tools`, `toolConfig`, `Options.sandbox` | The route to trusting a `bypassPermissions` session without watching it. |
| **Extra working directories** | `/add-dir` | `Options.additionalDirectories` | A session that needs a sibling repo cannot get one. |
| **Budget and turn caps** | `--max-budget-usd`, `--max-turns` | `Options.maxBudgetUsd`, `Options.maxTurns`, `taskBudget` | Orbital already prices sessions; capping them is the natural next step for unattended work. |
| **Auto-compact window** | `/autocompact` | `Query.applyFlagSettings` / settings | Orbital shows a `/compact` badge but cannot set the threshold it is nagging about. |
| **Plan-usage limits** | `/usage`'s 5-hour and weekly windows | `Query.usage_EXPERIMENTAL_...()` (explicitly unstable) | "Am I about to hit my limit" is a reason to open a terminal. |
| **Programmatic hooks** | Hooks defined by the host, not a settings file | `Options.hooks` (33 `HookEvent`s), `includeHookEvents`, `SDKHookStartedMessage` | Not blocking — file hooks already run — but it is how Orbital would learn about `PreCompact`, `FileChanged`, `WorktreeCreate` without parsing transcripts. |
| **MCP elicitation and CLI dialogs** | An MCP server, or the CLI, asking the user something | `Options.onElicitation`, `Options.onUserDialog` + `supportedDialogKinds` | Same shape as the permission gap: unanswered, these fail closed. |
| **Non-image attachments** | Documents and files into the prompt | `document` content blocks in `SDKUserMessage.message.content`; `--file` | Upload accepts png/jpeg/gif/webp only (`server/src/images/store.ts:48-53`). |
| **Compaction marker** | A visible line in the transcript where the context was summarised | `SDKCompactBoundaryMessage` — consumed for the gauge (`runner.ts:802-810`), never rendered | Without it the transcript silently loses its middle and nothing says why. |
| **`/context` breakdown** | The coloured grid: system prompt vs tools vs MCP vs memory | `Query.getContextUsage({ detail: 'full' })` — Orbital calls it with `'summary'` (`runner.ts:910`) | Knowing *why* the window is full is what tells you whether to compact or to drop an MCP server. |
| **Plugins per session** | `--plugin-dir`, `/reload-plugins` | `Options.plugins`, `Query.reloadPlugins()`, `reloadSkills()` | Orbital reads `enabledPlugins` to build the command list (`catalog.ts:186-189`) and cannot change it. |
| **Queue visibility** | See what is queued behind the running turn and take it back | Orbital already enqueues (`runner.ts` `enqueue`); the UI shows nothing | You can send while working but cannot tell whether it landed. |
| **Cross-session messaging** | The CLI's `@`-completion offers other live sessions to message; `/list-agents` | `--brief` / `SendUserMessage`; `AgentInfo` from `supportedAgents()` | Not a terminal-parity item at all — it is a CLI feature that would fit Orbital's map better than it fits a terminal. |
| **Copy / export a message or the conversation** | `/copy`, `/export` | Host-side; Orbital already holds the transcript | Small, but it is a real trip back to the terminal today. |
| **Prompt history** | `↑` to recall the last prompt, `Ctrl+R` to search it | Host-side; Orbital already holds the transcript | Small, constant friction. |
| **Prompt suggestions** | The CLI's predicted next prompt | `Options.promptSuggestions`, `SDKPromptSuggestionMessage` | Convenience only. |
| **Skills scoping** | Enable a named subset of skills | `Options.skills: string[] \| 'all'` | Convenience only; skills already resolve. |

---

## Gap, not in the SDK

Terminal-only by construction, or needing work outside the SDK surface.

| Gap | What it is | What it would take |
|---|---|---|
| **IDE integration** | `--ide`, `/ide`, editor selection and diagnostics flowing into the session | Not in the SDK at all. `--ide` is an interactive-only CLI flag the SDK never passes, and the selection plumbing (`selection_changed` from the IDE extension's WebSocket MCP server) is a React hook inside the TUI. Orbital would have to speak that protocol itself. Given Orbital is a browser app, the honest answer is that this one stays a terminal (or IDE) job. **Done** ([[2026-09-23-ide-bridge-design]]). |
| **`!` shell mode** | Type `! npm test`, output lands in context, Claude responds to it | A TUI prompt feature, not a protocol one. Orbital would implement it host-side: run the command itself, then send the command and its output as a user message. Perfectly buildable, just not "wire up an option". |
| **Cloud and remote sessions** | `--cloud`, `/teleport`, `--remote-control`, `/ultraplan`, `/autofix-pr`, `claude.ai/code` | CLI subcommands against Anthropic's hosted runner. No SDK option creates or attaches to one. Partly overlaps `docs/ideas/mirror-sessions-to-claude-ai.md`. |
| **`claude --bg` / `agents` / `attach` / `logs` / `stop` / `rm` / `respawn`** | Detached background sessions managed from any terminal | Process management in the CLI, not the SDK. Orbital is arguably its own answer to this — but a session Orbital started is not visible to `claude agents`, and vice versa, so the two worlds do not meet. |
| **Take over a live terminal session** | Continue, from the browser, a session a terminal still owns | Not an SDK feature: the CLI holds the conversation. Needs the signal-and-revive dance in `docs/ideas/take-over-a-live-terminal-session.md`. |
| **Machine configuration commands** | `/login`, `/logout`, `/doctor`, `/config`, `/permissions` editor, `/hooks` viewer, `/keybindings`, `claude mcp`, `claude plugin`, `claude update`, `/install-github-app` | These edit files and credentials rather than drive a session. Orbital would have to own its own editors for `settings.json`, permission rules and hooks. Settings → **Permissions** and **Shortcuts** already exist as disabled nav items (`web/src/panels/Settings.tsx:120-126`). |
| **Terminal ergonomics** | Vim mode, `Ctrl+O` transcript viewer, `Ctrl+R` history search, `Ctrl+G` external editor, statusline, themes, fullscreen renderer, emoji shortcodes, spellcheck, voice dictation | Terminal-shaped, and a browser has its own answers to most of them. Not worth porting; worth not pretending they are gaps. |
| **`/btw`, `/insights`, `/loop`, `/goal`, `/schedule`** | Side questions that skip the conversation, session reports, recurring prompts, goal-until-done | CLI-side features with no SDK entry point. `/loop` and `/goal` in particular are close to what Orbital's map is for; they would have to be re-implemented as Orbital's own scheduling on top of ordinary turns. |

---

## Notes and caveats

- `canUseTool`'s blanket denial is deliberate and documented in place: it
  reproduces exactly what the SDK did before the option was passed, and the
  comment calls itself "the extension point". Fixing gap #1 is a UI problem, not
  a protocol one.
- Permission mode in Orbital is `'plan' | 'acceptEdits' | 'auto' |
  'bypassPermissions'` (`server/src/types.ts:7`); the SDK's own union is
  `'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' |
  'auto'` (`sdk.d.ts:2383`), so `'auto'` passing through unmapped is correct.
  `'default'` is the one a permission-prompt surface would need, and it is the
  one Orbital deliberately does not offer (`web/src/lib/permissionModes.ts:37-41`)
  — because offering it today would mean a session that denies everything.
- Smaller, cheap, and genuinely missing: the completion popup drops the
  `argumentHint` the server already sends (`web/src/panels/CompletionPopup.tsx:356-381`);
  there is no way to delete one session, only the age-based retention sweep
  (`server/src/retention.ts`); the desktop app registers no URL scheme, so a
  notification is the only way back into a specific session from outside the app.
- `ANTHROPIC_API_KEY` is deleted from the whole server process rather than
  per-query (`server/src/index.ts:146-148`). `Options.env` would scope it.
- The titler and the model validator pass `settingSources: []`, which is why
  they pick up neither repo instructions nor MCP servers — intentional.
- `atlas validate` currently reports one unrelated problem:
  `docs/superpowers/specs/2026-09-22-subagent-transcript-panel-design.md` has an
  unrecognised `design` key. It predates this audit.
