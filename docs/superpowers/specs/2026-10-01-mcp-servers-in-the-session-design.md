---
id: 2026-10-01-mcp-servers-in-the-session-design
title: MCP servers — a /mcp dialog that shows, toggles, adds, edits and removes a session's servers
status: done
type: spec
domain: sessions
related:
  - mcp-servers-in-the-session
  - the-mcp-toggle-is-project-wide
  - mcp-config-is-written-by-the-cli-in-private-scopes
  - mcp-server-templates
  - mcp-login-from-orbital
tags:
  - server
  - runner
  - composer
  - mcp
---
# MCP servers in the session

## Problem

An Orbital session loads the same MCP servers a terminal session would
(the Runner passes `settingSources: ['user', 'project', 'local']`), but
Orbital shows nothing about them. A session with six servers and one
with none look the same, and a server that failed to connect fails
silently — the user finds out only when the model says a tool is
missing. Adding or changing a server means leaving Orbital for a
terminal, which is exactly what Orbital exists to avoid.

## Where it lives

Typing `/mcp` in the composer of a running Orbital session opens the
**MCP dialog**. Nothing is sent to the session — the CLI has no
interactive `/mcp` under the SDK anyway. The detail panel and the
transcript are not touched.

The composer intercepts `/mcp` the way it intercepts `/compact`. The
server adds `/mcp` to the completion list the way it adds `/rewind`
(`withOrbitalCommands` in `routes.ts`), so it can be found by typing `/`.

`/mcp` on a session without a running process (asleep, ended) does not
start one: the dialog opens with a note that the list needs a running
session. Terminal sessions have no composer for it; Orbital has no
control channel to them.

## The dialog

### The list

One row per server the running session reports:

- name;
- status — connected, failed, needs login, starting, off (the SDK's
  `connected | failed | needs-auth | pending | disabled`; an unknown
  string from a newer CLI is shown as text);
- the error message, when failed;
- origin — the SDK's `source`, falling back to `scope` on a CLI that
  predates `source` (user, local, project, plugin, claudeai, managed …).
  Orbital's own server reads `built-in`. A plugin's server reads
  `plugin · <plugin>`, the plugin taken from a `plugin:<plugin>:<server>`
  name, and the row shows `<server>` as its name;
- tool count, when connected.

Status is neutral; only `failed` takes the error-log red. A server that
is off dims its name.

Per-row actions:

- **Reconnect** — on a `failed` server.
- **On/off** — on every server except Orbital's own
  (`ORBITAL_MCP_SERVER`). A strip above the list, in every state that
  shows switches, says that the change holds for the whole project,
  terminal sessions included, until switched back (adr
  `the-mcp-toggle-is-project-wide`). The switch acts on the running
  session at once — no restart; a server switched on shows as starting
  until it connects.
- **Edit** and **Remove** — only on servers whose origin is `user` or
  `local`, the two scopes Orbital writes (below). A `project` server
  (`.mcp.json`), a plugin's, a claude.ai connector or a managed one is
  shown and can be toggled, nothing more.
- `needs-auth` — a note that the server needs a login; Orbital cannot do
  it yet (idea `mcp-login-from-orbital`).

A row with an action in flight is locked and says what is happening
(switching off…, reconnecting…, removing…).

The list loads when the dialog opens and is replaced by every action's
response. While any row is `pending` it is fetched again every
`MCP_REFRESH_MS` (canvas: 2 s), only while the dialog is open. A list
that cannot be read — the session does not answer within
`MCP_STATUS_TIMEOUT_MS` (canvas: 10 s), or the request fails — shows the
error and a Retry, nothing else.

### Add and edit

A form with:

- **name** — required, no whitespace;
- **scope** — `local` (this project, only me; the default) or `user`
  (all my projects). `project` is not offered (adr
  `mcp-config-is-written-by-the-cli-in-private-scopes`);
- **transport** — `stdio`, `http` or `sse`;
- for `stdio`: command (required), arguments as one line, environment
  variables (key/value rows);
