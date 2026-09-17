---
id: selected-session-lives-in-the-url-query
title: Selected session lives in the URL query
type: adr
status: in-force
domain: web
---

# Selected session lives in the URL query

Selecting a session put nothing in the address bar, so a refresh — or a link
to "the session I am looking at" — landed on an empty map. The selection now
lives in the URL as `?session=<id>`, kept in step with `ui.selectedId` by
`web/src/lib/sessionUrl.ts`.

## A query parameter, not a path

`/s/<id>` reads better but needs a rewrite rule everywhere the built bundle is
ever served — the Fastify static route, `vite preview`, anything later. A
refresh on a path the server has no file for is a 404 before any JavaScript
runs. `?session=<id>` is the same document, so it needs nothing, and the app
is a single screen with one piece of routable state; a router would be more
machinery than the problem has.

## pushState, not replaceState

Selection changes push a history entry, so Back closes the detail panel and
Forward reopens it. The detail panel reads as a place, and that is what a
browser user expects of it. The cost is that Back walks the sessions visited
before leaving the app — acceptable for a panel that is genuinely a view of
its own.

The restore on load is deliberately NOT pushed: it is the entry the user
landed on, not a step they took.

## Restoring can need a fetch

`loadInitial` only fetches the first page of sessions, so a link to an older
one names a session the store has never heard of. The restore fetches that one
by id (`GET /api/sessions/:id`) and upserts it before selecting. If the server
does not know it either — a session that has since been deleted — the
parameter is dropped with `replaceState` and nothing is selected, so a second
refresh does not try again.

Two ordering rules fall out of this and are what the code's comments defend:

- The restore must wait for `loadInitial` to settle. It replaces the whole
  `sessions` map wholesale, so a session fetched by id before then is thrown
  away moments later.
- The mirror (selection → URL) must not run until the restore has settled, or
  it reads the not-yet-restored `null` selection as a deselection and pushes
  the id straight back out of the URL.

## Consequences for tests

jsdom keeps one URL per test file. Any test file that mounts `App` has to
reset it between cases (`window.history.replaceState(null, '', '/')`) or the
session one test selects is restored into the next one on mount.
