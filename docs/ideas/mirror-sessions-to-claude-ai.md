---
id: mirror-sessions-to-claude-ai
title: Publish Orbital's own sessions to claude.ai so the phone can watch them
status: archived
type: idea
domain: sessions
related:
  - runner-pins-the-session-id
  - subagents-only-for-orbital-sessions
  - errors-are-recorded-not-announced
tags:
  - runner
  - agent-sdk
  - mobile
---
# Publish Orbital's own sessions to claude.ai so the phone can watch them

**Archived 2026-10-07.** Orbital now has its own phone app over an
end-to-end encrypted relay ([[2026-09-30-mobile-remote-design]]), which
ruled this bridge out (alpha API, unsolved device enrolment, a Claude app
that shows less). It stays here as the fallback that spec names, should
running a relay turn out to be more than is wanted.

A session Orbital launched is reachable only from the machine it runs on. The
question is whether it could also appear in the Claude mobile app — watched
from the sofa, and eventually answered from there.

**Yes, for the sessions Orbital launches itself, and not through a flag on the
CLI.** The route is the SDK's own bridge export. What follows is what the
installed SDK (`@anthropic-ai/claude-agent-sdk`, read at 0.3.272 — 0.3.278 is
what is installed today, and `bridge.mjs` is still there) and CLI actually
offer, read out of them rather than remembered.

## What does not work

- **`--remote-control [name]`** — the CLI's own flag, described in its help as
  *"Start an **interactive** session with Remote Control enabled"*. Orbital
  drives the CLI headlessly through the SDK's stream-json transport; there is
  no interactive session for the bridge to attach to.