- for `http` / `sse`: URL (must start with `http://` or `https://`),
  headers (key/value rows).

The arguments line is split into words by shell rules — whitespace
separates, single and double quotes group, a backslash escapes — and
nothing is expanded (no variables, no globs). An unterminated quote is a
field error. Edit joins the stored list back into one line, quoting a
word that needs it, so that splitting it again gives the same list.

The checks above run in the form, before anything is sent; the CLI's own
validation still has the last word. A CLI refusal keeps the form filled
and shows a block "CLI refused · nothing was saved" with the command
Orbital ran — every env and header value replaced by `***` — and the
CLI's own output.

Env and header values are masked; one row at a time can be revealed. Esc
or "← Servers" on a form with unsaved changes asks before throwing them
away.

Edit opens the same form filled with the server's current definition.
Renaming is remove-then-add under the new name. Moving between `local`
and `user` is the same.

Remove asks once, inline, naming the server and the config it leaves;
the server's definition, env vars and headers go with it.

When a change does not reach the running session on its own (Verify
first, 2), a banner above the footer says it applies after the session
restarts, the transcript kept, with a Restart button. A toggle never
raises it.

## Server

### Runner — the live session

`QueryFn` and the per-session `generator` type gain optional
`mcpServerStatus`, `reconnectMcpServer`, `toggleMcpServer` and
`reloadPlugins`, optional for the same reason as the others (a fake in a
test, an old CLI).

The `system/init` handler keeps `msg.mcpServers` on the session state as
the last known list.

New Runner methods, each throwing `session … is not active` for a session
it does not run, like `setModel`:

- `mcpServers(sessionId)` — `mcpServerStatus()`, or the init snapshot
  when the generator lacks the method. A call that throws, or does not
  answer within `MCP_STATUS_TIMEOUT_MS`, is an error (the route's 502 /
  504) — the snapshot is not a stand-in for a session that stopped
  answering. Returns `McpServerRow[]`, never the SDK's raw object.
- `reconnectMcpServer(sessionId, name)`,
  `toggleMcpServer(sessionId, name, enabled)` — pass through. A method the
  generator lacks is an error, not a silent no-op. Toggling
  `ORBITAL_MCP_SERVER` is refused here, not only hidden in the UI.
- `reloadMcpConfig(sessionId)` — `reloadPlugins()`, which makes the
  running session connect a server just added (Verify first, 2).

The CLI pushes no status change, so the list is pulled.

```ts
type McpServerRow = {
  name: string;          // the SDK's name, the key every action uses
  status: string;        // the SDK's status, passed through
  error?: string;
  origin?: string;       // source ?? scope
  plugin?: string;       // from a plugin:<plugin>:<server> name
  toolCount?: number;
  toggleable: boolean;   // false for ORBITAL_MCP_SERVER
  editable: boolean;     // found in the user or local config (Verify first)
};
```

Names, errors and config values are untrusted text from config files;
React escapes them, nothing renders them as HTML.

### Config — through the CLI

A new module under `server/src/mcp/` does every write by running the CLI
Orbital already resolves (`resolveClaudeCli`), with `cwd` set to the
session's cwd so `local` lands on the right project:

- add: `claude mcp add-json --scope <local|user> <name> <json>`;
- remove: `claude mcp remove --scope <local|user> <name>`;
- edit: remove, then add. When the add fails, the old definition is added
  back and the CLI's error is returned. No step leaves the server gone.

A refusal returns the CLI's output and the command line it ran, with
every env and header value masked; the unmasked line is never logged or
sent.

Arguments go through `execFile`, never a shell. The JSON is built by the
server from validated fields, not passed through from the client.

Reading a definition for the edit form is the one read Orbital does
itself: `mcpServers` at the top of `~/.claude.json` (`user`) and
`projects[<cwd>].mcpServers` (`local`), read-only — the precedent is the
command catalog, which reads CLI-owned files the same way. An entry the
reader does not understand is reported as "cannot be edited here", not
guessed at.

