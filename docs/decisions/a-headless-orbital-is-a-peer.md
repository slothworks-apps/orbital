---
id: a-headless-orbital-is-a-peer
title: Orbital on a Linux server is a headless peer, not a web app on a public port
status: draft
type: adr
domain: remote
related:
  - 2026-10-06-peer-macs-design
  - peer-macs-federate-through-the-local-server
tags:
  - remote
  - server
---
# Orbital on a Linux server is a headless peer

## The problem

Sessions should keep running on a machine that never sleeps, such as a
Linux VPS, and be driven from the Mac and the phone like local ones.

## What was decided

**The VPS runs the server without Electron or the web app and joins as a
host-only peer** over the relay (`2026-10-06-peer-macs-design` § 5). It
binds to `127.0.0.1` like every Orbital server. The Mac's map is its UI;
pairing happens in the terminal with `orbital pair`.

## Rejected

- **Serving the web app from the VPS on a public port**, guarded by the
  API token. The server runs shell commands and Claude sessions for its
  user; one leaked token or an auth bug would hand all of that to anyone
  on the internet. It also puts the VPS's sessions on a second map,
  which is the very split the peer design removes.
- **A VPS web UI reached over an SSH tunnel or Tailscale** as the main
  way in. It works and stays possible, but it is a second map to watch;
  it is not built for v1.
- **A symmetric Linux peer** that also shows the Macs' sessions. Nobody
  looks at the VPS, so its client role would be work nobody sees.
