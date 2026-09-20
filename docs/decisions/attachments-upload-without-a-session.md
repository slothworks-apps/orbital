---
id: attachments-upload-without-a-session
title: A composer attachment uploads without a session, through its own route
status: in-force
type: adr
domain: web
related:
  - 2026-09-20-composer-design
  - api-token-guards-the-local-port
  - images-in-the-transcript-and-composer
tags:
  - detail-panel
  - attachments
---
# A composer attachment uploads without a session, through its own route

## The problem

The composer is one control with two mounts, and only one of them had image
intake. `POST /api/sessions/:id/attachments` 404s on a session that does not
exist, and the New Session dialog's session does not exist until Launch —
whose own request is where the refs have to travel. So 9d-D showed a chip in
the FIRST PROMPT well that no amount of client wiring could produce: the
dialog was left with no paste, no drop and no chips, because a paste that
always fails is worse than a paste that is not offered.

## The decision

`POST /api/attachments` takes the bytes with no session named. Both routes run
one extracted handler, so the 201/413/415/400 contract and
`ATTACHMENT_MAX_BYTES` are shared by construction, and the scoped route keeps
working unchanged.

The session lookup is the *only* thing the sessionless route drops, and that
lookup was never a guard. The image store is content-addressed and global —
one directory, keyed by the bytes' own sha, shared by every session — so a
session id neither scopes the write nor authorises it. Anything the 404
refused could simply have been posted to the other route instead. What
actually gates the port is the API token
([[api-token-guards-the-local-port]]), the same umbrella that already covers
`?cwd=` on `/api/commands` and `/api/files/complete`.

On the client `api.uploadAttachment` takes `sessionId: string | null` and
`null` picks the sessionless door. The dialog passes `null`; the detail panel
keeps passing the empty string on its no-selection render, which is
deliberately *not* the same value — nothing can be dropped on a panel that is
not there, and an empty id must not quietly become a valid upload.

## What was rejected

**A `?cwd=`-keyed route**, which is what the gap note in `NewSessionDialog`
anticipated, by analogy with `/api/commands?cwd=` and `/api/files/complete`.
Those two need a cwd because they *read the filesystem there*; an upload
writes into the global image store and never touches the project directory. A
`cwd` parameter would be a value the handler has to accept, validate and then
ignore — a scope that looks like one and is not, which is worse than no
parameter at all.

**Minting the session on dialog open** so the existing route applies. It puts
a row (and a runner entry) on the map for a dialog the user may cancel, and
makes Cancel a deletion rather than a no-op.

**Deferring the dialog's intake.** It was already deferred once; the field
that 9d-D draws with a chip in it had a comment explaining why it could not
have one. One route closes the gap.

## Consequences

The dialog's launch becomes a queued launch, the counterpart of the panel's
queued send: `takeForSend()` empties the well now and the launch request waits
for the uploads still in flight, because the refs cannot follow the request
that starts the session. A failed chip stays behind and is not in the turn.

The drop target in this mount is the dialog surface, so `ui/Dialog` grew
`surfaceRef` and `dropArmed` — the armed chrome (accent `.45` border over an
inset `.12` ring) is painted by the dialog on its own frame, as the detail
panel paints it on its shell.
