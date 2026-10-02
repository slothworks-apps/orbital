---
id: run-the-desktop-app
title: Run the Orbital desktop app
type: runbook
status: in-force
domain: desktop
related:
  - 2026-09-16-electron-wrapper-design
  - trim-and-sign-the-desktop-package
  - desktop-app-is-developer-id-signed
tags:
  - desktop
  - electron
---
# Run the Orbital desktop app

The `desktop/` workspace is the Electron shell. It never starts `tsx` or
`vite` — it either attaches to a server that already answers on the port, or
forks the built server bundle itself.

## Attached mode (development, HMR)

```bash
npm run dev            # terminal 1: server on 4838 + vite on 4839
npm run dev:desktop    # terminal 2: builds desktop/dist, then `electron .`
```

The window loads `http://localhost:4839`. The probe finds the dev server and
attaches: no child is forked, and quitting the app leaves your `npm run dev`
running.

`localhost`, not `127.0.0.1`: vite's default host binds `::1` only, so the
literal IPv4 address is refused.

If nothing answers on the port, dev mode does **not** fork a server — it says
so in a dialog and quits. Start `npm run dev` first.

### Attaching without `ORBITAL_DESKTOP_DEV`

A packaged app — or `npx electron .` without the flag — attaches to a running
`npm run dev` just the same, and then it must not load the server's own origin:
a dev server gets no `ORBITAL_STATIC_DIR`, so its `/` is fastify's JSON 404.

`GET /api/health` carries `"static"` for exactly this, and the window follows
it: `true` → the server's origin, `false` → vite on 4839, and if vite is not
answering either, the app says so in a dialog and quits rather than opening a
window onto nothing.

## Forked mode (what the packaged app does)

```bash
npm run build -w server     # server/dist/index.mjs
npm run build -w web        # web/dist, served by the server itself
npm run build -w desktop    # desktop/dist/main.cjs + preload.cjs
cd desktop && npx electron .
```

The window loads the server's own origin, so the built frontend and the API
are same-origin and neither `api.ts` nor `ws.ts` needs a base URL.

The child is forked with `ORBITAL_RESOLVE_PATH=1`, `ORBITAL_STATIC_DIR` and
`ORBITAL_MIGRATIONS_DIR`. The last one is not optional: the bundle's default
migrations path is resolved relative to its source module, so it is wrong the
moment the server is bundled.

### Do not collide with your own dev server

`npx electron .` on the default port attaches to a running `npm run dev`
instead of forking, and its window then lands on vite — the map is real, but
the server it talks to is yours, not a forked one. To exercise the fork path,
give it a port and a scratch database:

```bash
cd desktop
ORBITAL_PORT=4791 \
  ORBITAL_DATA_DIR=$(mktemp -d) \
  ORBITAL_CLAUDE_DIR=$(mktemp -d) \
  npx electron .
```

## Package the DMG

```bash
npm run desktop:release        # from the repo root, always
```

The artifact lands in `desktop/release/` as `Orbital-<version>-arm64.dmg`,
beside its `.blockmap` and the unpacked `mac-arm64/Orbital.app`.

For a build you only run yourself, skip the notarization upload:

```bash
npm run desktop:build          # signed with Developer ID, not notarized
```

It signs with the same identity, so privacy grants and notification
permission survive it just as they survive a release. Only Gatekeeper on
another Mac would refuse it. It writes to `desktop/release/local/` as
`Orbital-<version>-arm64-local.dmg`, so it never replaces a release.

**Run it from the root, not from the workspace.** `npm run dist -w desktop`
builds only the desktop workspace and then packages whatever happens to be
sitting in `server/dist` and `web/dist` — stale output, or a build that fails
outright on `extraResources` when those directories do not exist yet. The root
script exists because it builds the server and the web app first.

### Signing and notarization: one-time setup

Packaging signs with the Developer ID of SlothWorks s.r.o. and notarizes (ADR
`desktop-app-is-developer-id-signed`). Two things must be in the login
keychain first.

1. **The Developer ID Application certificate.** In Xcode → Settings →
   Accounts, select the team *SlothWorks s.r.o.* → Manage Certificates → `+` →
   *Developer ID Application*. Only the account holder can create it. Check
   that it is there:

   ```bash
   security find-identity -v -p codesigning | grep "Developer ID Application: SlothWorks"
   ```

2. **The notary credentials,** stored under the profile name the `dist`
   script uses. Create an app-specific password at account.apple.com →
   Sign-In and Security → App-Specific Passwords, then run:

   ```bash
   xcrun notarytool store-credentials orbital-notary \
     --apple-id <your Apple ID> --team-id XTAS72W86T --password <app-specific password>
   ```

   To use a different profile, set `APPLE_KEYCHAIN_PROFILE` before
   `npm run desktop:release`.

Notarization uploads the app to Apple and waits for the result, which usually
takes a few minutes. Afterwards, check the app:

