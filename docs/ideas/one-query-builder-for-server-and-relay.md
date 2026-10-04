---
id: one-query-builder-for-server-and-relay
title: One query builder for the server and the relay
status: backlog
type: idea
domain: server
related:
  - 2026-10-01-mobile-remote-backend
  - 2026-09-30-mobile-remote-design
  - the-relay-store-is-kysely-over-sqlite-and-postgres
tags:
  - relay
  - database
  - chore
---
# One query builder for the server and the relay

The server talks to SQLite through drizzle (`server/src/db/schema.ts`,
migrations under `server/drizzle`). The relay, planned 2026-10-01
([[2026-10-01-mobile-remote-backend]] Task 6), talks to SQLite or Postgres
through Kysely, because the relay has to run on both from one table
description and drizzle cannot: its schema and its migrations are per
dialect (`sqliteTable` vs `pgTable`, one `drizzle-kit` output per dialect).

Two query builders in one repository is a decision taken under pressure,
not a preference. The owner wants one, and the one that can do both jobs is
Kysely.

## What it would take

- A Kysely table description of every server table, mirroring
  `server/src/db/schema.ts`, and a `Migrator` provider that replays the
  existing `server/drizzle/*.sql` files as the first migrations (Kysely
  migrations can run raw SQL through `sql`), so an existing `index.db` is
  not rebuilt and the drizzle journal is left behind, not translated.
- Rewriting every query in `server/src/**` from drizzle's builder to
  Kysely's. The count is high (sessions, stats, tags, rules, settings,
  errors, background tasks, rewinds, narrations, permission waits) and the
  shapes are close, so it is mechanical rather than hard; `snakeColumns`
  in `schema.ts` and the `$inferSelect` types need a Kysely equivalent.
- Dropping `drizzle-orm`, `drizzle-kit`, `server/drizzle.config.ts` and the
  `db:generate` script; the packaged app's `ORBITAL_MIGRATIONS_DIR`
  (`desktop/`) goes with them since migrations would be
  bundled statically the way the relay's are.

## Why not now

The remote backend plan is already large, and the server's database layer
is not what it changes. Do this as its own change after that plan lands,
when the Kysely patterns from the relay exist to copy.
