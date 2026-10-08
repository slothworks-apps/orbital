---
id: 2026-10-04-multiple-claude-directories-design
title: More than one Claude directory — watch them all, launch under the right one
status: active
type: spec
domain: sessions
related:
  - claude-directories-are-contexts-in-one-server
  - a-session-belongs-to-the-first-directory-that-indexed-it
  - helper-queries-run-under-the-sessions-account
  - log-in-a-claude-directory-from-orbital
  - 2026-09-21-settings-sections-design
  - 2026-10-03-usage-limits-design
  - the-new-session-dialog-remembers-the-last-launch
  - the-phone-tunnels-the-api-behind-an-allowlist
  - why-orbital
tags:
  - settings
  - accounts
---
# More than one Claude directory

People run more than one Claude Code: a personal one in `~/.claude`, a
work one in `~/.claude-work` under the employer's enterprise login,
started with `CLAUDE_CONFIG_DIR=~/.claude-work claude`. Each directory
has its own transcripts, its own login and its own plan limits.

Orbital watches exactly one directory today. Work sessions are invisible,
and a session Orbital starts always runs under whatever login the default
directory holds. This spec lets Orbital watch several directories at
once and start, resume and continue every session under the directory it
belongs to.

## What is there today

- `resolveClaudeDir` (`server/src/paths.ts`) picks one directory at boot:
  `ORBITAL_CLAUDE_DIR`, then the `claude_directory` setting, then
  `~/.claude`. A change needs a restart.
- Everything under it is read from that one path: transcripts in
  `projects/`, the live CLI registry in `sessions/`, IDE lock files in
  `ide/`, and `commands/`, `skills/`, `plugins/` and `settings.json` for the
  command catalog.
- The runner never passes `CLAUDE_CONFIG_DIR` to `query()`. With a
  non-default `claude_directory`, Orbital watches one tree while the CLI it
  spawns writes into another, so its own sessions never show up. The
  existing setting is half-broken, and this spec fixes that too.
- `claudeJsonPath` (`server/src/mcp/claudeJson.ts`) follows
  `CLAUDE_CONFIG_DIR` from the server's own environment, not the watched
  directory. The two can disagree.
- The limits probe and the model catalog ask one account.

## Scope

- Watch, start, resume and continue sessions in any configured directory.
  Watching alone would leave work sessions read-only, which is the
  terminal Orbital is meant to replace.
- Limits and the model catalog are per directory from the first version.
  A shared probe would put a work session's rate-limit event into the
  personal account's windows, and a shared catalog would offer a model the
  enterprise account does not have.
- A user with one directory sees no change except the new shape of the
  Settings row.

## 1. Directories and the data model

### Table

```
claude_dirs
  id          integer primary key
  name        text not null          -- the user's label, e.g. "Work"
  path        text not null unique   -- absolute, `~` expanded
  created_at  integer not null
```

The migration creates row 1 from what `resolveClaudeDir` would answer
today (the `claude_directory` setting, else `~/.claude`), named
`Personal`. The `claude_directory` setting is then dropped.
`ORBITAL_CLAUDE_DIR` keeps its meaning: when set, it replaces row 1's path
at runtime and the row shows it as overridden. An operator who exported
it meant it.

`sessions.claude_dir_id integer not null default 1` records which
directory a session belongs to. Existing rows get 1.

Settings keys:

- `default_claude_dir`: the id the dialog falls back to, and the one
  sessions started without a picker use.
- `new_session_last_claude_dir`: the last launch's choice (see § 3).

### Adding, editing, removing

- **Adding a directory takes effect at once.** The server builds its
  context (§ 2) and starts it. No restart.
- **Changing a path** works like removing the directory and adding it
  again.
- **Renaming** changes only the label.
- **Removing a directory** stops its context and hides its sessions. Their
  rows stay, so adding the same path back brings them back. The last
  remaining directory cannot be removed.
- **The default** can be any configured directory.
- **Validation:** a path is `~`-expanded, must be absolute, must exist and
  must be a directory, and may not duplicate another row. A directory
  without `projects/` yet is valid, because a fresh `CLAUDE_CONFIG_DIR`
  only gets one after the first session. The watcher waits for it the way
  `watchDir` already waits for a missing directory.

### Id collisions

Session ids are UUIDs and, in practice, collide only when the work
directory was made by copying `~/.claude`. Then both directories hold the
same transcripts. A session belongs to the directory that indexed it
first. The default directory is indexed first at boot. A transcript with
an id already owned by another directory is skipped, and the skip is
recorded once per directory in the error log. See
[[a-session-belongs-to-the-first-directory-that-indexed-it]].

