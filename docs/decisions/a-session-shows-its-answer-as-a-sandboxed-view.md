---
id: a-session-shows-its-answer-as-a-sandboxed-view
title: A session shows its answer as a sandboxed view
status: in-force
type: adr
domain: sessions
related:
  - 2026-11-18-generated-views-design
  - why-orbital
tags:
  - views
  - labs
  - security
---
# A session shows its answer as a sandboxed view

## The problem

When the user asks a session to show data, the answer comes back as a table
in text or as the path to a picture. Neither can be filtered, hovered or
picked from, and a picker or a form the agent needs an answer from has to be
described in words. The CLI has nothing better to offer: a terminal cannot
draw a chart.

Orbital already draws the transcript in a browser. It can show a small page
the agent writes, where the conversation happens, and let what the user
does in it reach the session. This is a capability beyond the CLI, not a gap
in it, and it is the kind of thing only a window can do. That is why it is
in Orbital, and why it starts in Labs: the reception is not known.

## What was considered

- **A declarative chart spec (Vega-Lite, a fixed set of components).** Safe
  and consistent, but limited to charts and tables. Pickers, forms and
  anything unforeseen would be out. Ruled out as the only way.
- **A fenced block in the reply's markdown.** Would work for terminal
  sessions too, but the data would sit inside the text, and nothing could
  come back to the session. Ruled out.
- **A tool on the Orbital MCP server, with a page in a sandboxed iframe.**
  Chosen.

## Decision

- **The tool.** `show_view`, on the Orbital MCP server, only for Orbital
  sessions and only while Labs → Views is on. Terminal sessions do not get
  it, as with the harness and the progress list.
- **React first, HTML as the escape hatch.** The agent writes a React
  component in TSX, which it writes best. The Mac compiles it with sucrase
  when the call is made, so a syntax error comes back to the agent and no
  client needs a compiler. React and the Tailwind runtime ship with Orbital;
  Tailwind's theme uses Orbital's own tokens, so a view looks like Orbital
  without effort. Other imports resolve through esm.sh against the page's
  React.
- **The boundary is the frame, not the network.** The page runs in
  `<iframe sandbox="allow-scripts">` from `srcdoc`, so it has an opaque
  origin: it cannot reach Orbital's API, its token, its storage or the
  parent page. That is the boundary that matters. A CSP limits scripts to
  cdnjs, jsDelivr, unpkg, esm.sh and hosts the user adds, and `fetch` to
  domains the user allows for the session. The session can reach the
  network through Bash anyway, so these limits are about what a page does
  on its own, not about containing the agent.
- **What reaches the session needs the user's hand.** `orbital.send` and
  links work only from a gesture inside the frame. A waiting view is parked
  like a question, in its own slot, so a permission asked meanwhile does
  not cancel it.
- **The Orbital MCP server's call timeout is the CLI's cap while Views is
  on.** A view can wait on the user for hours; a user's `MCP_TOOL_TIMEOUT`
  would otherwise cancel it. Their other MCP servers keep their timeout.

## Consequences

- A view's code, data and allowed domains live in the transcript and in
  Orbital's data directory (`<dataDir>/views/<session>/`); the view shows
  its source on request.
- A page can still navigate its own frame away. On the Mac Electron stops
  it; on the phone the frame is reset when it happens, after the request
  has left.
- Deleting a session's data (retention) deletes its views' copies and
  approvals.
