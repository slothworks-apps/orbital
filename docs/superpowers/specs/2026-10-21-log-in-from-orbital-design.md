---
id: 2026-10-21-log-in-from-orbital-design
title: Log in from Orbital — a profile's login and its Claude Design sign-in, and Claude directories become Profiles
status: done
type: spec
domain: sessions
related:
  - log-in-a-claude-directory-from-orbital
  - design-login-from-orbital
  - mcp-login-from-orbital
  - 2026-10-04-multiple-claude-directories-design
  - 2026-10-03-usage-limits-design
  - why-orbital
tags:
  - accounts
  - mcp
---
# Log in from Orbital

A profile's login can lapse at any time: an OAuth session that expired
and could not be refreshed, or a fresh `~/.claude-work` that was never
logged in. Today the user learns it from a line in the transcript —
"Failed to authenticate: OAuth session expired and could not be
refreshed" — and has to open a terminal, run
`CLAUDE_CONFIG_DIR=<dir> claude` and `/login`, then come back and type
"continue". Claude Design is the same: DesignSync fails with "run
/design-login", a TUI-only command.

Orbital runs both logins itself, and a session that stopped on a lost
login continues by itself once the login is back.

With it, "Claude directories" are renamed **Profiles** wherever the user
reads them, and get a Settings section of their own.

The design is `Feature - Log in.dc.html` in Claude Design, artboards
62a–62h: the notice in Planets (62a) and Desk (62b), Settings → Profiles
(62c), parts and states (62d), the phone and another Mac (62e, every
state at phone width in 62h), Profiles seen from another Mac (62g) and
the rename (62f). This spec holds the behaviour; where the two disagree
on what the user sees, the canvas wins.

## Scope

- **For:** anyone with more than one profile, or whose login lapses —
  enterprise logins in particular expire.
- **Lives:** on by default. Nothing new appears until a login is lost;
  the Settings section is a move and a rename of what is already there.
- **An existing user notices:** "Claude directories" read "Profiles", and
  they moved from General into a Profiles section. The transcript error
  of a lost login becomes a notice with "Log in". A session stopped on a
  lost login now counts as NEEDS INPUT in the HUD and in notifications
  (before, it read as a finished turn), and after a login the sessions
  waiting on it send a message by themselves.
- **Can be set:** nothing new. Continuing follows the limits feature's
  existing switch, "Continue automatically after a limit reset", and
  sends its "Message sent on continue"; with the switch off, a login
  says so in the transcript and sends nothing.
- **Terminal sessions** get no notice and no continuation: they are
  shown, not driven (`docs/why-orbital.md`). Their profile can be logged
  in from Settings → Profiles.
- **Other devices** — the phone, and another Mac or a headless server in
  the device group — log in too, through the manual path, behind the
  `manage` grant (§ 6).

## What the CLI does (spike, 2026-10-21, CLI 2.1.287)

Both logins are run by the CLI as a child process; neither needs a TTY.
Run with the same executable Orbital runs sessions with (§ 1), under
`claudeDirEnv` for the profile — the default
profile gets **no** `CLAUDE_CONFIG_DIR`, since setting it to `~/.claude`
names another keychain item and another `.claude.json`.

### `claude auth login`

- Plain text on stdout, no JSON:
  1. `Opening browser to sign in…` — the CLI opens the browser itself.
  2. `If the browser didn't open, visit: <url>` — the manual URL; its
     `redirect_uri` is `platform.claude.com/oauth/code/callback`, which
     shows a code to paste.
  3. `Paste code here if prompted > ` with no newline; stdin takes the
     code and a newline.
  4. `Login successful.`, then the process exits.
- Meanwhile it listens on `127.0.0.1:<port>` for the browser it opened;
  whichever of the two paths finishes first wins.
- It opens the browser through `$BROWSER` when the variable is set
  (checked: a script in `BROWSER` received the sign-in URL), and with
  `open` otherwise.
- The manual path (checked with `BROWSER` silenced): the page shows a
  code of the form `<code>#<state>`; written to stdin with a newline it
  ends in `Login successful.` and exit 0. A wrong code ends at once in
  `Login failed: Request failed with status code 400` and exit 1 — no
  second prompt.
- It has no time limit of its own: a login nobody answers waits for
  ever.