```bash
spctl -a -vv desktop/release/mac-arm64/Orbital.app   # source=Notarized Developer ID
```

### A self-signed identity for one Mac

Without the Developer ID certificate, a self-signed `Orbital Local` identity
keeps privacy grants and notification permission across rebuilds on the Mac
that holds it. Gatekeeper on any other Mac refuses the build. Newer macOS has
no Certificate Assistant in Keychain Access, so create it on the command line
once:

```bash
D=$(mktemp -d) && cd "$D"
printf '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Orbital Local\n[ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n' > cert.cnf
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 3650 -config cert.cnf
openssl pkcs12 -export -legacy -inkey key.pem -in cert.pem -name "Orbital Local" -out id.p12 -passout pass:tmp
security import id.p12 -k ~/Library/Keychains/login.keychain-db -P tmp -T /usr/bin/codesign
security add-trusted-cert -r trustRoot -p codeSign -k ~/Library/Keychains/login.keychain-db cert.pem   # asks for your password
rm key.pem id.p12
security find-identity -v -p codesigning   # "Orbital Local"
```

Homebrew's OpenSSL 3 needs `-legacy`, or `security import` cannot read the
`.p12`. Then build with:

```bash
npm run desktop:build:self     # from the repo root
```

It writes to `desktop/release/local/`, like `desktop:build`. Signing takes
several minutes, because each file in the bundle is signed separately.

**On a machine without the certificate,** the build fails in the `afterSign`
hook with *"is not signed as configured"*. It is not a skipped warning:
without the hook, electron-builder would ship an unsigned bundle whose
notifications macOS refuses. For a local ad-hoc build, override the identity
and skip notarization:

```bash
npm run build -w server && npm run build -w web && npm run build -w desktop
cd desktop && npx electron-builder --mac --arm64 -c.mac.identity=- -c.mac.notarize=false
```

An ad-hoc build loses every privacy grant on each rebuild. That is why it is
not the default.

### Releasing from GitHub Actions

`.github/workflows/release-mac.yml` does what `npm run desktop:release` does, on
a GitHub-hosted Mac, and attaches the DMG to a **draft** release tagged
`v<version>`. Start it by hand: Actions → Release macOS → Run workflow. It refuses
to run when a release for the current `version` in `desktop/package.json`
already exists, so bump the version first.

There is no keychain on the runner, so the credentials are repository
secrets (Settings → Secrets and variables → Actions):

| secret | what it holds |
|---|---|
| `MAC_CERT_P12_BASE64` | the Developer ID Application certificate with its private key, exported as `.p12` and base64-encoded |
| `MAC_CERT_PASSWORD` | the password chosen when exporting the `.p12` |
| `APPLE_API_KEY_P8` | the contents of an App Store Connect API key file (`AuthKey_….p8`) |
| `APPLE_API_KEY_ID` | that key's ID |
| `APPLE_API_ISSUER` | the issuer ID shown above the key list |

1. **Export the certificate.** In Keychain Access → login → My Certificates,
   right-click *Developer ID Application: SlothWorks s.r.o.* → Export → `.p12`,
   with a password. Then:

   ```bash
   base64 -i Certificates.p12 | pbcopy    # paste as MAC_CERT_P12_BASE64
   ```

   Delete the `.p12` file afterwards.

2. **Create the API key.** App Store Connect → Users and Access →
   Integrations → App Store Connect API → Team Keys → `+`, access
   *Developer*. The `.p8` downloads once only. Its ID is in the list, the
   issuer ID above it. Paste the file's whole contents as
   `APPLE_API_KEY_P8`.

   The API key is used rather than the Apple ID with an app-specific password
   the local setup uses: it belongs to the team, not to a person, and can be
   revoked on its own.

After the run, open the draft release, check the notes, and publish it.

### After a `node_modules` wipe: Electron's binary is missing

This machine's npm policy does not run install scripts it has not been told to
allow, and Electron downloads its own binary in a postinstall. After any
reinstall, `node_modules/electron/dist` is absent and packaging fails. Run the
postinstall by hand:

```bash
node node_modules/electron/install.js
```

The other skipped install scripts are harmless: `better-sqlite3` ships a
Node-API prebuild that is what gets packaged anyway, `electron-winstaller` is
never reached on a `--mac` build, and the esbuild copies that matter were
installed with the workspaces.

## First launch on another Mac

The DMG is signed with Developer ID and notarized, so it opens with a double
click. If Gatekeeper still refuses it, the build was not notarized. Check it
with `spctl -a -vv /Applications/Orbital.app`.

### Privacy prompts: Downloads, Documents, Apple Music…

They come from Claude sessions, not from Orbital. The CLI and the commands it
runs are Orbital's children, so macOS names Orbital in the prompt. The text
under the question says so. Allow what your sessions work with. Declining
Apple Music breaks nothing. With the Developer ID signature, each answer
survives updates. Only the first signed build asks again, because it is a new
identity to macOS. If the prompts return after every update, the build is
ad-hoc:

