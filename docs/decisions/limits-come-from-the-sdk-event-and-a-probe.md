---
id: limits-come-from-the-sdk-event-and-a-probe
title: Usage limits come from the SDK's rate-limit event and a probe, not from the claude.ai endpoint
status: in-force
type: adr
domain: sessions
related:
  - 2026-10-03-usage-limits-design
  - models-come-from-the-sdk
tags:
  - limits
---
# Usage limits come from the SDK's rate-limit event and a probe

## The problem

Continuing a session after a usage limit resets needs to know that the
limit was hit and when it resets. Showing the state of the plan's limits
needs every window's utilisation and reset time, even while no session
runs.

## What was decided

**Two sources, both from the Claude Agent SDK.**

- **Continuation rests on `rate_limit_event`.** A running session's query
  emits it with a status (`allowed` / `allowed_warning` / `rejected`), the
  window type and `resetsAt`. It is a stable, typed message.
- **The view rests on a probe.** A short-lived `query()` with
  `persistSession: false`, as for the model catalogue, runs the CLI's
  local `/usage` command and reads the `usage_report` on its reply: the
  server's usage rows verbatim, with their labels, order and severity.
  The SDK's `get_usage` control request returns named windows without
  severity, so it is the fallback if `/usage` turns out to spend tokens.

Both are marked experimental in the SDK. That risk is accepted for the
view only: if they change, the view breaks and continuation still works,
because it never depends on the probe except as a fallback for a missing
`resetsAt`.

## Rejected

- **Events only.** No experimental API, but the view would be empty until
  an Orbital session runs, and would show only the windows a session
  happened to report.
- **Calling the claude.ai usage endpoint directly** with the OAuth token
  from the macOS Keychain. Undocumented, fragile, and it would have Orbital
  handle the user's credentials itself.
