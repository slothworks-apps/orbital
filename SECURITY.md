# Security

## Reporting a vulnerability

Report it privately through GitHub: the **Security** tab of this repository →
**Report a vulnerability**. Please do not open a public issue for it.

Say what an attacker can do, from where, and how to reproduce it. Orbital is
maintained by one person, so there is no fixed response time. Only the latest
release is fixed; there are no backports.

## What Orbital protects, and what it does not

Orbital runs Claude Code sessions on your machine with your user's
permissions: they read and write files and run commands, within the
permission mode you choose for each session. Keep that in mind when you
decide what to run in it.

The server listens on `127.0.0.1` only and has **no authentication**.
Anything already running as your user can talk to it, and that is out of
scope: such a process can read `~/.claude` and start `claude` directly.

What is in scope is everything that is *not* supposed to reach it:

- **Web pages in your browser.** A page you visit runs on your machine too.
  The server rejects requests whose `Host` or WebSocket `Origin` is not its
  own, which blocks DNS rebinding and cross-site WebSocket connections. A
  page that can still read data from Orbital or drive a session is a
  vulnerability.
- **Other machines.** Anything that makes the server reachable from the
  network is a vulnerability.
- **Files outside a session's project.** The file viewer reads only inside
  the session's working directory. Escaping it is a vulnerability.

A per-start token on every request would add a layer behind the header
checks. It is planned, not built:
[`docs/ideas/api-token-guards-the-local-port.md`](docs/ideas/api-token-guards-the-local-port.md).
