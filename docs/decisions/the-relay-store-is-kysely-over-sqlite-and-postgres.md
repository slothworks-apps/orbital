---
id: the-relay-store-is-kysely-over-sqlite-and-postgres
title: The relay store is Kysely, over SQLite and Postgres
status: in-force
type: adr
domain: remote
related:
  - 2026-09-30-mobile-remote-design
  - 2026-10-01-mobile-remote-backend
  - one-query-builder-for-server-and-relay
tags:
  - relay
  - database
---
# The relay store is Kysely, over SQLite and Postgres

## Context

`server/` already talks to SQLite through drizzle. The relay needed the
same kind of thing — devices, pairs, pairing tokens, migrated at boot —
but it has to run two ways: SQLite for tests and a laptop, Postgres
(`RELAY_DATABASE_URL`) for every real deployment on Dokploy, from one
table description and one set of queries. Drizzle's schema and its
`drizzle-kit` output are per dialect (`sqliteTable` vs. `pgTable`, a
separate migrations folder each), so it cannot do that without writing
the schema and the migrations twice and keeping them in lockstep by
hand.

## Decision

The relay's store (`relay/src/db.ts`, `relay/src/store.ts`) is written
against Kysely, with one `RelayDatabase` interface and one `Migrator`
whose provider is a static, bundled `Record<string, Migration>`
(`relay/migrations/`) rather than a directory read at runtime, since the
Docker image ships the compiled relay alone. `openRelayDb` picks the
dialect from the connection string: a `postgres://` URL gets
`PostgresDialect` over `pg`, anything else gets `SqliteDialect` over
`better-sqlite3`. Both dialects run the same migrations and the same
query builder calls; `asNumber` is the one dialect seam left in the
store, because Postgres hands a `BIGINT` timestamp back as a string and
SQLite does not.

This makes two query builders exist in the repository at once — drizzle
in `server/`, Kysely in `relay/` — which the owner does not want as a
steady state. The follow-up idea
[[one-query-builder-for-server-and-relay]] already records moving
`server/` onto Kysely too, once the plan this relay belongs to has
landed and its Kysely patterns exist to copy from.

## Alternatives ruled out

- **Drizzle, with a schema per dialect.** Drizzle supports both SQLite
  and Postgres, but not from one schema: `sqliteTable`/`pgTable` are
  distinct APIs with distinct migration output. The relay would carry
  two schemas and two migration folders that have to be kept in sync by
  hand, for a feature whose whole value is being the same code against
  either backend.
- **Raw SQL**, hand-written per dialect or templated. It would avoid a
  second query-builder dependency, but reintroduces exactly the
  two-dialect duplication Kysely was chosen to avoid, with no type
  checking on top. The owner wants one query builder across the two
  services that need a database; raw SQL is not that, it is zero query
  builders plus more duplication.

## Consequences

- The repository carries two query builders until
  [[one-query-builder-for-server-and-relay]] is done: drizzle in
  `server/`, Kysely in `relay/`. Not a steady state the owner wants, but
  a known one with a named follow-up.
- A schema change in the relay is one new file in `relay/migrations/`
  plus one line in the registry in `relay/src/db.ts`; it runs at boot,
  on both dialects, from the same migration.
- SQLite stays test-and-laptop only; every real deployment is Postgres.
  A dialect-only bug can pass the suite and reach Postgres untested
  unless `RELAY_TEST_DATABASE_URL` is set, which runs `relay/test/store.test.ts`
  against a real Postgres too — CI has to set it for the two dialects to
  both be covered.
- Raw SQL is confined to the one place a Kysely query cannot express
  what is needed (the `sql\`1\`` literal in `isPaired`'s existence
  check); everything else goes through the builder, so a dialect
  difference shows up as a type error or a failing test, not a
  production surprise.
