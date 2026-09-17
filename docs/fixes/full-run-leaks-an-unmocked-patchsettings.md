---
id: full-run-leaks-an-unmocked-patchsettings
title: The web suite passes 646 tests and then fails on five unhandled errors
status: done
type: fix
domain: web
related:
  - test-api-mocks-derive-from-the-real-module
tags:
  - tests
---
# The web suite passes 646 tests and then fails on five unhandled errors

## What happened

`npm run test:run -w web` reported every test passing and then:

```
Vitest caught 5 unhandled errors during the test run.
TypeError: Cannot read properties of undefined (reading 'catch')
 ❯ setHideEnded src/store/store.ts:420:60
 ❯ onClick src/map/SpaceMap.tsx:457:30
```

The run exits non-zero on the errors alone, so `npm test` at the root failed
with a fully green suite.

## The cause, and the two guesses that were wrong

`app.test.tsx` gives seven of `api`'s methods a resolved value in its
`beforeEach` — `listSessions`, `listTags`, `listTagRules`, `getSettings`,
`getMessages`, `listProjects`, `listModels` — and left `patchSettings` as the
bare `vi.fn()` its mock factory created. A bare `vi.fn()` returns `undefined`.
The map's ENDED toggle calls `setHideEnded`, which chains `.catch` on the
call, and `undefined.catch` throws. Five tests in that file click the toggle,
hence five errors.

The throw lands outside React's dispatch, so the click's own assertions still
pass and the test is green. Only the runner notices.

This doc originally recorded two things that turned out not to be true, both
worth keeping because they are the plausible readings:

- **"Only in a full run."** `vitest run src/test/app.test.tsx` on its own
  throws all five. The file checked at the time was `spacemap.test.tsx`,
  which never clicks the toggle. Vitest's per-file isolation was never in
  question.
- **"Some other file's factory has no `patchSettings`."** `app.test.tsx`'s own
  factory listed it, and carried the
  `satisfies Record<keyof typeof actual.api, unknown>` clause besides. The key
  was there; the value was a mock that returned nothing.

Which also disposes of the fix this doc first proposed. Spreading that
`satisfies` clause to every factory would not have caught this — the clause
checks that a key exists, and `vi.fn()` is assignable to any signature, so no
type can tell that what it returns is not a promise.

## The fix

Two commits' worth, in `web/src/test`:

1. `app.test.tsx` stubs `patchSettings` alongside its other seven.
2. The class of bug is closed at its source. All ten hand-written
   `vi.mock('../lib/api', …)` factories are replaced by one helper,
   `apiMock.ts`, which derives the mock from the real module's keys and gives
   every method a resolving default — so neither a missing key nor an
   unstubbed method can return a non-promise again. The reasoning, and what it
   costs, is in [[test-api-mocks-derive-from-the-real-module]].

`npm test` at the root exits 0, `npm run typecheck` is clean.

Nine `act(...)` warnings from `detail.test.tsx` survive this. They were
counted before and after and are unchanged by it — a separate thing, not
caused by the mocks resolving where they used to return `undefined`.