- Options: `--claudeai` (default), `--console`, `--sso`, `--email`.
  Orbital passes none.

### `claude auth status --json`

`loggedIn`, `authMethod`, `apiProvider`, `email`, `orgId`, `orgName`,
`subscriptionType`, `configDirectory`; exit 1 when logged out.

### `claude design-login --json`

Hidden, written for the VS Code extension. JSON lines.

- stdout: `{"event":"pages","url","manual_url","manual_first"}`, then
  `{"event":"done","ok":true}` or `{"event":"done","ok":false,"message"}`
  with a sentence fit for the user (cancelled, timed out after five
  minutes, failed, unusable credential, not saved).
- It does **not** open the browser; the host opens `url` (the localhost
  callback) or, when `manual_first`, `manual_url`.
- stdin: `{"code":"<code>#<state>"}` per line for the manual path.
  **Closing stdin cancels the sign-in**, so stdin stays open until
  `done`.
- `--status`: `{"available","signed_in","can_sign_in_here","reason"?}`.
- Refuses when stdin is a TTY, and when it detects it was spawned from a
  Claude Code session (`CLAUDECODE`, `CLAUDE_CODE_*` in the
  environment). The spawn drops those variables.

### A login again signs Claude Design out

Logging a profile in again (`auth login` while it is logged in, as
"Switch account" does) left its Claude Design sign-in signed out
(checked 2026-10-21 on `~/.claude`). After every claude run Orbital
reads both statuses again, so the row says so; it does not sign Design
in again by itself.

`design-login` reports no account: the sign-in takes whichever account
the browser's claude.ai is on, and nothing says which one it was
(2026-10-21: a sign-in meant for the personal account went to the work
one). Orbital cannot name it either.

### A live session picks up a new login

A session whose turn failed with `authentication_failed` and whose
process kept running took the next message after the login without a
restart. Continuing is a send, not a revive.

The transcript entry of the failure is a synthetic assistant message
(`model: "<synthetic>"`) with `error: "authentication_failed"`,
`isApiErrorMessage: true` and the text above.

Both commands are undocumented in their output (`design-login` is hidden
outright) and can change with any CLI update, like the transcript
format. Every read is field by field and tolerant; a shape Orbital does
not know is an error with the CLI's words, never a crash.

## 1. Running a login (server)

A `LoginService` (`server/src/login/`) runs at most one login per
profile and kind (`claude` or `design`) at a time. A second start of the
same one answers the running login's state.

- **Executable:** the one the MCP routes already use, `mcpCliPath`
  in `server/src/index.ts` — `claudeCli.path`, or the SDK's bundled
  binary when sessions run on it. Both versions in use on 2026-10-21
  (2.1.280 on PATH, 2.1.287 bundled) have both commands. With no
  executable at all, the routes answer 503 and "Log in" is disabled.
- **Spawn:** `auth login` or `design-login --json`, `cwd` the home
  directory, `env` from `claudeDirEnv` with every `CLAUDECODE` and
  `CLAUDE_CODE_*` variable removed, stdin a pipe held open, stdout and
  stderr read line by line.
- **Started from another device:** `BROWSER` is set to a command that
  does nothing (`/usr/bin/true`), so no browser opens on a Mac nobody is
  at, and the localhost path is never taken; the login finishes through
  the pasted code. Started on this Mac, `BROWSER` is removed, so the CLI
  opens the default browser itself. The login records who started it;
  the state answers `manualOnly` for one started elsewhere.
- **States:** `running` (with `manualUrl`, and for design also `url` and
  `manualFirst`; `step` is `browser`, `code`, or `checking` once a code
  has been handed over), then `succeeded` (with the account it is now
  logged in as) or `failed` (with a message). A running login also ends
  when cancelled; its message is "Cancelled. Nothing was changed."
  (canvas 62d), whichever kind.
- **Who started it:** the state carries the starting device's id and
  name ("Pixel 8", or this Mac). The canvas shows it on every other
  device ("Logging in from Pixel 8"), and only the starting device gets
  the code field (62h, *Another device is entering the code*).
- **Who waits on it:** the state lists the sessions on this profile's
  continuation list (§ 3) by id and title, so a notice can say
  "api-gateway waits on the same login" (62a).
