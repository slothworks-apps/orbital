---
id: 2026-11-05-browser-bridge-design
title: The browser bridge
status: draft
type: spec
domain: sessions
related:
  - orbital-ships-its-own-browser-extension
  - 2026-09-23-ide-bridge-design
  - an-ide-selection-rides-as-a-quoted-block
  - orbital-speaks-to-the-ide-itself
  - attachments-upload-without-a-session
  - api-token-guards-the-local-port
  - labs-features-move-to-regular-settings
tags:
  - browser
  - composer
  - mcp
---
# The browser bridge

You are reading a technical specification in ClickUp, in the browser you
work in, and you want the session open in Orbital to look at a paragraph.
Today that means copying it, switching to Orbital, pasting it and saying
where it came from. The browser bridge is a small extension for
Chromium-based browsers that does this for you: what you select, and a
screenshot you take, lands in the composer of the session you have open in
Orbital, and the agent can take a screenshot of the browser itself when it
needs to see the page.

Why Orbital builds its own extension instead of using Claude in Chrome is
[[orbital-ships-its-own-browser-extension]]. This document is what gets
built.

## Intent

- **Stay in the browser you are already in.** No second browser, no
  Playwright window, no debugging port. The extension runs in Chrome, Arc,
  Dia, Vivaldi or any other Chromium browser, with your logins and tabs.
- **You decide what the agent sees.** The agent does not watch the browser.
  It gets what you send it, plus a screenshot when it asks for one and the
  session's permission mode lets it.
- **Nothing leaks into a session it does not concern.** A selection or a
  screenshot goes to the one session open at that moment and nowhere else.

## Goals (first version)

1. A selection in the browser is an **event**. The moment it happens, it is
   delivered to the session open in Orbital and shows above that session's
   composer, the way an editor selection does today.
2. A **screenshot** taken from the extension (its button or a keyboard
   shortcut) is an event of the same kind and lands in the same composer as
   an attachment.
3. Both ride along with the **next message** sent in that session, and each
   can be dropped with its × before sending.
4. The agent has a **`browser_screenshot`** tool that captures the browser's
   active tab and returns it as an image.

## Non-goals (first version)

- Rewriting the selected text in the page. Wanted next, ClickUp first (see
  Later).
- Filling inputs, clicking, navigating, reading the whole page.
- The phone. See The phone.
- Firefox and Safari.
- Publishing to the Chrome Web Store.

## Anti-goals

- **The agent watching the browser.** No stream of page content, no
  selection kept up to date in the background, no tool that reads the
  selection on its own.
- **An event reaching a session that was not open when it happened.**
  Opening another session afterwards shows it nothing.
- **A second browser to drive.** If the answer to a problem is "open
  Playwright", it is not this feature.
- **Anything for the extension leaking past the local Mac.** No relay, no
  Anthropic sign-in, no network beyond `127.0.0.1`.

## Scope

- **Who it is for:** anyone who reads specs, tickets, docs or dashboards in
  a browser while a session works on them — which is most of the people
  Orbital is for. It matters most where Claude in Chrome cannot be used:
  an organisation that blocks it, or an API-key setup it does not support.
- **Where it lives:** a **Labs** switch, *Browser bridge*, off by default.
  Labs is empty since [[labs-features-move-to-regular-settings]]; this is a
  feature whose reception is not known yet, which is what Labs is for, and
  it lists itself again while it holds this key.
- **What someone already using Orbital notices after updating:** nothing.
  With the switch off there is no tool, no endpoint accepting the extension
  and no UI.
- **What can be set:** the switch; pairing and unpairing the extension. The
  extension's keyboard shortcut is set in the browser's own shortcuts page.

## The phone

Left out on purpose. The bridge is about the browser on the Mac next to
Orbital; the phone has no such browser beside it. The browser endpoint and
the `browser` topic are not on `server/src/remote/allowlist.ts`, and the
phone's web code ignores browser events. Nothing is worth an `idea`: the
phone's own browser is a different feature, and nobody has asked for it.

## How it fits together

```
browser tab ── content script ──► extension service worker
                                        │  WebSocket, browser token
                                        ▼
                     Orbital server  /ws/browser   (127.0.0.1 only)
                                        │  hub topic `browser`
                                        ▼
                     Orbital window that was focused last
                     → its open session's composer
```

- **Extension**, Manifest V3, in a new workspace `browser-extension/`.
  - A content script on every page listens for the end of a selection
    (mouse up or key up after `selectionchange`, debounced) and sends
    `{text, url, title}` to the service worker when the text is not empty.
  - The service worker holds one WebSocket to Orbital, sends events, and
    answers screenshot requests with `chrome.tabs.captureVisibleTab`.
  - A popup holds pairing state, a *Screenshot* button and the connection
    status. `chrome.commands` gives the screenshot a keyboard shortcut.
  - Permissions: `<all_urls>` host access (a screenshot the agent asks for
    has no user gesture, so `activeTab` is not enough), `tabs`, `storage`.
