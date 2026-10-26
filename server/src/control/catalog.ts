/**
 * Everything a session may do to Orbital through `orbital_read` and
 * `orbital_act` (spec 2026-10-13-orbital-controls-itself-design): each entry
 * is one of Orbital's own routes, named and described for the model. A route
 * that is not here does not exist for a session — the same rule the phone's
 * allowlist keeps.
 *
 * Left out on purpose: bytes (images, uploads), the phone's pairing and
 * devices, the browser's error reports, the terminals' shells, and the
 * dev-only routes. Which features have no route at all is in the domain
 * document orbital-features.
 */

export type ControlArea =
  | 'sessions' | 'conversation' | 'decisions' | 'harness' | 'tags' | 'tag_rules' | 'settings'
  | 'mcp' | 'claude_dirs' | 'models' | 'commands' | 'files' | 'ide' | 'stats' | 'limits'
  | 'errors' | 'walkthrough' | 'system' | 'devices';

export interface ControlOperation {
  name: string;
  area: ControlArea;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** A route template; `:name` segments are filled from the params of the same name. */
  path: string;
  does: string;
  /** Params by name: `name: type — meaning`, `?` for optional. */
  params?: string[];
  /** Stops or resets the session it names, so never the calling session: its turn waits on the call. */
  notOnCaller?: boolean;
  /** Body keys an act may not carry: the phone's relay and its secret are the user's alone. */
  deniedKeys?: (key: string) => boolean;
}

const PERMISSION_MODES = 'plan | acceptEdits | auto | bypassPermissions';
const ID = 'id: string — the session id, from list_sessions';

