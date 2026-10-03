---
id: 2026-10-03-api-token-and-named-files-design
title: A token guards the local API, and the viewer opens files the session named
type: spec
status: draft
domain: server
related:
  - api-token-guards-the-local-port
  - 2026-09-19-file-viewer-design
  - clickable-file-paths-in-the-transcript
  - 2026-09-30-mobile-remote-design
tags:
  - security
  - file-viewer
---
# A token guards the local API, and the viewer opens files the session named

## Why

The file viewer (`/api/files`, `/api/files/image`) reads only inside the
session's cwd. Agents routinely write outside it, and screenshots in `/tmp/`
are the everyday case. The transcript turns that path into a link, the user
clicks it, and the viewer refuses with `OUTSIDE SESSION FOLDER`.

The sandbox is strict because the port has no authentication. The user's
everyday browser is also on localhost, and any page open in it can send
requests to `127.0.0.1:4737` (idea `api-token-guards-the-local-port`). The
sandbox should not get wider until the port stops answering strangers, so
this spec covers two things that ship together:

1. **A token** that every request to `/api` and `/ws` must carry.
2. **Named files.** The viewer also opens a file outside the cwd when the
   session's own transcript names that file.

The token protects every route. The second rule limits what a leaked
token could read. Neither replaces the other.

## Threat model

The threat is JavaScript in a browser page that is not Orbital: an ad, a
compromised site, or a page served by some other local dev server. Processes
running as the user are outside the model. They can already read `~/.claude`
and everything else Orbital can.

That is why the token may sit in a file in the data dir. It keeps out
browser pages, not other processes on the machine.

## 1. The token

### Minting and storage

- On startup the server reads `<dataDir>/api-token`. If the file is missing,
  the server writes 32 random bytes (base64url) to it with mode `0600`.
- The token **persists across restarts**. `tsx watch` restarts the dev
  server on every save, and a token minted per start would log the browser
  out each time. To rotate it, delete the file.
- Tests and `buildServer` overrides can pass a token in. Without one, the
  test suite keeps today's behaviour; see Rollout.

### How a request carries it

There are two carriers, and the server accepts either one:

- **Cookie** `orbital_token`, with `HttpOnly; SameSite=Strict; Path=/`.
  This is how the web app carries it. `<img src>`, session window URLs, the
  WS handshake and every `fetch` in `web/src` send it without any change to
  them. A plain header would mean touching every call site, and an image URL
  cannot carry a header at all.
- **`Authorization: Bearer <token>`** for non-browser clients: the desktop
  main process (`/api/settings`, `/ws`, the health probe) and the mobile
  relay's in-process `inject`.

The comparison uses `timingSafeEqual`.

### Getting the cookie: `GET /api/auth?token=…`

If the token matches, this route sets the cookie and redirects (`302`) to
`/`, or to `next` when `next` is a same-origin path. If it does not match,
it answers `401`. The route lives under `/api` so that vite's dev proxy
forwards it. The cookie is then set for the host the user is actually on,
whether that is `localhost:4839` in dev or `127.0.0.1:4737` packaged.

- **Desktop, fork and attach alike:** the main process reads
  `<dataDir>/api-token` and opens each window through `/api/auth?token=…&next=<target>`.
  Attaching to `npm run dev` needs nothing extra, because both read the same
  file.
- **Browser mode:** `npm run dev` prints the link with the token. The first
  visit sets the cookie. After that, plain `http://localhost:4839` works
  until the token rotates.

### What stays open

- Static assets and `index.html`. They are the public bundle and carry no data.
- `GET /api/health` answers only `{ app, static }` without a token. The
  probe needs this to tell Orbital from another service on the port.
  `billing`, `paths` and `claudeCli` appear only on an authenticated call.
  The desktop probe sends the bearer, so the missing-CLI dialog keeps
  working.
- `GET /api/auth`.

Everything else under `/api` and `/ws` answers `401 { error: 'unauthorized' }`.

### Origin on REST, not just WS

`SameSite=Strict` stops a page on a different site, but cookies are not
isolated by port. A page served by another local server on `127.0.0.1:3000`
counts as same-site, so its `fetch` would carry the cookie. Reading the
response is still blocked, but side effects like spawning a session or
sending a message would go through. To close that hole,
`isAllowedWsOrigin` becomes the REST rule too: a request whose `Origin`
header is present and not one of ours gets `403`. A request without
`Origin` (CLI, desktop main, tests) passes, as it does for WS today.

### The client without a token

When `/api` answers `401`, the web app does not fail into an error boundary.
It shows one quiet screen: "Open Orbital from the link the server printed."
The desktop never shows it, because it always enters through `/api/auth`. The
look of the screen is up to Claude Design; this spec only requires that it exists.

### The mobile relay

A phone's REST call enters through `app.inject` (`remoteInjectOptions`).
That function adds the bearer. The relay's own allowlist
(`server/src/remote/allowlist.ts`) does not change.