- **Server**, new module `server/src/browser/`.
  - `/ws/browser`: the only endpoint the extension uses. It accepts the
    extension's `chrome-extension://<id>` origin, and that origin only
    there; every other route keeps today's Origin rule. It takes the
    **browser token**, not the API token (Pairing).
  - It publishes each incoming event on a hub topic `browser`, and keeps
    no record of it: not in SQLite, not on the session row.
  - It serves `browser_screenshot` by asking a connected extension.
- **Web** subscribes to `browser` and turns events into composer state.

### The extension's identity

An unpacked extension's ID derives from its folder unless the manifest
carries a `key`. The manifest carries a fixed `key`, so the ID — and the
`chrome-extension://` origin the server accepts — is the same on every Mac
and every install.

## Which session gets an event

The server does not know which session is open; the web does
(`ui.selectedId`, mirrored into the URL). So delivery is decided in the web:

- Every Orbital window receives every `browser` event.
- Only **the Orbital window that was focused last** acts on it. While you
  are in the browser no Orbital window has focus, so "focused last" is the
  one to use; the windows share it through `localStorage` (a timestamp each
  window writes on focus), which every window of the same origin sees.
- That window delivers the event to **its open session** at that moment —
  the selected session in the main window, or the session of a detached
  window.
- If that window has no session open (the map with nothing selected,
  Settings), **the event is dropped.** It is not held for the next session
  you open.
- If the open session runs on another Mac of a group (`ctx.foreign`), the
  event is dropped too: nothing from the extension leaves this Mac.
  *(Builder's call, from "only the local Orbital".)*
- **The extension hears the outcome.** The window that acted on an event
  answers through the server — delivered to *session title*, or dropped and
  why (no session open, no Orbital window, a session on another Mac, a full
  composer). The extension shows it as a short badge on its icon; nothing
  waits for the answer, and no answer within a few seconds reads as "no
  Orbital window". *(Builder's call.)*

Per-session composer state lives in the web store, not on the server: a
reload of the window loses an unsent browser selection or screenshot, as it
loses an unsent draft. This is the ruling of
[[orbital-speaks-to-the-ide-itself]] applied again — what the browser shows
is live state, never a record of the session.

## A selection in the composer

- It shows as a lip above the composer, reusing the IDE slot
  (`web/src/panels/IdeSlot.tsx`): the page title and the start of the text,
  with a ×. When the session also has an editor read-out, the browser lip
  **stacks** above it as a second entry rather than replacing it, and the
  completion popup's gap counts both. *(Builder's call.)*
- A newer selection **replaces** the older one in the same session.
  Deselecting in the browser does **not** remove it — the event already
  happened; the × or sending does.
