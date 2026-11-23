---
id: 2026-11-18-generated-views-design
title: Generated views — small HTML pages an Orbital session writes and shows in its transcript
type: spec
status: active
domain: sessions
related:
  - 2026-11-09-progress-list-design
  - 2026-10-13-session-media-more-design
  - 2026-11-05-browser-bridge-design
  - 2026-10-29-colour-tokens-design
  - why-orbital
tags:
  - views
  - labs
  - mobile
---
# Generated views

When a user wants to see data, a chart in the transcript says more than a
table of numbers or a path to a PNG. Claude can already write a small HTML
page for that, but the user has to open it somewhere else, it does not look
like Orbital, and nothing the user does in it reaches the session.

A **view** is a small HTML/JS page an Orbital session writes for one
purpose, hands its data, and shows in the transcript. It is drawn in the
current Orbital colour theme, can be maximised, is listed in the session's
media, and can send what the user does in it back to the session.

## Scope

- **Who it is for:** anyone who asks a session to show data: a chart, a
  table to filter, a small picker or form that is quicker to use than to
  describe.
- **Where it lives:** Labs. Its reception is not known yet.
- **What someone already using Orbital notices after updating:** nothing
  until they turn the Labs feature on. After that, Orbital sessions have the
  `show_view` tool and use it when a view helps.
- **What can be set:** the Labs switch, and extra CDN hosts allowed beside
  the built-in ones (Settings → Labs → Views, shown while Views is on). Domains a view may
  fetch from are approved per session, by a click on the view.

The design is "Feature - Views" in the Claude Design artifact, artboards
69a–69f.

## Behaviour

### The tool

Only Orbital sessions get it, as a tool on the Orbital MCP server, and only
while the Labs feature is on. A terminal session cannot be given an MCP
tool, so it has no views (by design, as with the harness and the progress
list). With Labs off, views already in a transcript show as an ordinary
tool row.

`show_view` takes:

| field | meaning |
|---|---|
| `title` | one line, shown on the view and in media |
| `component` | the view as a React component in TSX; the usual way |
| `html` | instead of `component`: a plain page, any HTML, CSS and JS |
| `data` | optional JSON, inline, for small data |
| `dataFile` | optional path to a JSON or CSV file, for large data |
| `height` | optional height in px; Orbital clamps it (see In the transcript) |
| `liveDomains` | optional list of https domains the page may `fetch` from |
| `wait` | optional; the tool returns only after the user acts in the view |
| `replaces` | optional id of an earlier view of this session to update |

The result carries the view's id, and with `wait`, what the user sent.

The tool's description tells the agent the theme's variable names, the
`orbital` bridge inside the page (below), which CDNs scripts may load from,
that data for the page should be passed, not fetched, unless it must be
live, and that while it iterates on a view it updates that view with
`replaces`, and makes a new one only when the user asks for one.

### React and Tailwind

The usual view is a React component, because that is what the agent writes
best and Tailwind gives it Orbital's own vocabulary:

- `component` is a TSX module whose default export is the view; it gets the
  data as its `data` prop. The Mac compiles it (JSX and types out, imports
  kept) when the call is made, so a syntax error comes back to the agent as
  a refusal, and no client needs a compiler.
- React and the Tailwind runtime ship with Orbital and are put into the
  page, so a view without imports works offline. Tailwind's theme maps
  Orbital's tokens, so `bg-panel`, `text-ink-300` or `border-line` mean in
  a view what they mean in Orbital.
- Any other import (`import { LineChart } from 'recharts'`) resolves
  through an import map to esm.sh, built against the page's own React.
  No library is bundled for it.
- `html` stays for what needs no React: a plain SVG, a canvas.

### Data

- Small data goes inline in `data`. Everything the agent writes into the
  call is output tokens, so large data goes through `dataFile`: the agent
  writes it to disk with a script and passes the path.
- Orbital copies a `dataFile` into its data directory when the call is
  made, so the view survives a restart and the original file being deleted
  or changed. The view always shows the copy.
- The page reads the data through the bridge (`orbital.data`), not over
  the network.

### Choices made while planning

- `dataFile` must lie in the session's directory (where it started or is
  now) or the temp directory. The tool asks no permission, so it may not
  read what a Read outside the project would have to ask for.
- The page's CSP allows `'unsafe-eval'`: the frame is isolated, and some
  chart libraries need it.
- `liveDomains` take https hosts only: no localhost, IP address or local
  name.
- A subagent cannot show a view; a waiting one could never be answered.
- A waiting view has its own slot. A question or a permission asked while
  it waits goes in front of it and does not cancel it; once answered, the
  view is what the session waits on again.
- `orbital.send` and links count only when the frame holds the focus and
  the window has a user gesture: a click elsewhere in Orbital does not let
  a page send.
- A view without `wait` cannot send while the session waits on another
  answer (a question, a permission): its message would answer that instead.
- Allowed domains do not carry over when a session is cleared.
- The waiting call's decision id is its tool_use id, which the CLI passes
  to the tool as `_meta["claudecode/toolUseId"]`; a PreToolUse hook that
  notes each call's id is the fallback.
- The Orbital MCP server's own call timeout is set to the CLI's cap in a
  session given `show_view`, so a user's `MCP_TOOL_TIMEOUT` cannot cancel
  a view waiting on them; their other MCP servers, and sessions without
  Views, keep it.
- A view's payload fits one relay frame: a page too large for it is refused
  when the call is made, and data that does not fit travels on its own.
