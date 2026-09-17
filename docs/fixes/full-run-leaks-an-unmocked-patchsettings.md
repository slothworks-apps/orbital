---
id: full-run-leaks-an-unmocked-patchsettings
title: The web suite throws five unhandled errors, but only in a full run
status: backlog
type: fix
domain: sessions
tags:
  - tests
---
# The web suite throws five unhandled errors, but only in a full run

## What happens

`npm run test:run -w web` reports every test passing and then:

```
Vitest caught 5 unhandled errors during the test run.
TypeError: Cannot read properties of undefined (reading 'catch')
 ❯ setHideEnded src/store/store.ts:420:60
 ❯ onClick src/map/SpaceMap.tsx:457:30
```

The run exits non-zero on the errors alone, so `npm test` at the root fails
with 624 green tests.

`vitest run src/test/spacemap.test.tsx` on its own is clean. The errors need
the full run.

## What it looks like

`setHideEnded` fires `api.patchSettings(...).catch(...)`. Some test file's
`vi.mock('../lib/api')` factory is in force when the map's ENDED toggle is
clicked from another file's test, and that factory's `api` has no
`patchSettings` — so the call returns `undefined` and `.catch` throws. The
click's own assertions still pass, because the throw lands outside React's
dispatch.

Confirmed pre-existing: the same five errors appear on a tree with no local
changes.

## Where to start

The suspects are the mock factories that list the `api` surface by hand. Some
are exhaustive (`sidebar.test.tsx` pins its object with
`satisfies Record<keyof typeof actual.api, unknown>`, which is why adding a
method to `api` breaks it loudly); the ones that are not will silently hand
back `undefined` for anything they forgot. Making every factory carry that
`satisfies` clause would turn this class of bug into a type error.

`store.ts` swallowing the result would hide it rather than fix it — the store
is right to assume its own API client returns a promise.
