---
id: stay-on-sqlite
title: Stay on SQLite; no embedded document store
status: in-force
type: adr
domain: server
related:
  - desktop-wrapper-electron
  - one-tag-per-session
  - errors-are-recorded-not-announced
tags:
  - database
  - migrations
---
# Stay on SQLite; no embedded document store

## The problem

Every field that appears means editing `schema.ts`, running `drizzle-kit
generate`, and getting another migration file. The wish was an embedded
Mongo — documents in, documents out, no schema step at all.

## What we decided

**Keep SQLite, Drizzle and the migrations.** The ceremony is a dev-loop
problem and gets a dev-loop answer:

1. **A JSON column wherever the shape moves.**
   `text('payload', { mode: 'json' }).$type<Payload>()` — adding a field to a
   payload is then a TypeScript change, not a migration. `errors.context`
   already works exactly this way ("JSON text on disk and a parsed object on
   the wire; the parsing lives in `src/errors/log.ts`, so nothing else has to
   remember which side it is on"), and it is the pattern to reach for again:
   an attempt's launch options, per-turn usage, anything whose shape belongs
   to the SDK rather than to us. If one of those fields ever needs querying,
   SQLite indexes into it through a generated `json_extract` column.
2. **`drizzle-kit push` in the dev loop.** It diffs `schema.ts` straight onto
   the dev database with no migration file; `generate` stays for anything that
   ships to a database with data in it.

## Why not

The schema is not the size of the complaint: six tables — `sessions`, `tags`,
`session_tags`, `tag_rules`, `settings`, `errors` — and **three migrations in
the project's whole life**. `openDb()` runs `migrate()` at boot, so there is
no deploy step either.

And half the data is genuinely relational:

- **`session_tags` is a real join**, three columns wide with an `origin` check
  constraint (`rule` / `manual` / `manual_removed`) — the mechanism behind
  [[one-tag-per-session]]. In a document store that becomes duplicated state
  or a hand-rolled join.
- **`tag_rules` is ordered and cascades** (`position`, plus
  `onDelete: 'cascade'` to `tags.id`), so deleting a tag cannot leave an
  orphan rule. Without foreign keys that guarantee becomes application code
  which has to be right every time.
- **The sidebar's history paging** filters by tag and query, orders by
  `last_at DESC` on an index, and slices by offset — in SQL, because the
  offset arithmetic only holds while the filter does.
- **Drizzle's types.** `ErrorRow = typeof errors.$inferSelect` keeps the wire
  shape and the table shape from drifting for free.

## What we ruled out

Publish dates checked on 2026-09-18 rather than remembered.

| | last published | shape |
|---|---|---|
| **PGlite** `@electric-sql/pglite` 0.5 | 2026-08 | Embedded Postgres as WASM. Not Mongo, but JSONB plus real queries and indexes — the only candidate that gave up nothing relational, and no native module. The one to revisit first if this is ever reopened. |
| **RxDB** 17 | 2026-08 | Reactive document DB over pluggable storage. Closest to "Mongo with subscriptions"; large, and some plugins are commercial. |
| **SurrealDB** `@surrealdb/node` | 2026-03 | Embedded, schemaless by default. A Rust native module — a *second* native rebuild for Electron. |
| **NeDB** `@seald-io/nedb` 4 | 2025-07 | Mongo's API in a file. A fork kept alive rather than developed. |
| **LokiJS** 1.5 | 2024-05 | Effectively unmaintained. |
| **Realm** 20 | 2025-08 | MongoDB's own embedded DB — on paper the literal "SQLite-like Mongo", but it is the Atlas Device SDK, which MongoDB deprecated. |

Two constraints narrowed this more than any feature did:

- **Electron.** [[desktop-wrapper-electron]] already pays for one native
  module (`better-sqlite3`). A WASM store adds none; a second Rust/C++ store
  adds another rebuild to every release.
- **Bun.** `bun:sqlite` ships in the runtime, so if the server ever moves
  there, staying on SQLite gets cheaper rather than dearer.

## What would reopen it

Data that is genuinely heterogeneous *and* queried by its own contents — many
kinds of per-session artifact, each with different fields, filtered on in the
UI. Orbital has none of that. Six stable tables and three migrations did not
make the case.