## 2. Files the session named

### The rule

`/api/files` and `/api/files/image` read a path when **either** of these holds:

1. it is inside the cwd (`resolveInsideCwd`, unchanged), **or**
2. it is **absolute** (after `~` expansion), and the client's exact spelling
   of it appears in the session's transcript: the main JSONL or any of its
   subagent transcripts.

Only absolute paths qualify for the second rule. A relative path resolves
against the cwd as it does today, so `../../etc/passwd` stays `outside`.

`@` completion (`/api/files/complete`) keeps the cwd only. It lists a
directory, and a directory listing outside the project has no name in the
transcript to justify it.

### Spelling decides the check, realpath decides the read

The check uses the path as the transcript and the client spell it. The read
uses the realpath. This matters on macOS, where `/tmp` is a symlink to
`/private/tmp`: the agent writes `/tmp/shot.png`, the transcript says
`/tmp/shot.png`, and the client sends `/tmp/shot.png`. The match succeeds on
the spelling, and the server reads `/private/tmp/shot.png`.

As a consequence, a named symlink is followed wherever it leads. That is
acceptable: the agent that named it can read the target itself and print it
into the transcript.

### The search

- The search is a byte search (`Buffer.indexOf`) of the files, with no
  parsing. It looks for two forms: the path as written, and its JSON string
  form (`JSON.stringify(path).slice(1, -1)`), because JSONL escapes `"`,
  `\` and non-ASCII characters in some writers.
- A path whose characters match inside a longer one is a false positive:
  `/tmp/a` would match inside `/tmp/ab`. It is cut off by requiring that
  the character after the match is not a path character (`[A-Za-z0-9._-]`)
  and the one before it is not one either.
- The result is memoized per `(session, path)` and keyed by the stamp of the
  transcript files (size + mtime), the same way `spineFor` keys its spines.
  A transcript that grows invalidates only a negative answer. A positive
  one stays true, because a transcript only ever grows.

This is a pure function (`namedInTranscript(paths, rawPath)`) next to
`resolveInsideCwd` in `server/src/files/preview.ts`. A new
`resolveForSession(row, rawPath)` composes the two, and both routes call it
instead of `resolveInsideCwd`.

### Refusals

- `outside` stays the answer when neither rule holds, so the `403
  outside_cwd` shape does not change.
- The viewer's refusal copy changes from "Orbital only reads inside <cwd>."
  to "Orbital reads inside <cwd> and files this session named." The label
  `OUTSIDE SESSION FOLDER` stays.

### Terminal sessions

The rule works for them unchanged, since they have a JSONL like Orbital
sessions do. Nothing here needs to be Orbital-only.

## The phone

- **The token reaches the phone only through `inject`.** The phone does not
  use the port. It is paired by its own keys and enters in-process through
  `remoteInjectOptions`, which adds the bearer. Nothing on the phone changes.
  A test pins that an allowlisted call still answers `200` once the guard is
  on.
- **The phone still cannot open files; this change leaves it out on
  purpose.** The relay refuses `/api/files` and `/api/files/image` (spec
  `2026-09-30-mobile-remote-design` § 3), so a path pressed on the phone
  opens nothing, whether it is inside the cwd or not. Allowing it takes
  more than an allowlist entry. The allowlist checks only the path's
  segments, not a `path=` query, and `inject` returns the body as text,
  which would mangle an image. Images would have to travel in the binary
  frames the relay uses for transcript images. That is its own piece of
  work, and it touches the relay's security boundary. Idea
  `phone-opens-files-the-session-named` records it, and the named-files
  rule above is what makes it defensible.

## Rollout

- The token lands behind no switch. A switch would be a way to turn the
  security off, and nobody needs one.
- `buildServer` in tests without a token runs without the guard, so the
  existing route tests do not all need a cookie. A separate test file
  exercises the guard with a token passed in.
- Rule 2 is built in the same change as the token, never before it.

## Tests

These are worth writing, because each one can break for a reason other
than someone changing a value:

- the guard: no token → 401; a wrong token → 401; a correct cookie → 200; a
  correct bearer → 200; an open `health` without `paths`; `/api/auth` →
  cookie + 302; a foreign `next` → redirect to `/`; a foreign `Origin` on
  REST → 403
- `namedInTranscript`: a match; a match only in a subagent transcript; the
  JSON-escaped form; `/tmp/a` vs `/tmp/ab`; a relative path never qualifies
- `resolveForSession`: `/tmp/x` named → ok with the realpath; not named →
  outside; a named path that does not exist → not_found
- the token file: created with `0600`; a second start reads the same token
- `remoteInjectOptions` carries the bearer

## Out of scope

- A Unix socket or Electron IPC instead of the port (the end state the idea
  describes). The token is the step that keeps browser mode working.
- Writes outside the cwd. The viewer only reads.
- Choosing a file outside the cwd by hand, e.g. a "browse" dialog.