## 2. One context per directory

Everything that today reads `claudeDir` takes a directory as an argument
instead of a module constant. For each configured directory the server
holds a context of:

| part | reads |
|---|---|
| transcript watcher and indexer | `<dir>/projects` |
| live CLI registry | `<dir>/sessions` |
| IDE lock store | `<dir>/ide` |
| command and skill catalog | `<dir>/commands`, `<dir>/skills`, `<dir>/plugins`, `<dir>/settings.json` |
| MCP config | `.claude.json` (see § 4) |
| model catalog | an SDK probe under this directory |
| limits probe | an SDK probe under this directory |

The indexer writes `claude_dir_id` on insert and never changes it.
`transcriptPathOf` and the live tail join the session's own directory,
not a global `projectsDir`.

Why one server with contexts rather than a server per directory:
[[claude-directories-are-contexts-in-one-server]].

## 3. Launching

### Which directory a new session runs under

The New session dialog gets a directory choice, prefilled the same way as
the project and the tag
([[the-new-session-dialog-remembers-the-last-launch]]):

1. The selected planet's directory, when a planet is selected as the
   dialog opens.
2. `new_session_last_claude_dir`, the last launch's choice.
3. `default_claude_dir`.

A launch stores its choice in `new_session_last_claude_dir`. A directory
removed since then falls through to the next step.

Sessions started without a dialog:

- `spawn_session` (the Orbital MCP tool) inherits the parent session's
  directory.
- `POST /api/sessions` without `claudeDirId` uses `default_claude_dir`.
- Resume, continue and revive of a terminal session always use the
  session's own directory. Nothing is chosen.

### The environment

The runner passes `env` to `query()`, built from `process.env` per
session:

- **Directory is the CLI's default** (`<home>/.claude`):
  `CLAUDE_CONFIG_DIR` is **removed**. On macOS the CLI keeps its login in
  the keychain item `Claude Code-credentials`. Once the variable is set,
  the item becomes `Claude Code-credentials-<first 8 hex of sha256(the
  variable's string)>`. Checked 2026-10-04 on this Mac: `~/.claude-work`
  logs in under `…-73a42e99`, and that is its hash. Setting the variable
  to `~/.claude` would look for `…-b9bae42b`, which does not exist, and the
  login would be gone.
- **Any other directory:** `CLAUDE_CONFIG_DIR=<absolute path>`. The CLI
  rejects a relative one and reads the variable only at start-up, so it
  must come through `env`, never through a settings file.
- **The string is passed exactly as stored.** The hash is taken of the
  string, so `/x/.claude-work/` and a symlinked spelling name different
  logins. A path is stored `~`-expanded and with no trailing slash
  (`path.resolve`), never `realpath`-ed. That is what a shell gives for
  `CLAUDE_CONFIG_DIR=~/.claude-work`. The `realpath` is used only to
  refuse duplicates.

### Authentication

The CLI ties its login to the config directory: the OAuth login in the
keychain, an `apiKeyHelper` or managed settings in `<dir>/settings.json`.
The work directory therefore brings its enterprise login with it, and
Orbital reads no credentials.

A directory nobody has logged in to fails the session with the CLI's own
error, shown the way any start-up error is shown today. Logging in from
Orbital is [[log-in-a-claude-directory-from-orbital]]. Until then it takes
one `CLAUDE_CONFIG_DIR=<dir> claude` in a terminal.

### Billing

Billing stays one decision for the whole server
(`ORBITAL_USE_API_KEY`):

- **Subscription** (the default): `ANTHROPIC_API_KEY` is deleted for every
  directory, as today.
- **`ORBITAL_USE_API_KEY=1`:** the key wins over every directory's own
  login, enterprise included. The Billing row in Settings says so when
  more than one directory is configured.

## 4. Helper queries

Every other SDK call runs under a directory too, with the same `env` rule
as § 3:

- **The titler, the narrator, harness ask and the harness reviewer** run
  under the directory of the session they are about. A work session's
  content must not go out through the personal account to be summarised.
  See [[helper-queries-run-under-the-sessions-account]].
- **The limits probe and the model catalog** run once per directory.
- **The model validation turn and the model probe** in
  `server/src/models/catalog.ts` get `persistSession: false`. Today the
  validation turn writes a transcript the indexer shows as a session
  ([[ephemeral-title-queries]] is the same problem, already fixed for the
  titler). With more than one directory it would also land in whichever
  directory the probe ran under.