export const CONTROL_OPERATIONS: readonly ControlOperation[] = [
  // devices (spec 2026-10-19-member-grants-design § 3)
  { name: 'list_devices', area: 'devices', method: 'GET', path: '/api/remote/devices',
    does: 'The other group members, their kind and whether each is online. Pass one\'s id as `machine` to orbital_read, orbital_act or spawn_session to run there.' },
  // sessions
  { name: 'list_sessions', area: 'sessions', method: 'GET', path: '/api/sessions',
    does: 'Sessions on the map, pinned first, then by last activity.',
    params: ['limit?: number — default 50, max 200', 'offset?: number', 'source?: terminal | web', 'q?: string — title contains', 'tag?: number — tag id', 'ended?: only | exclude'] },
  { name: 'count_sessions', area: 'sessions', method: 'GET', path: '/api/sessions/count', does: 'How many sessions there are.' },
  { name: 'session_defaults', area: 'sessions', method: 'GET', path: '/api/sessions/defaults',
    does: 'What New Session pre-fills: permission mode, model, Claude directories.' },
  { name: 'get_session', area: 'sessions', method: 'GET', path: '/api/sessions/:id', does: 'One session with its history.', params: [ID] },
  { name: 'list_projects', area: 'sessions', method: 'GET', path: '/api/projects', does: 'Project directories sessions ran in, newest first.' },
  { name: 'check_directory', area: 'sessions', method: 'GET', path: '/api/directory',
    does: 'Whether a path is an existing directory, missing, not a directory or not absolute.', params: ['path: string'] },
  { name: 'retention_preview', area: 'sessions', method: 'GET', path: '/api/sessions/retention-preview',
    does: 'How many sessions a retention of this many days would delete. Deletes nothing.', params: ['days: string — a positive integer or never'] },
  { name: 'start_session', area: 'sessions', method: 'POST', path: '/api/sessions',
    does: 'Starts a new session (a new planet) with its first message, or resumes one by id.',
    params: ['cwd: string — absolute or ~', 'prompt: string — the first message', `permissionMode: ${PERMISSION_MODES}`, 'model?: string', 'tagId?: number', 'resume?: string — a session id to resume', 'claudeDirId?: number', 'requireDirectory?: boolean — fail instead of creating a missing cwd'] },
  { name: 'create_directory', area: 'sessions', method: 'POST', path: '/api/directory',
    does: 'Creates a project directory and its parents.', params: ['path: string — absolute'] },
  { name: 'rename_session', area: 'sessions', method: 'PATCH', path: '/api/sessions/:id',
    does: 'Renames a session; the automatic titler leaves it alone afterwards.', params: [ID, 'title: string'] },
  { name: 'retitle_session', area: 'sessions', method: 'POST', path: '/api/sessions/:id/retitle',
    does: 'Asks the titler for a new title now.', params: [ID] },
  { name: 'pin_session', area: 'sessions', method: 'PUT', path: '/api/sessions/:id/pinned', does: 'Pins or unpins a session.', params: [ID, 'pinned: boolean'] },
  { name: 'end_session', area: 'sessions', method: 'POST', path: '/api/sessions/:id/end', notOnCaller: true,
    does: 'Ends (archives) a session: its process stops and it leaves the map. reopen_session undoes it.', params: [ID, 'unpin?: boolean'] },
  { name: 'reopen_session', area: 'sessions', method: 'POST', path: '/api/sessions/:id/reopen',
    does: 'Undoes End: the session is back on the map, without a process until the next message.', params: [ID] },
  { name: 'clear_session', area: 'sessions', method: 'POST', path: '/api/sessions/:id/clear', notOnCaller: true,
    does: 'Ends a session and, with startNew, starts an empty one in its place with the same directory, model, mode and tags.',
    params: [ID, 'startNew?: boolean', 'carryHarness?: boolean — move its harness to the new session'] },
  { name: 'set_model', area: 'sessions', method: 'POST', path: '/api/sessions/:id/model', does: 'Switches a session\'s model.', params: [ID, 'model: string'] },
  { name: 'set_permission_mode', area: 'sessions', method: 'POST', path: '/api/sessions/:id/permission-mode',
    does: 'Switches a session\'s permission mode at once.', params: [ID, `mode: ${PERMISSION_MODES}`] },
  { name: 'interrupt_session', area: 'sessions', method: 'POST', path: '/api/sessions/:id/interrupt', notOnCaller: true,
    does: 'Stops the turn a session is running.', params: [ID] },

  // conversation
  { name: 'list_messages', area: 'conversation', method: 'GET', path: '/api/sessions/:id/messages',
    does: 'A session\'s conversation, newest page first.', params: [ID, 'limit?: number — default 100, max 500', 'before?: string — a message id to page from'] },
  { name: 'send_message', area: 'conversation', method: 'POST', path: '/api/sessions/:id/messages', notOnCaller: true,
    does: 'Sends a message to a session as the user would; wakes an asleep or ended one. Queued while a usage limit waits.',
    params: [ID, 'text: string'] },
  { name: 'rewind_session', area: 'conversation', method: 'POST', path: '/api/sessions/:id/rewind', notOnCaller: true,
    does: 'Rewinds a session to before one of the user\'s messages; applied with the next message.',
    params: [ID, 'uuid: string — the user message to rewind to', 'hiddenCount: number — messages hidden by it', 'draft?: string'] },
  { name: 'cancel_rewind', area: 'conversation', method: 'DELETE', path: '/api/sessions/:id/rewind', does: 'Cancels a pending rewind.', params: [ID] },
  { name: 'list_media', area: 'conversation', method: 'GET', path: '/api/sessions/:id/media', does: 'Every image and PDF of a session.', params: [ID] },
  { name: 'subagent_messages', area: 'conversation', method: 'GET', path: '/api/sessions/:id/subagents/:toolUseId/messages',
    does: 'One subagent\'s conversation.', params: [ID, 'toolUseId: string — the Agent tool call that started it', 'limit?: number'] },
  { name: 'task_output', area: 'conversation', method: 'GET', path: '/api/sessions/:id/tasks/:taskId/output',
    does: 'The tail of a background task\'s output.', params: [ID, 'taskId: string', 'maxBytes?: number'] },
  { name: 'stop_task', area: 'conversation', method: 'POST', path: '/api/sessions/:id/tasks/:taskId/stop',
    does: 'Stops a background task or subagent of a session.', params: [ID, 'taskId: string'] },

  // decisions
  { name: 'answer_decision', area: 'decisions', method: 'POST', path: '/api/sessions/:id/decision/:decisionId',
    does: 'Answers what a session waits on: a permission or plan card (approved), or its questions (answers). The decision id is on get_session.',
    params: [ID, 'decisionId: string', 'approved?: boolean — a permission or plan', 'message?: string — read by the model on a refusal', 'answers?: object — question text to answer, for questions'] },

  // harness
  { name: 'list_harness_templates', area: 'harness', method: 'GET', path: '/api/harness/templates',
    does: 'Harness templates: a session\'s project ones and the global ones.', params: ['sessionId?: string', 'scope?: global', 'project?: string — a project root'] },
  { name: 'list_harness_projects', area: 'harness', method: 'GET', path: '/api/harness/projects', does: 'Projects with sessions or templates.' },
  { name: 'create_harness_template', area: 'harness', method: 'POST', path: '/api/harness/templates',
    does: 'Saves a harness template.',
    params: ['name: string', 'description: string', 'tags: string[]', 'inputs: {key, label, hint?}[]', 'steps: {id, title, instructions, mode: auto | gate, doneWhen, verify?}[]', 'options?: {commitPerStep, maxAutoRounds, maxIdleNudges, maxReviewerReopens, lucky, reviewerModel}', 'scope?: {kind: global} | {kind: project, root}', 'draft?: boolean'] },
  { name: 'update_harness_template', area: 'harness', method: 'PUT', path: '/api/harness/templates/:id',
    does: 'Replaces a harness template; the same body as create_harness_template.', params: ['id: number — the template id', '…the template'] },
  { name: 'delete_harness_template', area: 'harness', method: 'DELETE', path: '/api/harness/templates/:id', does: 'Deletes a harness template.', params: ['id: number'] },
  { name: 'duplicate_harness_template', area: 'harness', method: 'POST', path: '/api/harness/templates/:id/duplicate',
    does: 'Copies a harness template, optionally into another scope.', params: ['id: number', 'scope?: {kind: global} | {kind: project, root}'] },
  { name: 'draft_harness_template', area: 'harness', method: 'POST', path: '/api/harness/templates/draft',
    does: 'Has a model draft a template (not saved) from a description and/or a session\'s conversation.',
    params: ['description?: string', 'sessionId?: string', 'model?: opus | sonnet'] },
  { name: 'start_harness_interview', area: 'harness', method: 'POST', path: '/api/harness/interview',
    does: 'Starts a session that drafts a harness template by talking with the user.',
    params: ['cwd?: string', `permissionMode?: ${PERMISSION_MODES}`, 'model?: opus | sonnet', 'scope?: {kind: global} | {kind: project, root}', 'description?: string'] },
  { name: 'get_harness', area: 'harness', method: 'GET', path: '/api/sessions/:id/harness',
    does: 'A session\'s harness checklist and its event log.', params: [ID, 'limit?: number', 'before?: number'] },
  { name: 'attach_harness', area: 'harness', method: 'POST', path: '/api/sessions/:id/harness',
    does: 'Attaches a template to a session as its harness and starts the first step.', params: [ID, 'templateId: number', 'inputs?: object — input key to value'] },
  { name: 'update_harness', area: 'harness', method: 'PATCH', path: '/api/sessions/:id/harness',
    does: 'Pauses or resumes a session\'s harness, or changes its options.', params: [ID, 'paused?: boolean', 'options?: object'] },
  { name: 'remove_harness', area: 'harness', method: 'DELETE', path: '/api/sessions/:id/harness', does: 'Removes a session\'s harness.', params: [ID] },
  { name: 'approve_harness_step', area: 'harness', method: 'POST', path: '/api/sessions/:id/harness/steps/:index/approve',
    does: 'Approves a waiting gate step; the next step starts.', params: [ID, 'index: number — the step'] },
  { name: 'harness_step_diff', area: 'harness', method: 'GET', path: '/api/sessions/:id/harness/steps/:index/diff', does: 'The git diff of one step.', params: [ID, 'index: number'] },
  { name: 'reopen_harness_step', area: 'harness', method: 'POST', path: '/api/sessions/:id/harness/steps/:index/reopen',
    does: 'Reopens a gate step for more work.', params: [ID, 'index: number'] },
  { name: 'harness_go_back', area: 'harness', method: 'POST', path: '/api/sessions/:id/harness/steps/:index/go-back',
    does: 'Moves the checklist back to a step (the conversation is not rewound).', params: [ID, 'index: number'] },
  { name: 'harness_decide_myself', area: 'harness', method: 'POST', path: '/api/sessions/:id/harness/steps/:index/decide-myself',
    does: 'Stops the reviewer of a gate; the gate waits for the user.', params: [ID, 'index: number'] },
  { name: 'carry_harness', area: 'harness', method: 'POST', path: '/api/sessions/:id/harness/carry',
    does: 'Moves another session\'s harness into this session.', params: [ID, 'fromSessionId: string'] },

  // tags
  { name: 'list_tags', area: 'tags', method: 'GET', path: '/api/tags', does: 'All tags.' },
  { name: 'create_tag', area: 'tags', method: 'POST', path: '/api/tags', does: 'Creates a tag.', params: ['name: string', 'hue: number — 0 to 360'] },
  { name: 'update_tag', area: 'tags', method: 'PATCH', path: '/api/tags/:id',
    does: 'Renames or recolours a tag, or moves its cluster on the map (null anchors lay it out automatically).',
    params: ['id: number', 'name?: string', 'hue?: number', 'anchor_x?: number | null', 'anchor_y?: number | null'] },
  { name: 'reorder_tags', area: 'tags', method: 'PUT', path: '/api/tags/order',
    does: 'Sets the order every tag list shows; ids must name every tag exactly once.', params: ['ids: number[]'] },
  { name: 'delete_tag', area: 'tags', method: 'DELETE', path: '/api/tags/:id', does: 'Deletes a tag (not the default one).', params: ['id: number'] },
  { name: 'set_session_tags', area: 'tags', method: 'PUT', path: '/api/sessions/:id/tags',
    does: 'Replaces a session\'s tags.', params: [ID, 'tagIds: number[]'] },

  // tag rules
  { name: 'list_tag_rules', area: 'tag_rules', method: 'GET', path: '/api/tag-rules', does: 'The rules that tag sessions automatically, in order.' },
  { name: 'create_tag_rule', area: 'tag_rules', method: 'POST', path: '/api/tag-rules',
    does: 'Adds a rule at the end.', params: ['tagId: number', 'condition: path_matches | title_contains | permission_is', 'pattern: string'] },
  { name: 'update_tag_rule', area: 'tag_rules', method: 'PATCH', path: '/api/tag-rules/:id',
    does: 'Changes, reorders, enables or disables a rule.',
    params: ['id: number', 'position?: number', 'enabled?: 0 | 1', 'condition?: path_matches | title_contains | permission_is', 'pattern?: string', 'tag_id?: number'] },
  { name: 'delete_tag_rule', area: 'tag_rules', method: 'DELETE', path: '/api/tag-rules/:id', does: 'Deletes a rule.', params: ['id: number'] },
  { name: 'preview_tag_rules', area: 'tag_rules', method: 'POST', path: '/api/tag-rules/preview',
    does: 'Which rule and tag a session with these facts would get. Writes nothing.', params: ['cwd: string', 'title: string', 'permissionMode: string | null'] },

  // settings
  { name: 'get_settings', area: 'settings', method: 'GET', path: '/api/settings', does: 'Every setting, as strings.' },
  { name: 'update_settings', area: 'settings', method: 'PATCH', path: '/api/settings',
    does: 'Writes settings, values as strings. Known keys: default_permission_mode, default_model, remember_model_per_project, default_project_dir, confirm_before_clear, name_sessions_automatically, end_closes_panel, questions_review_before_send, map_theme (planets | archipelago | desk), map_show_model, map_show_trash, map_show_sloth, map_show_context, map_show_compact_badge, map_scale_labels, map_state_pills (dot | label), planet_scale (0.7–1.6), context_threshold_warn, context_threshold_critical, transcript_edit_diffs (collapsed | expanded), permission_guard_gesture (hold | confirm | single), header_session_stats (bar | button), header_pull_request, header_line_changes (off | branch | split), default_claude_dir, notify_needs_input, notify_session_ended, notify_session_failed, notify_sound, notify_only_when_background, session_instructions_tips, session_instructions_custom, session_instructions_custom_text, limits_auto_continue, limits_continue_text, update_auto_download, delete_sessions_older_than_days (a number or never — deletes old sessions at once), harness_enabled, walkthrough_enabled, terminal_enabled, archipelago_enabled, narrate_model. The phone relay settings and the CLI path are not writable here. A change applies on this Mac only, never to the rest of its device group.',
    params: ['<key>: string — one per setting'],
    deniedKeys: (key) => key.startsWith('remote_') || key === 'claude_executable_path' },
  { name: 'session_instruction_tips', area: 'settings', method: 'GET', path: '/api/session-instructions/tips', does: 'The tips Orbital adds to every session\'s instructions.' },

  // mcp
  { name: 'list_session_mcp', area: 'mcp', method: 'GET', path: '/api/sessions/:id/mcp', does: 'The MCP servers of a running session and their status.', params: [ID] },
  { name: 'add_session_mcp', area: 'mcp', method: 'POST', path: '/api/sessions/:id/mcp',
    does: 'Adds an MCP server through `claude mcp` in the session\'s directory and connects it.',
    params: [ID, 'name: string', 'scope?: local | user', 'transport: stdio | http | sse', 'command?: string — stdio', 'args?: string[]', 'env?: object', 'url?: string — http and sse', 'headers?: object'] },
  { name: 'get_session_mcp_config', area: 'mcp', method: 'GET', path: '/api/sessions/:id/mcp/:name/config', does: 'An MCP server\'s editable definition.', params: [ID, 'name: string — the server'] },
  { name: 'edit_session_mcp', area: 'mcp', method: 'PUT', path: '/api/sessions/:id/mcp/:name',
    does: 'Replaces an MCP server\'s definition; the same body as add_session_mcp. Takes effect after restart_session_mcp.', params: [ID, 'name: string', '…the definition'] },
  { name: 'remove_session_mcp', area: 'mcp', method: 'DELETE', path: '/api/sessions/:id/mcp/:name', does: 'Removes an MCP server from its config.', params: [ID, 'name: string'] },
  { name: 'reconnect_session_mcp', area: 'mcp', method: 'POST', path: '/api/sessions/:id/mcp/:name/reconnect', does: 'Reconnects an MCP server.', params: [ID, 'name: string'] },
  { name: 'toggle_session_mcp', area: 'mcp', method: 'POST', path: '/api/sessions/:id/mcp/:name/enabled', does: 'Turns an MCP server on or off in a running session.', params: [ID, 'name: string', 'enabled: boolean'] },
  { name: 'login_session_mcp', area: 'mcp', method: 'POST', path: '/api/sessions/:id/mcp/:name/login', does: 'Starts an MCP server\'s login and answers the URL for the user to open.', params: [ID, 'name: string'] },
  { name: 'restart_session_mcp', area: 'mcp', method: 'POST', path: '/api/sessions/:id/mcp/restart', notOnCaller: true,
    does: 'Restarts a session\'s process so MCP config changes apply.', params: [ID] },
  { name: 'undecided_mcpjson', area: 'mcp', method: 'GET', path: '/api/mcpjson', does: 'A project\'s .mcp.json servers nobody has approved or denied yet.', params: ['cwd: string', 'claudeDirId?: string'] },
  { name: 'mcpjson_file', area: 'mcp', method: 'GET', path: '/api/mcpjson/file', does: 'The file a .mcp.json server runs.', params: ['cwd: string', 'server: string'] },

  // claude dirs
  { name: 'list_claude_dirs', area: 'claude_dirs', method: 'GET', path: '/api/claude-dirs', does: 'The Claude directories (accounts) Orbital reads.' },
  { name: 'add_claude_dir', area: 'claude_dirs', method: 'POST', path: '/api/claude-dirs', does: 'Adds a Claude directory.', params: ['name: string', 'path: string — absolute'] },
  { name: 'update_claude_dir', area: 'claude_dirs', method: 'PATCH', path: '/api/claude-dirs/:id', does: 'Renames a Claude directory or moves it.', params: ['id: number', 'name?: string', 'path?: string'] },
  { name: 'remove_claude_dir', area: 'claude_dirs', method: 'DELETE', path: '/api/claude-dirs/:id', does: 'Stops reading a Claude directory and hides its sessions (not the last one).', params: ['id: number'] },
  // a profile's login (spec 2026-10-21-log-in-from-orbital-design § 2)
  { name: 'get_claude_dir_login', area: 'claude_dirs', method: 'GET', path: '/api/claude-dirs/:id/login',
    does: 'A profile\'s account (logged in, e-mail, org, plan), its Claude Design sign-in and any login running for it.', params: ['id: number'] },
  { name: 'start_claude_dir_login', area: 'claude_dirs', method: 'POST', path: '/api/claude-dirs/:id/login',
    does: 'Starts logging a profile in (claude) or signing it in to Claude Design (design), or answers the login already running. No browser opens: hand the user its manualUrl (get_claude_dir_login answers it once the CLI printed it), whose page shows a code they paste back into Orbital or give you for enter_claude_dir_login_code.',
    params: ['id: number', 'kind: claude | design'] },
  { name: 'enter_claude_dir_login_code', area: 'claude_dirs', method: 'POST', path: '/api/claude-dirs/:id/login/code',
    does: 'Hands the code the sign-in page showed to the running login.', params: ['id: number', 'kind: claude | design', 'code: string'] },
  { name: 'cancel_claude_dir_login', area: 'claude_dirs', method: 'DELETE', path: '/api/claude-dirs/:id/login/:kind',
    does: 'Cancels the running login of a profile. Nothing is changed.', params: ['id: number', 'kind: claude | design'] },

  // models, commands
  { name: 'list_models', area: 'models', method: 'GET', path: '/api/models', does: 'The models a Claude directory offers.', params: ['claudeDir?: string — its id'] },
  { name: 'validate_model', area: 'models', method: 'POST', path: '/api/models/validate', does: 'Checks a custom model id with a minimal turn.', params: ['model: string', 'claudeDir?: number'] },
  { name: 'list_commands', area: 'commands', method: 'GET', path: '/api/commands', does: 'Slash commands and skills of a session or a directory.', params: ['session?: string', 'cwd?: string', 'claudeDir?: string'] },
  { name: 'command_content', area: 'commands', method: 'GET', path: '/api/commands/content', does: 'The file of one command or skill.', params: ['name: string', 'session?: string', 'cwd?: string', 'claudeDir?: string'] },

  // files, ide
  { name: 'read_file', area: 'files', method: 'GET', path: '/api/files', does: 'A text file a session may show.', params: ['session: string', 'path: string', 'cwd?: string'] },
  { name: 'complete_path', area: 'files', method: 'GET', path: '/api/files/complete', does: '@-path completion in a session\'s directory.', params: ['session?: string', 'cwd?: string', 'prefix?: string'] },
  { name: 'ide_open_files', area: 'ide', method: 'GET', path: '/api/sessions/:id/ide/open-files', does: 'Editor tabs open on the session\'s working tree.', params: [ID] },
  { name: 'ide_open_file', area: 'ide', method: 'POST', path: '/api/sessions/:id/ide/open-file', does: 'Opens a file in the connected editor.', params: [ID, 'path: string', 'line?: number'] },
  { name: 'ide_diagnostics', area: 'ide', method: 'GET', path: '/api/sessions/:id/ide/diagnostics', does: 'The editor\'s diagnostics.', params: [ID, 'path?: string'] },

  // stats, limits, git
  { name: 'stats_overview', area: 'stats', method: 'GET', path: '/api/stats/overview',
    does: 'Usage and cost over sessions, with findings.', params: ['window?: 24h | 7d | 30d | all', 'project?: string', 'model?: string'] },
  { name: 'session_stats', area: 'stats', method: 'GET', path: '/api/stats/sessions/:id', does: 'One session\'s usage, cost and findings.', params: [ID, 'timeline?: 1'] },
  { name: 'get_limits', area: 'limits', method: 'GET', path: '/api/limits', does: 'The plan\'s usage limits per Claude directory.' },
  { name: 'refresh_limits', area: 'limits', method: 'POST', path: '/api/limits/refresh', does: 'Reads the usage limits again.' },
  { name: 'cancel_limit_wait', area: 'limits', method: 'POST', path: '/api/sessions/:id/limit-wait/cancel', does: 'Cancels a session\'s automatic continue at the limit reset.', params: [ID] },
  { name: 'undo_limit_wait_cancel', area: 'limits', method: 'POST', path: '/api/sessions/:id/limit-wait/undo', does: 'Brings the automatic continue back.', params: [ID] },
  { name: 'gh_status', area: 'system', method: 'GET', path: '/api/gh-status', does: 'Whether gh can show pull requests.' },
  { name: 'refresh_branch_status', area: 'system', method: 'POST', path: '/api/branch-status/refresh', does: 'Reads every working tree\'s pull request and line changes again.' },
  { name: 'health', area: 'system', method: 'GET', path: '/api/health', does: 'Orbital\'s version, CLI, billing and paths.' },

  // errors
  { name: 'list_errors', area: 'errors', method: 'GET', path: '/api/errors', does: 'Orbital\'s error log, newest first.', params: ['limit?: number', 'before?: number'] },
  { name: 'mark_errors_seen', area: 'errors', method: 'POST', path: '/api/errors/seen', does: 'Marks errors as seen.', params: ['all?: true', 'ids?: number[]'] },

  // walkthrough
  { name: 'get_walkthrough', area: 'walkthrough', method: 'GET', path: '/api/sessions/:id/walkthrough', does: 'A session\'s walkthrough: its steps and narration.', params: [ID] },
  { name: 'walkthrough_summary', area: 'walkthrough', method: 'GET', path: '/api/sessions/:id/walkthrough/summary', does: 'Steps, files, blind alleys and subagents of a session.', params: [ID] },
  { name: 'narrate_walkthrough', area: 'walkthrough', method: 'POST', path: '/api/sessions/:id/walkthrough/narrate', does: 'Starts narrating a session\'s walkthrough.', params: [ID] },
];
