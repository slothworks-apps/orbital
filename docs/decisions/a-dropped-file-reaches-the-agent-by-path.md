---
id: a-dropped-file-reaches-the-agent-by-path
title: A dropped file reaches the agent by path, never pre-approved
status: in-force
type: adr
domain: web
related:
  - 2026-10-01-file-attachments-design
  - an-ide-selection-rides-as-a-quoted-block
tags:
  - attachments
---
# A dropped file reaches the agent by path, never pre-approved

## The problem

The composer could attach images only. An `.xlsx` has no content block in the
API, so "attach it" has to mean something other than "send its bytes".

## The decision

A non-image file reaches the agent as an absolute path in the turn's text,
under an `Attached files:` list the composer appends — the CLI's own answer,
where dragging a file into the terminal pastes its path.

- In the desktop app the path is the file's own (`webUtils.getPathForFile`):
  no copy.
- In a browser the bytes are uploaded to Orbital's file store
  (`dataDir/files/<sha>/<name>`) and that path is sent.
- The composer shows a chip; the transcript turns the list back into
  receipts. The block is composed and parsed on the client, as the IDE
  selection block is.
- Reading the file goes through the session's permission mode. The file
  store is not added to any allow list.

## What was rejected

**Copying into the project's cwd** (`<cwd>/.orbital-attachments/`). The agent
would read it without a prompt, but the file stays in the project and can
land in git — Orbital writing into a repository the user did not ask it to.

**Always the file store, desktop included.** One code path, but a pointless
copy of a file that already has a path, and a path the user does not
recognise in the transcript.

**An `@path` token typed into the editor.** No new UI, but in a browser the
token is a hash path into Orbital's data directory, and it reads as noise in
the bubble.

**Pre-approving reads of the file store.** Convenient, but it would quietly
override a permission mode the user chose.

**Composing the block on the server** behind a `files` field on the messages
and sessions routes. It would allow refusing a vanished path with a 400, but
it adds a field through two routes, the rewind and revive paths, and the
optimistic-turn echo match — for a case the agent already reports itself.