```bash
codesign -dvv /Applications/Orbital.app 2>&1 | grep -E 'Authority|TeamIdentifier'
```

It must show `Authority=Developer ID Application: SlothWorks s.r.o.` and
`TeamIdentifier=XTAS72W86T`.

Notifications also need permission once. macOS asks when the app shows its
first notification, not when it launches. Until then Orbital has no row under
**System Settings → Notifications**. If the prompt never comes and the row
never appears, check the signature:

```bash
codesign -dv /Applications/Orbital.app 2>&1 | grep -E 'Identifier|Info.plist'
```

It must say `Identifier=io.slothworks.orbital` with Info.plist bound.
`Identifier=Electron` / `Info.plist=not bound` means the bundle was not
signed, and macOS silently refuses its permission request. The `afterSign`
hook stops such a build, so an unsigned bundle means one packaged some other
way. Rebuild with `npm run desktop:release`. Re-signing the installed copy
ad-hoc also works, but it replaces the Developer ID signature and breaks
notarization.

**Smoke-test the packaged app from outside this repo.** Copy the `.app` to
`/Applications` or a temp directory first. Left inside `desktop/release/`, it
sits under the repo's own `node_modules`, which still holds the ~208 MB
`@anthropic-ai/claude-agent-sdk-darwin-arm64` package that packaging
deliberately excludes — a resolution that walked up to it would make a
packaging regression look like a success.

## Smoke test: notifications and click-through

Not unit-testable — it needs a human to see a banner and click it.

1. Open the app and move focus elsewhere (another window, or Finder). A focused
   window suppresses notifications by design.
2. Drive one session from `working` to `needs_input`. Easiest is to spawn a
   session from the map and let its turn end; a terminal session hitting a
   permission prompt does the same.
3. **Exactly one** macOS notification appears, bodied *"Needs your input"* and
   titled with the session's name.
4. Click it. The window raises **and** that session is selected: the detail
   panel opens and `?session=<id>` appears in the URL.
5. Let the same session emit the same status again. **No second notification** —
   a repeat of a state already seen is not news.

## What notifies, and what does not

Decided against the statuses the registry actually produces, and implemented in
`desktop/src/lib/notifications.ts` as a fold over transitions, never over
states.

Notifies:

| transition | notification |
|---|---|
| `working → needs_input` | "Needs your input" |
| `working → ended` | "Session ended" |
| `session_failed` on the `errors` topic | "Session failed: …" |

A turn ending, a permission prompt and an `AskUserQuestion` all arrive as the
same `working → needs_input` transition, so all three notify and none can be
distinguished from the others. Terminal sessions are included: the CLI's
`waiting` state maps to `needs_input`, so their turn ends notify too.

Silent by design:

- **The first sighting of a session**, whatever its status. The server replays
  nothing on subscribe, but a registry rescan re-emits every live session, so a
  rule keyed on a state rather than a transition would fire on every reconnect.
- **A repeat of a status already seen.**
- **`idle → ended`** — that is the ageing timer, not a session finishing.
- **Any transition out of `idle`**, including `idle → needs_input`.
- **`remove`**, which is how terminal sessions leave.

## Checks

- `curl -s http://127.0.0.1:<port>/api/health` → `{"app":"orbital",…}`. Its
  `"static"` says whether that server has a web app of its own: `true` for a
  forked or packaged server, `false` for `npm run dev`.
- `lsof -nP -i :<port> -sTCP:LISTEN` after quitting: empty if the app forked
  the server, still listening if it attached to yours.

## When something goes wrong

| symptom | cause |
|---|---|
| "Orbital’s server did not start" | `server/dist/index.mjs` missing or stale — run `npm run build -w server`. The server's own output goes to the terminal that launched Electron. |
| `Can't find meta/_journal.json` in that output | the fork lost `ORBITAL_MIGRATIONS_DIR`. |
| "Port … is taken" | something that is not Orbital answers there. Stop it or set `ORBITAL_PORT`. |
| A blank window in forked mode | `web/dist` is missing — run `npm run build -w web`. |
| `{"message":"Route GET:/ not found"}` in the window | you are on a build from before the `"static"` flag. It attached to a dev server and loaded its origin anyway. Rebuild: the window now goes to vite instead. |
| "Orbital has no map to show" | attached to a dev server that serves no web app, with no vite on 4839 either. Start `npm run dev` and relaunch, or stop it so Orbital forks its own server. |
| "The Claude Code CLI was not found" | expected when no CLI is on the resolved PATH. Pick the executable; the app PATCHes `claude_executable_path` and restarts the server, because that setting is read once at boot. |
| `npm run desktop:release` fails on a missing Electron binary | `node_modules/electron/dist` was never downloaded — run `node node_modules/electron/install.js`. |
| No notification ever appears | the window was focused (suppression is correct), or Orbital is not permitted in System Settings → Notifications. |
| A notification for something you did not expect to be news | check the transition, not the status — the rules are the table above. |