- **Success is read, not parsed.** When the process exits, Orbital reads
  the status again (`auth status --json` or `design-login --json
  --status`). Logged in → `succeeded`; otherwise `failed` with the last
  meaningful line the CLI wrote, or the `done` message. `Login
  successful.` is not relied on.
- **Code:** `claude` writes the code and a newline to stdin; `design`
  writes `{"code":…}` and a newline. The step becomes `checking`.
- **A wrong code** ends the login: `auth login` exits at once (above).
  The canvas's phone reading holds everywhere (62e, 62h): the login
  fails with "That code is wrong or has expired. Open the sign-in page
  again for a new one." — Orbital's sentence, used when a login that
  was handed a code fails — and "Log in" starts a new one. The Mac's
  fallback does not keep the field open (62d differs; this wins).
- **Cancel:** `design` closes stdin (the CLI's own cancel) and kills the
  process if it has not exited shortly after; `claude` kills the
  process.
- **Time limit:** a `claude` login still running after
  `LOGIN_TIMEOUT_MS` is cancelled and fails with "The browser sign-in
  timed out. Try again." (the CLI's own wording for design). Design has
  its own five-minute limit.
- **Shutdown:** every running login is killed when the server stops.
- **Status cache:** each profile's account and design state is read on
  demand (Settings open, a notice shown, after every login) and kept
  until the next read; a read never blocks a route longer than the
  command takes, and a failed read is `unknown`, not `logged out`.

`auth login` opens the browser itself (above). The design-login's `url`
is opened by the web, the way the MCP login's URL is (`McpDialog`):
`window.open`, which Electron hands to the default browser. On another
device the web opens `manual_url` instead, for both kinds.

## 2. Routes and the WebSocket

Under the API token, like the rest of `/api`, and on the device group's
allowlist (`server/src/remote/allowlist.ts`) in the `manage` group, the
one that already holds the profile routes (§ 6).

| Route | Does |
|---|---|
| `GET /api/claude-dirs/:id/login` | The profile's account (`loggedIn`, `email`, `orgName`, `plan`), design state (`available`, `signedIn`) and any running login per kind. Reads the status when none is cached. |
| `POST /api/claude-dirs/:id/login` `{kind}` | Starts a login, or answers the running one. |
| `POST /api/claude-dirs/:id/login/code` `{kind, code}` | Hands the pasted code to the running login. 409 when none runs. |
| `DELETE /api/claude-dirs/:id/login/:kind` | Cancels the running login. |

Every state change is published on a new topic, `claude-dir-logins`,
with the profile id and the state, so the Settings row and every notice
of the profile follow without polling. No topic for the profiles list
exists today (the web reads `GET /api/claude-dirs`); after a login the
web reads it again. The topic joins `MEMBER_ALLOWED_TOPICS`
(`server/src/remote/servingHalf.ts`).

The four routes join the orbital MCP server's catalog
(`server/src/control/catalog.ts`), so a session can start a login for
the user and hand them the link.

## 3. The lost-login notice and continuation

### Recognising it

- **Live:** the runner already reads `msg.error` on main-loop assistant
  frames (`state.turnError`). A frame with `error ===
  "authentication_failed"` is published as a notice of kind
  `login_lost` instead of an assistant message, carrying the CLI's text
  and the session's profile id.
- **Reload:** the transcript parser turns the same entry — a synthetic
  assistant message with `error: "authentication_failed"` — into the
  same notice, so a reload and the live view agree and the notice
  survives a restart. The `error` field is read tolerantly; an entry
  without it stays the assistant text it is today.
- **Claude Design:** a `DesignSync` tool result that is an error and
  whose text names `/design-login` gets a `design_login_lost` notice
  after it. The tool result itself stays as it is.
- A terminal session shows the CLI's line as today, with one link
  beside it: "log in from Settings → Profiles ›" (62d, edge cases).
- A profile never logged in says so in the title, with the path and no
  e-mail; a login that came back as another account says "LOGGED IN AS
  <new>, NOT <old> · CONTINUED" and still continues (62d).
- The parser does not know who started a session or under which
  profile, and does not learn it: it always emits the notice, with the
  CLI's text. The web draws it as a notice only for a session Orbital
  started (`origin`), using the session's `claudeDirId`; for a terminal
  session it draws the CLI's text as today. (My call: the rule stays in
  one place and the parser's interface does not change.)
- An older Mac sends the plain assistant text; an older phone given the
  new notice kind falls back to its generic notice row with the text.

### What the notice offers

The notice asks the server for the profile's login state, and follows
the topic:

- logged out → "Log in", which starts the login (§ 1);
- a login running for that profile and kind → its waiting state, the
  manual link and the code field (folded), Cancel;
- logged in again → a quiet past-tense line naming the account;
- failed → the message and "Log in" again.

An older notice in a transcript, whose login has been restored since,
shows the past-tense line, not a button.

### The session on the map

A session stopped on a lost login is in the state it is already in when
a turn ends — NEEDS INPUT, amber, counted in the HUD — and what it waits
for is the label "log in · Work profile" (or "sign in · Claude Design")
on the map pill, "NEEDS LOGIN" / "NEEDS SIGN-IN" on the Desk card and
"NEEDS INPUT · LOG IN TO WORK PROFILE" in the detail header (62d, ADR
`what-a-session-waits-for-is-a-label`).

While its profile's login runs, the session rests the way a session
waiting on a usage limit does: hollow core, no badge, not counted in the
HUD, with "logging in · browser" or "logging in · Pixel 8" on the pill
(62a). A Claude Design sign-in during a running turn changes nothing on
the map: the session stays WORKING.

On the Desk card the notice is answered on the card itself, like a
question form (62b); the detail panel carries the same notice in every
theme.

### Continuing

The server keeps, in memory, the sessions whose **latest** main turn
ended on a lost login, per profile and kind. A send from the user, or a
new turn for any other reason, takes the session off the list.

When a login of the profile and kind succeeds, every session on its list
that has not ended gets the continuation text (the limits feature's
"Message sent on continue", `CONTINUE_TEXT_KEY`) through the same
delivery the limits use (`deliver`, which revives a session whose
process has gone), a notice "Logged in as <e-mail> · continued", and the
sent turn published, as `limits/service.ts` `fire` does.

- One login continues every session of that profile that stopped on it.
- Design: a session goes on the design list when its latest main turn
  contained a DesignSync failure naming `/design-login`, whatever came
  after it in the turn — the model usually answers "run /design-login"
  and ends the turn. (My call.) The runner tells the server at every
  main turn's end through a callback of its own, `onTurnEnd`; the limits'
  `onLimitHit` fires only on a rejected limit and is not reused.
- After a server restart the list is empty: the notice still logs in,
  and the user continues by writing. (Persisting the list is not worth a
  table: a login is restored in minutes, not hours.)
- A session also waiting on a usage limit is left to the limit.

## 4. Settings → Profiles

The `ClaudeDirsRows` block moves out of General into a **Profiles**
section of its own. Each row adds, beside what it shows today:

- the actions follow the canvas (62c): "Log in" while the profile has
  no login, "Switch account" when it has one — the same login flow,
  which replaces the login with whichever account signs in. There is no
  "Log in again": for the same account it would be the same flow;
- the account: e-mail · org · plan, or "Not logged in", or nothing when
  the status could not be read. This comes from `auth status`, which
  knows whether the login still works; the list's `account` (the
  e-mail in `.claude.json`) can still name an account whose login has
  lapsed. The row shows `auth status` when it has been read and
  `account` until then; the list is read again after every login, so
  `account` follows. (My call.)