`claudeJsonPath` takes the session's directory: `<dir>/.claude.json` when
`CLAUDE_CONFIG_DIR` would be set for it, `<home>/.claude.json` for the
default.

## 5. Limits

`GET /api/limits` returns one snapshot per directory, each with the
directory's id and name.

- A `rate_limit_event` from a session updates its own directory's
  snapshot.
- A limit wait fires on its own directory's reset.
- A directory with no plan windows (an enterprise account billed by
  usage) shows that limits are not tracked for it, the way
  `ORBITAL_USE_API_KEY=1` does today.
- The probe's watch/refresh rule is unchanged, and it probes every
  directory.

## 6. API

New, Mac only, not on the phone allowlist:

- `GET /api/claude-dirs`: the list, each with `id`, `name`, `path`,
  `isDefault`, `overriddenByEnv`, `exists`, and `account` (see below).
- `POST /api/claude-dirs` `{ name, path }`.
- `PATCH /api/claude-dirs/:id` `{ name?, path? }`.
- `DELETE /api/claude-dirs/:id`. Refused for the last directory.
- The default goes through `PATCH /api/settings` `default_claude_dir`.

`account` is the e-mail in `oauthAccount.emailAddress` of the
directory's `.claude.json`, when there is one. The format is
undocumented. When the field is missing or unreadable, `account` is
`null` and the UI shows nothing. It is never an error.

Changed, all already on the allowlist:

- **The session shape** carries `claudeDirId`.
- **`GET /api/sessions/defaults`** adds `claudeDirs: { id, name }[]`,
  `defaultClaudeDir` and `lastClaudeDir`.
- **`POST /api/sessions`** accepts `claudeDirId`. An unknown id is a 400.
- **`GET /api/models` and `GET /api/commands`** take `?claudeDir=<id>`. The
  default is `default_claude_dir`.

`GET /api/health` reports `paths.claudeDirs` (id and path) instead of
`paths.claudeDir`. The desktop app reads only `claudeCli` from it, so
nothing there changes.

## 7. The phone

**Built for the phone too.**

- Sessions on the phone carry the directory label when more than one
  directory is configured. It rides on `claudeDirId` in the session shape
  and the names from `GET /api/sessions/defaults`.
- The phone's New session screen has the directory choice, prefilled
  exactly as on the Mac (§ 3). It sends `claudeDirId` with
  `POST /api/sessions`.
- The allowlist does not change. Every route the phone needs is on it
  already.
- **Left out on purpose:**
  - **Managing directories.** It means typing paths on the Mac's disk,
    which the phone cannot browse.
  - **The limits view.** It is not on the phone today, and this does not
    change that.

## 8. UI

Not designed here. The design comes from Claude Design, from the prompt
in the appendix. The behaviour the design must carry:

- Directory marks appear only when two or more directories are
  configured.
- The Settings row replaces "Claude directory" in General.

## Edge cases

- **A configured directory is deleted from disk.** Its context stops
  watching. The Settings row shows it as missing. Its sessions stay on the
  map as they are, and a launch under it fails with the CLI's error. It is
  not removed automatically.
- **Two rows reach the same directory through a symlink.** Paths are
  compared after `realpath`, and the second row is refused.
- **`CLAUDE_CONFIG_DIR` is set in the environment Orbital was started
  with.** It is ignored for spawning: the per-session `env` always sets or
  removes it explicitly. `claudeJsonPath` no longer reads it from
  `process.env`.
- **A terminal session in the work directory** shows up through the work
  directory's registry and transcripts, read-only, with its label. Revive
  runs it under the work directory.

## Tests

- **`resolveClaudeDir` and the migration's row 1:** env override, stored
  value, default, `~` expansion.
- **The `env` builder:** the default directory removes
  `CLAUDE_CONFIG_DIR`, any other directory sets it absolute, and an
  inherited value never leaks through.
- **`claudeJsonPath` per directory.**
- **The indexer:** `claude_dir_id` on insert, never rewritten. A colliding
  id from a second directory is skipped and recorded once.
- **The dialog's prefill order** (`openingLaunch`): planet, then last
  launch, then default, then a removed directory falling through.
- **Routes:**
  - `POST /api/sessions` with an unknown `claudeDirId`.
  - `DELETE` on the last directory.
  - Duplicate and symlinked paths.
  - `spawn_session` inheriting the parent's directory.
- **Limits:** a rate-limit event lands in its own directory's snapshot.

## Shipping

When built: desktop **minor** (a new feature), Android **minor** (the
directory choice and label), each with a changelog line. The relay does
not change.

