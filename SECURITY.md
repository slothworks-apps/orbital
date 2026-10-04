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

The server listens on `127.0.0.1` only. Every request to `/api` and `/ws`
must carry the token stored in `<dataDir>/api-token` (readable by your user
only): the desktop app sets it as a cookie in its own window, and in
browser mode `npm run dev` prints a link that sets it. Only the static
bundle, `GET /api/auth` and a bare `GET /api/health` answer without it.

Anything already running as your user is out of scope: it can read the
token file, `~/.claude` and start `claude` directly. What is in scope is
everything that is *not* supposed to reach the server:

- **Web pages in your browser.** A page you visit runs on your machine too.
  It has no token, and the server also refuses any request whose `Host`,
  or whose `Origin` when one is sent, is not its own — on REST as well as
  on the WebSocket. That covers DNS rebinding and other local servers on
  the same host. A page that can still read data from Orbital or drive a
  session is a vulnerability.
- **Other machines.** Anything that makes the server reachable from the
  network is a vulnerability.
- **Files the session has nothing to do with.** The file viewer reads a
  path inside the session's working directory, or an absolute path that
  the session's own transcript names (a screenshot an agent saved to a
  temporary folder, say). Reading any other file through it is a
  vulnerability.

### The phone and the relay

A paired phone reaches the Mac through the relay, end-to-end encrypted:
the keys are exchanged during pairing, which both screens confirm with a
short code, and the relay forwards frames it cannot read. On the Mac, a
phone can call only the routes in `server/src/remote/allowlist.ts`.

- **The relay operator**, or anyone who takes over the relay, learning what
  a frame contains or forging one the Mac or the phone accepts is a
  vulnerability. Seeing which devices talk and when is not; that is what a
  relay needs to route.
- **A phone that is not paired**, or one the Mac has removed, getting any
  answer from the Mac is a vulnerability. So is a paired phone reaching a
  route outside the allowlist.