When the CLI is `missing`, add/edit/remove answer 503 and the dialog
says why; the list and the toggle still work, since they go through the
live session.

### Routes

- `GET /api/sessions/:id/mcp` → `{ servers }`
- `POST /api/sessions/:id/mcp/:name/reconnect` → `{ servers }`
- `POST /api/sessions/:id/mcp/:name/enabled`, body `{ enabled }` →
  `{ servers }`
- `GET /api/sessions/:id/mcp/:name/config` → the definition for the
  form
- `POST /api/sessions/:id/mcp` (add), `PUT /api/sessions/:id/mcp/:name`
  (edit), `DELETE /api/sessions/:id/mcp/:name` (remove) →
  `{ servers, restartNeeded }` — add runs `reloadMcpConfig` and answers
  `restartNeeded: false`; edit and remove answer `true`

- `POST /api/sessions/:id/mcp/restart` → `{ servers }` — the banner's
  Restart: `stopAndWait`, then `start` with `resume: id`, an empty prompt
  (which parks the process until the next send, `needs_input`), and the
  row's model and permission mode, as `revive` does. Refused with 409
  while a turn is running or a decision is pending; the button is
  disabled then too.

Unknown session → 404. Session not running → 409. Invalid body → 400.
Unknown server name → 404. Scope `project`, or editing a server that is
not `user`/`local` → 400. CLI missing → 503. CLI refuses → 502 with its
message and the masked command. Session does not answer the status
request in time → 504.

## Web

`api.mcpServers`, `api.reconnectMcpServer`, `api.setMcpServerEnabled`,
`api.mcpServerConfig`, `api.addMcpServer`, `api.updateMcpServer`,
`api.removeMcpServer`; a `/mcp` intercept in the composer; the dialog.
How the dialog looks is canvas `Feature - MCP dialog.dc.html`
(artboards 12a–12d) in Claude Design.

## Verify first

Checked on 2026-10-01 with SDK 0.3.278, a throwaway session and an
isolated `CLAUDE_CONFIG_DIR`:

1. **The toggle persists.** `toggleMcpServer(name, false)` adds the name
   to `disabledMcpServers` in the project's entry of `~/.claude.json`;
   `true` takes it out. A `.mcp.json` server goes to the same list. The
   running session reflects it at once (`disabled`, then `connected`).
2. **Add reaches the running session, edit and remove do not.** After
   `claude mcp add-json`, `reloadPlugins()` connects the new server — but
   it reports `source: 'dynamic'`, not its scope, until the session
   restarts. After `claude mcp remove`, the server stays connected
   through `reloadPlugins()`. So: add → `reloadPlugins()`, no banner;
   edit and remove → the restart banner.
3. **An unapproved `.mcp.json` server connects anyway**, reported as
   `source: 'project'`. Out of scope here; fix
   `unapproved-mcp-json-servers-start-in-orbital-sessions`.

Two consequences for the build:

- The project key in `~/.claude.json` is the **real path** of the cwd
  (`/private/tmp/…` for `/tmp/…`); the reader resolves it with `realpath`
  before looking the project up.
- Whether a row is editable, and its origin when the SDK says `dynamic`,
  comes from the reader: a name found in the `user` or `local` config is
  editable and shows that scope. `source` alone would leave a server just
  added uneditable until the restart.

## Testing

- Runner: init snapshot kept; live answer preferred, snapshot as
  fallback; inactive session throws; missing method throws;
  `ORBITAL_MCP_SERVER` toggle refused.
- Config module: argument lists built for add/remove per scope; `project`
  refused; edit restores the old definition when the add fails (fake
  CLI); the masked command carries no secret value; the `~/.claude.json`
  reader on user, local, missing and malformed entries.
- Argument line: split and join round-trip — quotes, escapes, empty
  words, words with spaces; an unterminated quote is an error.
- Plugin name parsing: `plugin:<plugin>:<server>`, and names that only
  look like it.
- Routes: each status code above, and each happy path.
- No UI tests.
