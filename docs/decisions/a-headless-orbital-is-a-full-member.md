---
id: a-headless-orbital-is-a-full-member
title: Orbital on a Linux server is a full member of the group, without a map
status: draft
type: adr
domain: remote
related:
  - 2026-10-16-device-group-design
  - a-device-has-one-identity-and-one-channel-per-pair
tags:
  - remote
  - server
---
# Orbital on a Linux server is a full member of the group

## Context

Sessions should keep running on a machine that never sleeps, such as a
Linux server, and be driven from every other device
([[2026-10-16-device-group-design]] § 11).

## Decision

The server runs Orbital's server without Electron and without the web
app (`ORBITAL_HEADLESS=1`), bound to `127.0.0.1`, and joins the group as
a member of kind `headless`. It runs sessions and federates like a Mac,
so its sessions reach the other members through the orbital MCP. It
shows no map; it is joined and managed from the terminal
(`orbital devices …`).

## Ruled out

- **Serving the web app on a public port**, behind the API token. The
  server runs Claude sessions and shell commands; one leaked token would
  hand them to the internet, and it would be a second map to watch.
- **A host-only member** that serves but never asks (PR #79's plan).
  Its sessions could not start or read work on the other members, and
  the channel already carries both directions.

## Consequences

- The server needs the Linux fixes in the spec's § 11 and a runbook.
- A web UI on the server, over an SSH tunnel, stays possible later; it
  is not built.