- A page that navigates its own frame away is stopped by the desktop's
  shell before the request leaves; the phone's WebView has no such guard,
  so there the request goes out (and can carry data in its URL) before
  Orbital sees the frame's second load, blanks it and shows the view as
  failed. Accepted as a residual risk on the phone.

### Isolation and network

- The page runs in an `<iframe sandbox="allow-scripts">` without
  `allow-same-origin`: an opaque origin with no access to Orbital's API,
  its token, its storage or the parent page.
- A CSP in the page allows scripts and styles from a fixed list of CDNs
  (cdnjs, jsDelivr, unpkg, esm.sh) plus the hosts the user added in Settings.
  `connect-src` allows only `data:` and `blob:`: a page can load what it
  already holds, such as a 3D model passed in its data for a three.js
  loader, never the network.
- With `liveDomains`, the view first shows the domains in place of its
  content, at its height, with Allow and Don't load. Nothing loads before
  Allow. Don't load leaves the frame with "Not loaded · allow". The
  approval holds for those domains in that session, wherever it was given:
  it is stored on the Mac, so allowing on the phone counts on the Mac too.
  A later view asking only for allowed domains loads at once; a new domain
  asks again. The CSP then lets `connect-src` reach exactly them. The
  allowed domains stay in the view's header.
- Navigation and new windows from the page are blocked; a link opens in
  the user's browser, as links elsewhere in Orbital do.

### CDN hosts

Settings → Labs → Views, under the Views switch and shown only while it is
on (69f). cdnjs, jsDelivr, unpkg and esm.sh are listed first, locked, with no
Remove. The user adds a host only (no scheme, no path; a bad entry says what
to type instead) and removes it without a confirm. There is one list for
the Mac's sessions: it is stored on the Mac, and the phone edits the same
list. Turning Views off keeps the list.

### Theme

The page gets every `--color-*` token, `--font-sans`, `--font-mono` and the
text scale as CSS variables, plus a base stylesheet that styles the
background, text, links, tables, buttons and inputs, so a plain page
already looks like Orbital. When the colour theme changes, the bridge
pushes the new values and the view recolours without reloading.

### The bridge

The page talks to Orbital only through `postMessage`, wrapped in a small
`orbital` object injected into the page:

- `orbital.data` — the data passed to the view;
- `orbital.onTheme(fn)` — theme changes;
- `orbital.send(value)` — sends a JSON value back. Only within a user
  gesture (a click, a submit); a call outside one is dropped, so a page
  cannot flood the session.

What `send` does depends on `wait`:

- **With `wait`:** the first `send` becomes the tool's result and the view
  turns read-only. While it waits, the session is in the same state as for
  `AskUserQuestion`: it waits on the user, the map shows it, and the same
  notification fires. A message typed in the composer meanwhile answers the
  view, as it answers a question: it becomes the tool's result. Once sent,
  the view keeps what was selected, takes no input, and says what was sent.
- **Without `wait`:** each `send` becomes a message to the session, shown
  in the transcript as the user's message, with a line "from <title> ↑"
  that jumps back to the view. A message sent while the session works is
  queued like a typed one.

### Updating a view

A view is one thing, not a series of versions. With `replaces`, the agent
updates it: the view moves to the end of the transcript, drawn from the
newest call, and its old place becomes one line, "<title> · updated
below", that jumps to it. The earlier content is not shown again and the
view carries no version mark. A waiting view cannot be updated.

### In the transcript

- The view is live inline, at the height the session asked for, clamped to
  120–480 px (420 on the phone). Taller content scrolls inside the view and
  its footer says how much there is; the wheel scrolls the transcript until
  the user clicks into the view, so a tall view cannot trap scrolling.
- When it scrolls out of sight it is unloaded and loads again when it comes
  back, at the same height, so the transcript never jumps. Its own state
  (filters, scroll) is not kept. A waiting view is never unloaded.
- A button maximises it.

### When a view fails

A CDN script that does not load, or a page that throws, shows in place:
what happened, the first line of the error, Reload, and Send the error to
the session, which sends it as the user's message so the agent can fix the
view. The session is not told on its own, and Orbital's own error log does
not record it: the page failed, not Orbital.

### Media

A view is a media item of the session, with a new source, **View**, and its
own row in the Sources filter. Its tile shows the title and an icon, not a
live page. An updated view is one item, showing its newest content. Opening
it shows the live, interactive view in the maximised media viewer, with the
others before and after it; `send` and a waiting view work there too.

## Phone

Built for the phone too. The phone renders the same transcript components
and the same media viewer.

- The view's page, data copy and approvals come from the Mac through a new
  route, added to `server/src/remote/allowlist.ts`.
- The CDN host list is read and edited through the Mac, so it needs its
  routes on the allowlist too.
- `send` uses the routes the phone already uses to answer a question and to
  send a message.
- **A phone ahead of its Mac:** an older Mac has no tool, so no views exist
  to show; the phone's rendering needs no `MAC_FEATURES` gate, the data
  route does.
- **A Mac ahead of its phone:** a shipped phone would read a view media item
  as an image and show a broken tile. The Mac lists view items only to a
  client that says it understands them.

## Design

"Feature - Views", artboards 69a–69f.

## Not in this feature

- Views in terminal sessions.
- A preview image of a view in its media tile.
- Keeping a view's own state across reloads.
- Versions of a view: an update replaces it.
