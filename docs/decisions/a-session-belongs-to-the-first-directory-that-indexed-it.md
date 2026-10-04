---
id: a-session-belongs-to-the-first-directory-that-indexed-it
title: A session id seen in two Claude directories belongs to the one that indexed it first
status: in-force
type: adr
domain: sessions
related:
  - 2026-10-04-multiple-claude-directories-design
  - claude-directories-are-contexts-in-one-server
  - errors-are-recorded-not-announced
tags:
  - accounts
  - watcher
---
# A session id seen in two directories belongs to the first

## The problem

The `sessions` table is keyed by the CLI's session UUID, and so is every
route, URL, WebSocket topic and the phone. With more than one Claude
directory, two of them can hold a transcript with the same id. Random
UUIDs do not collide by chance. They do collide when the work directory
was made by copying `~/.claude`, which is a natural way to set one up.

## The decision

The id stays the only key. A session's `claude_dir_id` is written when it
is first indexed and never changes. The default directory is indexed
first at boot, so a copied history stays with the original. A transcript
whose id is already owned by another directory is skipped, and the skip
is recorded once per directory in the error log, not announced.

A resumed copy in the second directory therefore stays invisible. That is
acceptable: it is a copy of a session the map already shows, and resuming
it from Orbital runs it under its owning directory.

"Never changes" holds between configured directories. A row whose
directory was removed, or whose directory moved to another path (its rows
are marked unowned), has no owner left to defer to: the next directory
that indexes its transcript takes it over. That is how adding a removed
directory back brings its sessions back, since the new row gets a new id
(ids are never reused).

## What is ruled out

- **A composite key (directory, id).** Every route, URL, topic, the phone
  client and the relay-tunnelled API would have to carry the directory.
  That is a large rewrite for a case that only copying produces.
- **Newest mtime wins.** The owner of a row would flip whenever either
  copy is touched, along with its label and the account it launches
  under.
