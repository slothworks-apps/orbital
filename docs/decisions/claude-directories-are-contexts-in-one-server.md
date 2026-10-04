---
id: claude-directories-are-contexts-in-one-server
title: Every Claude directory is a context inside one server, not a server of its own
status: in-force
type: adr
domain: sessions
related:
  - 2026-10-04-multiple-claude-directories-design
  - stay-on-sqlite
tags:
  - accounts
  - watcher
---
# Every Claude directory is a context inside one server

## The problem

Orbital has to watch several Claude configuration directories at once
(`~/.claude`, `~/.claude-work`, …), each with its own transcripts, live
CLI registry, IDE lock files, command catalog, login, model catalog and
plan limits. Today all of these hang off a single `claudeDir` resolved at
boot.

## The decision

One server holds one context per configured directory: the watcher and
indexer, the registry, the IDE lock store, the command catalog, the model
catalog and the limits probe, each built for that directory. Code that
reads `claudeDir` today takes the directory as an argument. A context
starts when a directory is added and stops when it is removed, without a
restart. Sessions of all directories live in the one database, keyed by
session id, with `claude_dir_id` on the row.

## What is ruled out

- **A server process per directory, merged in the UI.** Two databases,
  two API tokens, two WebSockets in the browser, and the phone would have
  to pair with each. The map's point is one view of everything.
- **Only more watchers, everything else global.** Sessions would show
  up, but would be launched, titled and limit-tracked under the wrong
  account. That is the half-broken state the single `claude_directory`
  setting is already in, where Orbital watches one tree and the CLI it
  spawns writes into another.