- Claude Design: signed in or not, hidden when `available` is false;
- "Log in" / "Log in again" and "Sign in to Claude Design", with the
  same running state as the notice.

The status is read when the section opens. The section sits second in
the nav, after General (62c).

On another Mac, Profiles shows the profiles of the Mac it is looking at
(62g), with the code flow in place of the browser login and never
folded. Adding and removing profiles stays on the Mac that owns them:
the remote view has no Add profile and no Remove (the routes stay on the
allowlist; the view does not offer them).

## 5. The rename

User-visible labels only: "Claude directory" / "Claude directories"
become "profile" / "Profiles" in Settings, the New session dialog, the
composer's choice, its shortcut ("Next profile"), the session detail's
mark and its tooltip (`web/src/lib/claudeDirs.ts`), the phone's
picker (`web/src/mobile/screens/ClaudeDirPicker.tsx`), and the `manage`
grant's description in Settings → Devices
(`web/src/panels/DevicesSection.tsx`). Where the text
means the folder on disk ("your transcripts stay in the Claude
directory"), it stays.

Code, routes, the `claude_dirs` table and settings keys keep their
names: there they describe what the thing is.

## 6. Phone and other devices

Built for them too. The same transcript is drawn on the phone
(`SessionScreen` → `TranscriptView`) and on another Mac looking at this
Mac's sessions, so the notice reaches them anyway; it works there
through the manual path.

- "Log in" calls `POST /api/claude-dirs/:id/login` on the Mac that runs
  the session, through the channel. That Mac starts the login with
  `BROWSER` silenced (§ 1).
- The notice shows "Open sign-in page", which opens `manualUrl` on the
  device in hand (`window.open`; the Capacitor shell hands it to the
  system browser), and the code field — unfolded, since the code is the
  path here, not the fallback. The code travels through the channel,
  encrypted end to end like every other request body.
- Without the `manage` grant the routes are refused; the notice then
  has no "Log in" and says the login can be restored on that Mac, by
  its name.
- Settings → Profiles on a remote Mac shows the profiles of the Mac it
  is looking at, with the same rows (§ 4).
- The code field has its own Paste button (62e). The phone has no
  clipboard plugin, and adding one would be a store build, so Paste uses
  `navigator.clipboard.readText()` and is hidden where the WebView
  refuses it; the keyboard's own clipboard suggestion still pastes.
  (My call.) With the field focused, the transcript scrolls so Submit
  sits above the keyboard, and the composer hides.
- **Older Mac:** the phone updates first. The routes and the topic are
  gated in `MAC_FEATURES` (`web/src/mobile/version.ts`) at the first Mac
  release that serves them; against an older Mac the notice has no
  "Log in". The rename on the picker needs no gate.
- Security: logging a Mac in from a paired device is what the `manage`
  grant is for, and it is off by default. Orbital does not narrow it
  further.

## 7. Wire shapes

The contract between the server and the web; the names are the build's.

```ts
type LoginKind = 'claude' | 'design'

/** One login run, the running one or the last that ended, per profile and kind. */
interface LoginRun {
  kind: LoginKind
  claudeDirId: number
  state: 'running' | 'succeeded' | 'failed'
  /** `browser` while the browser path can still finish it; `code` once only a code can; `checking` after a code was handed over. */
  step: 'browser' | 'code' | 'checking'
  /** Started from another device: BROWSER silenced, only the code finishes it. */
  manualOnly: boolean
  /** Design only, local start only: the localhost-callback URL the web opens. */
  url: string | null
  /** The page that shows a code. */
  manualUrl: string | null
  manualFirst: boolean
  /** null deviceId = this Mac. `name` is what the canvas shows ("Pixel 8"). */
  startedBy: { deviceId: string | null; name: string }
  /** failed: the sentence to show. */
  message: string | null
  /** succeeded: the account now logged in. */
  account: string | null
  /** Sessions on the profile's continuation list for this kind (§ 3). */
  waiting: { sessionId: string; title: string }[]
  startedAt: string
  endedAt: string | null
}

/** GET /api/claude-dirs/:id/login, and every event on `claude-dir-logins`. */
interface ProfileLogin {
  claudeDirId: number
  /** The profile's name: another device knows no names of this Mac's profiles. */
  name: string | null
  /** read: false until a status read answered; then the rest is its answer. */
  account: { read: boolean; loggedIn: boolean; email: string | null; orgName: string | null; plan: string | null }
  design: { read: boolean; available: boolean; signedIn: boolean }
  runs: { claude: LoginRun | null; design: LoginRun | null }
  /** false when no Claude executable is known: Log in is disabled. */
  cliAvailable: boolean
}
```

- Topic `claude-dir-logins`, event `{ event: 'login', login: ProfileLogin }`
  on every change of either half.
- `ApiSession.loginWait: { kind: LoginKind; claudeDirId: number;
  running: boolean; startedBy: string | null } | null` — set while the
  session is on a continuation list; `running` while its profile's login
  of that kind runs (the map's hollow rest, § 3).
- Notices: `notice.kind` gains `'login_lost'` and `'login_restored'`.
  - `login_lost`: `notice.login = { kind, claudeDirId: number | null,
    email: string | null, neverLoggedIn: boolean }` and `text` the CLI's
    sentence. The parser does not know the profile (null); the web uses
    the session's `claudeDirId`.
  - `login_restored` (live only, like `limit_reset`): `notice.login =
    { kind, email, previousEmail: string | null, continued: boolean }`.
- Routes (§ 2) answer `ProfileLogin`; errors are `{ error }` with
  `not_found` (404), `no_cli` (503), `no_login` (409, a code or cancel
  with nothing running), `bad_kind` / `bad_code` (400).
- `MAC_FEATURES.profileLogin`: the desktop version this ships in.

## Tests

- Reading `auth login` output (the manual URL, the prompt without a
  newline) and `design-login` JSON lines, including unknown events and
  broken lines.
- Reading both status answers, tolerant of missing fields.
- The spawn environment: no `CLAUDE_CONFIG_DIR` for the default profile,
  no `CLAUDECODE`/`CLAUDE_CODE_*`.
- `LoginService` with a fake process: one login per profile and kind,
  code and cancel, success decided by the status read, the time limit.
- The routes: the token, 404 for an unknown profile, 409 for a code
  without a login, on the allowlist in the `manage` group only, and the
  topic for members.
- A login started by a member runs with `BROWSER` silenced and answers
  `manualOnly`; one started locally has no `BROWSER`.
- The parser: an `authentication_failed` entry becomes a `login_lost`
  notice; one without `error` does not.
- Continuation: a lost-login session on the list gets the text once
  after a success; one the user wrote to since, an ended one, and one
  of another profile do not.

## As built

Checked end to end on 2026-10-21 against a fresh profile on a throwaway
Mac server: a session failed on the lost login, the notice logged it in
from this Mac (browser path) and from a paired phone through the relay
(code path, `BROWSER` silenced), and the session continued by itself.

- **A login runs under a watchdog shell** (`LOGIN_WATCHDOG` in
  `server/src/login/service.ts`). `auth login` neither times out nor stops
  when its stdin closes, and the server is stopped by signals that run no
  `dispose` (the desktop quitting it, a restart): without the watchdog the
  CLI outlived the server and kept its localhost port. The shell ends the
  CLI when the server is gone, and a TERM to it (cancel, timeout) ends
  the CLI too.
- **The waiting sessions are republished when a login starts**, not only
  when it ends, so the map rests them at once (§ 3).
- **`ProfileLogin.name`** (§ 7): another device knows no names of the
  Mac's profiles, and the notice names the profile.
- **The CLI's "Please run /login"** is left out of the notice's sub line;
  the notice's own Log in answers it.
- **A lost login asks for the human in `shared/src/parked.ts`**
  (`loginLost` in `asksForHuman`), so a notification says Needs input
  where the map does.
- **Remote Macs** draw the code path at 32px rows (62e AIR-M3, 62g); the
  phone at 44px.
- **Status reads are cached** for `STATUS_FRESH_MS`: a `GET` within it
  reads nothing, and a read publishes on the topic only when the account
  or design state changed. Without it the phone, which re-read on every
  event, and the Mac, which published after every read, called each other
  for ever, two CLI processes a round.
- **A login a session starts** through the orbital MCP catalog runs as a
  remote one does: browser silenced, `manualOnly`, started by "a session".
  The session hands the user the sign-in page; nothing opens on its own.
  The routes know such a call by `CONTROL_HEADER`, a key made at every
  server start that only the in-process control path holds.
- **Continuing follows the auto-continue switch** (Scope); the
  `login_restored` notice goes out after the delivery and says
  "continued" only when a turn was sent.
- **A cancel or timeout that lost the race** to a login that had already
  saved its credentials ends as succeeded, when the fresh status shows the
  profile logged in where it was not (or under another account).
- The `removeChild` error on leaving NEEDS INPUT seen during the pass is
  older than this feature (fix `leaving-needs-input-throws-removechild`).

## Out of scope

- `auth logout`.
- `--console`, `--sso` and `--email` logins.
- A login started remotely that finishes through the localhost path.
- Adding or removing a profile from another device's Settings.
