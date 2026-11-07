---
id: orbital-ships-its-own-browser-extension
title: Orbital ships its own browser extension rather than using Claude in Chrome
status: in-force
type: adr
domain: sessions
related:
  - 2026-11-05-browser-bridge-design
  - orbital-speaks-to-the-ide-itself
tags:
  - browser
  - mcp
---
# Orbital ships its own browser extension rather than using Claude in Chrome

## The problem

A session in Orbital cannot see what you are reading in your browser. To ask
about a paragraph of a spec, you copy it, switch to Orbital, paste it and say
where it came from; to show it a page, you take a screenshot and drag it in.

## What was considered

- **Claude in Chrome.** Anthropic's extension gives Claude Code browser tools
  over native messaging, in Chrome, Edge, Brave, Arc, Vivaldi and Opera. It
  needs the extension signed in to the same claude.ai account and
  organisation as Claude Code, and an organisation can turn it off — which
  is the case on the maintainer's work account. It has no notion of a
  selection pushed into a session: the agent can only fetch one by running
  script in the page when asked. Whether a session spawned through the Agent
  SDK can use it at all is not documented.
- **Playwright MCP or Chrome DevTools Protocol.** Either drives a browser
  started for it, or the user's browser restarted with a debugging port.
  Both move the work out of the browser you are already in.
- **Orbital's own extension.** Talks only to Orbital on `127.0.0.1`, needs no
  Anthropic sign-in, and can push events into the composer the way the IDE
  bridge does.

## What was decided

Orbital ships its own Manifest V3 extension (spec
[[2026-11-05-browser-bridge-design]]). It works where Claude in Chrome is
blocked, it stays in the browser in use, and it fits the model Orbital
already has for the editor: live state delivered with the next message, not
an agent watching.

## What it costs

- A fourth thing to maintain, though not a fourth version: it ships inside
  the desktop app and carries its version.
- An unpacked install through Developer mode, which an organisation's
  browser policy can forbid.
- Browser actions (rewrite, fill, click) that Claude in Chrome already has
  must be built again if they are wanted, each with its own approval.