- **`remoteControlAtStartup`** and **`autoUploadSessions`** (*"Mirror local
  sessions to claude.ai as view-only (no remote control)"*) are settings the
  CLI reads, and the CLI groups `autoUploadSessions` under **Internal** in its
  own config screen. Not a surface to build a feature on.
- **`--cloud`** creates a session that runs in Anthropic's cloud. That is the
  opposite of what Orbital is for: the whole product is sessions running on
  this machine, in these working directories.

## What does work

`@anthropic-ai/claude-agent-sdk/bridge` — an `@alpha` export, three functions
and a handle:

```ts
import { createCodeSession, fetchRemoteCredentials, attachBridgeSession } from '@anthropic-ai/claude-agent-sdk/bridge'

const cse = await createCodeSession(baseUrl, accessToken, title, timeoutMs, tags, gitContext, cwd, model)
const creds = await fetchRemoteCredentials(cse, baseUrl, accessToken, timeoutMs, trustedDeviceToken)
const bridge = await attachBridgeSession({
  sessionId: cse,
  ingressToken: creds.worker_jwt,
  apiBaseUrl: creds.api_base_url,
  epoch: creds.worker_epoch,
  outboundOnly: true,            // mirror only — see below
})
```

The handle takes exactly what `Runner` already has in its hands:
`write(msg: SDKMessage)` per message, `sendResult()` at a turn boundary,
`reportState('running' | 'requires_action' | 'idle')`, `reportMetadata()` for
the branch and directory shown on claude.ai, `flush()` and `close()`.

`createCodeSession`'s own doc settles the part of the question that matters
most: *"Callers supply their own OAuth token — this is a thin HTTP wrapper
with no implicit auth, so it works from any process (not just the CLI)."*

## Where it lands in Orbital

`Runner.pump()` already iterates every raw `SDKMessage` and fans it onto the
hub. The bridge is a second fan-out from that same loop — `bridge.write(msg)`
beside the `hub.publish`, `sendResult()` where `result` is handled today, and
`reportState` wherever `setStatus` is called. Nothing needs re-deriving.

Mirror first (`outboundOnly: true`, which "the remote UI should see the
session but not be able to drive it"). Two-way is the same handle with the
inbound callbacks wired: `onInboundMessage` into the same `enqueue` that
`POST /api/sessions/:id/messages` uses, plus `onInterrupt`, `onSetModel`,
`onRenameSession`, each of which already has an equivalent route.

## What has to be solved first

- **An OAuth token.** The bridge takes one as a parameter and mints none.
  Orbital has never needed a claude.ai credential — the CLI's own login has
  been enough, because the CLI does the talking. Two ways to get one:
  - `claude setup-token` (needs a Claude subscription) prints a long-lived
    token once — *"Save this token securely. You won't be able to see it
    again… export CLAUDE_CODE_OAUTH_TOKEN=<token>"*. The server reads it from
    the environment. **Use this one.**
  - The CLI's own stored credential: the macOS Keychain under service
    `Claude Code-credentials` (elsewhere `~/.claude/.credentials.json` —
    absent on this machine, so the Keychain is what is live here). It is a
    short-lived access token plus a refresh token, so lifting it means owning
    the refresh too, and it breaks whenever the CLI re-logs in.
- **Trusted device.** Bridge sessions are `SecurityTier=ELEVATED`;
  `fetchRemoteCredentials` takes an `X-Trusted-Device-Token` and can fail
  terminally with `untrusted_device` (enroll) or `session_stale_relogin`
  (re-authenticate). This is a *device* enrolled against the user's own
  account, not an application registered with Anthropic — Orbital never
  becomes a third-party client, it acts as the user. The CLI enrols and
  renews the device itself (`getTrustedDeviceToken`, an internal module; no
  `.device-keys.json` on this machine yet, so it is minted on demand), and
  how Orbital gets one of its own is the open part. Also note the CLI's own
  guard: *"Cloud sessions are only available on the first-party Anthropic"*
  backend — a Bedrock/Vertex setup is out.
- **Two ids per session.** The bridge session is a `cse_*` id, while Orbital
  pins the CLI's own ([[runner-pins-the-session-id]]). The mapping needs a
  column, and the panel needs somewhere to put the claude.ai link.
- **Credential lifetime.** The worker JWT is 4h; the handle has
  `reconnectTransport({ ingressToken, apiBaseUrl })` for the refresh, and
  `onClose(code)` classifies what happened (401 / 4090 epoch superseded /
  4094 credential exhausted, versus transient blips that retry internally).
  Those failures are exactly the kind the error surface now exists for
  ([[errors-are-recorded-not-announced]]) — a mirror that quietly stopped
  mirroring would be the worst version of this feature.
- **Permissions.** Orbital launches sessions with a permission mode and no
  `canUseTool`, so nothing prompts today. Answering a prompt from a phone
  means Orbital first has to have a prompt path at all; the bridge's
  `sendControlRequest` / `onPermissionResponse` pair is how it would travel,
  but that is its own piece of work, not part of the mirror.
- **Alpha, loudly.** The export states that it is "a separate versioning
  universe from the main `query()` surface: breaking changes here do NOT bump
  the package major." Pin the SDK exactly and expect to re-read this file.

## Terminal sessions cannot come along

Orbital never owns their process — it tails their `.jsonl` and reconstructs
what happened ([[cli-session-registry]]), so it has no `SDKMessage` stream to
write and no turn boundary to report. This is the same line
[[subagents-only-for-orbital-sessions]] draws, for the same reason, and it
should be drawn the same way in the UI rather than discovered.

`importSessionToStore` exists (also `@alpha`) and looks adjacent, but it
copies a local JSONL into a custom `SessionStore` backend — somewhere you
host, not claude.ai. It answers a different question.

## Worth deciding before building

Mirroring sends a local session's transcript to claude.ai. Even for a tool one
person runs on their own machine, that should be a deliberate act: a setting,
or per-session opt-in at launch, and a visible mark on the planet and in the
panel for a session that is being published. Write that down as an `adr` when
the work starts — it is the kind of default that is hard to change later.
