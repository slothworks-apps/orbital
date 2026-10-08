---
id: phone-views-an-mcpjson-server-file
title: View file for a project-file .mcp.json server on the phone
status: backlog
type: idea
domain: sessions
related:
  - 2026-10-08-mcpjson-approval-design
  - phone-opens-files-the-session-named
tags:
  - mcp
  - mobile
---
# View file for a project-file .mcp.json server on the phone

[[2026-10-08-mcpjson-approval-design]] asks about a project's undecided
`.mcp.json` servers before a new session starts. On the desktop, a server
that runs a file from the project has *View file*, which opens that file in
the read-only viewer through `GET /api/mcpjson/file`.

The phone's sheet (canvas `Feature - MCP approval` 47c/47d) shows the same
row without the chip. The phone's file screen is pushed over an open session
and reads through it (`readPath` in `web/src/mobile/files`), and at this
point there is no session yet. The row still says the server runs a file
from the project, and the command shows the path.

To build it: put `GET /api/mcpjson/file` on the phone allowlist (it reads
only the one file `.mcp.json` names for a server, confined to the project),
and give the file screen a source that reads through it rather than through a
session, opened over the New session screen. The 47c chip is already drawn:
`min-height:44px`, `padding:0 14px`, radius 12, mono 12.