## As built

These differ from the text above:

- **The server stores the last launch's choice.** `POST /api/sessions`
  with an explicit `claudeDirId` writes `new_session_last_claude_dir`
  itself, because the phone cannot write settings.
- **Unowned rows go to the next directory that indexes them.** A
  removed directory's id is never reused. A path change marks its sessions
  unowned (`claude_dir_id = 0`). The next directory to index their
  transcripts claims them, which is how adding a path back brings them
  back.
- **One IDE lock store** watches every directory's `ide/`. The editors
  belong to the machine, not to an account.
- **Context windows stay in one map**, because they describe a model.
  Each directory keeps its own model list: `models_catalog` for the first,
  `models_catalog:<id>` for the others.
- **Resume ignores `claudeDirId`.** A `POST /api/sessions` with `resume`
  always runs under the resumed session's directory.
- **Two "not tracked" wordings on the Limits page:** API-key billing, or
  an account without plan windows. Checked 2026-10-04: the enterprise work
  account answers with no windows.
- **The UI follows `Feature - Claude directories` 44a–44f.** A directory
  is a filled square mark with a monogram (`claudeDirMonograms` in
  `web/src/lib/claudeDirs.ts`), in front of the planet label from 70 %
  zoom up, first on the sidebar's and the phone's meta line, as a chip
  after the tag in the detail header, and as the head of each group on the
  Limits page. New session shows two or three directories as segments
  between the project and the model, four or more as a control in its
  header; ⌘D steps to the next one.
- **`GET /api/sessions/defaults` carries more than names.** Each entry
  has `path`, `account` and `exists` too, for the mark's tooltip and the
  pickers' sub line on the Mac and the phone. The three are optional to the
  web: an older Mac sends the names only.
- **A directory missing on disk cannot be chosen.** It is shown, at half
  strength, in every picker, and the prefill falls through it like a
  removed one. Its sessions stay on the map, as § Edge cases says; the
  canvas notes suggest hiding them, which was not taken.
- **The map's mark has no tooltip.** The label takes no pointer, so a
  press on it reaches the map.

## Out of scope

- Per-directory filters on the map or in stats.
- Logging in from Orbital: [[log-in-a-claude-directory-from-orbital]].
- Moving a session from one directory to another.
- Different billing modes per directory.

## Appendix: prompt for Claude Design

> Orbital can now watch more than one Claude Code configuration directory
> at once — typically a personal `~/.claude` and a work `~/.claude-work`
> with a different (enterprise) login. Each directory has a user-given
> name ("Personal", "Work"). Every session belongs to exactly one
> directory, and a new session runs under one. Please design these
> surfaces, desktop and phone:
>
> 1. **Settings → General: the list of Claude directories**, replacing the
>    single "Claude directory" row. Per row: name, path, which one is the
>    default, the signed-in account e-mail when known (may be absent), and
>    a quiet state for "this directory is missing on disk" and "path is
>    overridden by ORBITAL_CLAUDE_DIR". Add, rename, change path, remove,
>    make default. The last one cannot be removed. When more than one
>    directory exists, the read-only Billing row may need one line saying
>    an API key (ORBITAL_USE_API_KEY) overrides every directory's login.
> 2. **New session dialog (desktop)**: a directory choice next to the
>    project, model and tag choices. It is prefilled (selected planet's
>    directory → last launch → default) and changed rarely, so it should
>    not compete with the project field.
> 3. **New session screen (phone)**: the same choice in the phone's
>    layout.
> 4. **Which directory a session belongs to**: on the map (planet or its
>    label), in the session list/sidebar, in the session detail header and
>    in the phone's session list.
> 5. **The limits page**: limit windows grouped per directory. A directory
>    may have no windows at all ("not tracked"); show that calmly.
>
> Constraints:
>
> - Directory marks appear only when two or more directories are
>   configured. With one directory nothing changes anywhere.
> - The mark must not read as a state, a permission mode, a tag or a diff
>   colour. It must not reuse the state dots, the mode-dot hue family, tag
>   colours or diff hues. It is not a tag: a session already carries one
>   tag, and the directory is a separate, orthogonal fact.
> - Calm, per `why-orbital`: no alarm colours, nothing blinking. A missing
>   directory is a quiet note, not an error banner.
> - Works for 2–4 directories with names of a few words.
> - The work/personal distinction should be glanceable on the map without
>   adding clutter at far zoom. Readable at close zoom is enough.
> - Phone: same meaning, fitted to the phone's list and New session
>   screen. No directory management on the phone.