- On send it is written into the prompt as a quoted block, following
  [[an-ide-selection-rides-as-a-quoted-block]] — the block first, the typed
  words after, the fence longer than any backtick run inside, the same
  `IDE_SELECTION_MAX_CHARS` cap and truncation marker:

  ````
  Selected in the browser — Technical spec: Billing v2 (https://app.clickup.com/t/…):

  ```
  …selected text…
  ```

  is this consistent with section 3?
  ````

  `parseSentSelection` learns this form too, so the transcript draws the
  same caption for it. The wording is a parsing contract, like the
  editor's.
- After sending, the selection is gone from the composer.
- If the session also has an editor selection, both ride along, the editor
  block first. They come from different places and the user dropped
  neither.

## A screenshot from the extension

- The extension captures the visible part of the active tab as PNG and
  sends it over the WebSocket, with the page's URL and title.
- The server stores it through the same store as a composer upload
  (`storeAttachment` → `server/src/images/store.ts`) and publishes the
  stored ref on `browser`, so the web never handles the bytes.
- The web adds it to the open session's composer as an attachment chip,
  counting toward `MAX_ATTACHMENTS`. If the composer is full, the event is
  dropped and the extension's popup says why.
- It is sent like any other attachment, and removed with the chip's ×.

## `browser_screenshot`, the agent's tool

- A tool in Orbital's MCP server (`server/src/runner/spawnTool.ts`),
  present only while the Labs switch is on. It takes no arguments.
- It captures **the active tab of the browser window used last**, through
  the extension, and returns an MCP image content block plus a line of text
  with the page's URL and title.
- **Approval follows the session's permission mode**, like every other
  Orbital tool: it is not in `allowedTools`, so it goes through
  `canUseTool` — a decision card in the normal modes, no card in bypass.
  Orbital has no "always allow" today; this tool does not add one.
- With no extension connected, or a tab the browser does not let
  extensions capture (`chrome://` pages, the Web Store), it returns a text
  result saying so, not an error that ends the turn.
- With several browsers connected (Arc and Chrome, say), the one that sent
  the most recent event or connected most recently answers.

## Pairing

The API token stays where it is: an extension in a browser is a weaker
place to keep it than the Mac's own processes, and it would open every
route. The extension gets a **browser token** of its own instead, which
opens `/ws/browser` and nothing else.

1. Turning the switch on shows a short pairing code in Settings.
2. The user installs the extension (below), opens its popup and types the
   code.
3. The extension sends the code over `/ws/browser`; the server checks it
   and answers with a browser token, which the extension keeps in
   `chrome.storage.local`.
4. Settings shows the extension as paired, with an *Unpair* button that
   revokes the token.

The code is single-use and short-lived. The server's port is the default
one unless the popup is told otherwise.

## Installing it

The bridge exists in the desktop app only. The Labs switch is not offered
by the Linux server, whose browser is usually not on the same machine; the
`npm run dev` web app has it, and the server also accepts the dev port's
origin, so the extension can be worked on. *(Builder's call.)*

The extension ships **inside the desktop app**, so it carries the desktop's
version and its changelog lines go in `desktop/CHANGELOG.md`. Settings
offers *Show the extension folder*; the user loads it with
`chrome://extensions` → *Developer mode* → *Load unpacked*. A desktop update
updates the files; the browser picks them up on its next restart or on
*Reload* in its extensions page.

Not the Chrome Web Store, for the first version: `<all_urls>` makes its
review slow, and the people this is for can load an unpacked extension. An
organisation that blocks unpacked extensions by policy
(`chrome://policy`) blocks the bridge too; the first version does not work
around that.

## Later

In order:

1. **Rewrite the selection.** A tool that replaces the text selected in the
   page, approved like a file edit. ClickUp's editor is a contenteditable,
   so inserting text the way typing does should register as a normal edit;
   this is a guess to check against a real ClickUp page before designing
   it.
2. **Fill inputs and click**, approved per action.

## Risks

- MV3 stops an idle service worker. An open WebSocket that exchanges a
  message more often than the browser's idle limit keeps it alive; the
  extension pings the server to stay connected and reconnects when it
  wakes.
- A screenshot can carry text that reads like instructions to the agent.
  It is the user's own page, sent by them or approved by them; nothing more
  is done about it.
- The selection end is guessed from mouse and key events; a page that
  selects text from script (a "select all" button) may not send one.

## Left to the builder

- The debounce of a selection, the ping interval, the pairing code's length
  and lifetime.
- The popup's look, and the lip's: from Claude Design, through the main
  session.
- The message shapes on `/ws/browser`.
- Whether the browser token is one per extension or one per browser.

## Settled while building

- **Pairing codes** are 6 characters from an alphabet without 0/O and 1/I,
  shown 3 + 3 and taken back in either case, with or without the space;
  single-use, valid for 5 minutes, and cancelled after 5 wrong tries; a new
  code replaces the old one. Settings shows no countdown: the validity line
  stands still and reads "expired" in place when the code lapses. After
  `paired` the same socket is authenticated, with no `hello` and no
  `welcome`.
- **`/ws/browser` with the switch off** accepts the upgrade and closes at
  once with 4403, so the extension can tell "off" from "Orbital not
  running".
- **Origin on `/ws/browser`:** the extension's origin, or none at all. A
  page always sends one, so a missing Origin is a local process, which still
  needs a token or a code. The token exemption is keyed to that exact route.
- **A socket** that sends nothing valid within 5 s, or a malformed or
  unexpected first frame, is closed with 1008.
- **Outcomes:** with no Orbital window subscribed, `no-window` comes back at
  once; otherwise after 3 s of silence. Only the first outcome per event
  counts. A screenshot the server cannot read or shrink under the
  attachment limit comes back undelivered with no reason.
- **Screenshots** are stored in the image store (re-encoded as JPEG when the
  PNG is over the limit); the agent's copy is scaled to at most 1568 px on
  its long side.
- **`browser_screenshot`** joins a session's tools when the session starts
  with the switch on; turning the switch off mid-session makes it answer
  "turned off".
- **The extension's shortcut** for a screenshot is ⌘⇧S, when the browser
  has it free. Its content script runs in the top frame only, so a
  selection inside an iframe is not sent. Unpair in its popup forgets the
  local token; the pairing itself is revoked in Settings.
- **A screenshot from the browser names its page for the agent**: a line
  `Screenshot of <title> — <URL>` per screenshot, after any selection block
  and before the typed words. It is a parsing contract like the selection's
  head: the transcript draws "Screenshot from the browser — <title>" from it,
  and `cleanTitle` strips it. A transcript read back from the CLI holds the
  text and the image as two messages, so there the caption stands above the
  image rather than under it.
- **The lip stack** (canvas 64b): what will be sent touches the well,
  browser above editor; the editor's cursor read-out, which sends nothing,
  stands bare above the browser row. × fades the row in 120 ms, then the
  stack closes.
- **"No browser connected"** is not an error result: the transcript says "no
  browser" in muted ink, and a run of tool calls does not count it as failed.
- **Settings** shows the port Orbital listens on, and for a browser not
  connected now when it was last seen (`lastSeenAt`, kept in the pairings
  file).
