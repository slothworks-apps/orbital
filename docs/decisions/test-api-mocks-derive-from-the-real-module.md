---
id: test-api-mocks-derive-from-the-real-module
title: A test's api mock is derived from the real module, not written out by hand
status: in-force
type: adr
domain: web
related:
  - full-run-leaks-an-unmocked-patchsettings
tags:
  - tests
  - web
---
# A test's api mock is derived from the real module, not written out by hand

## The problem

Nine web test files each carried their own `vi.mock('../lib/api', …)` factory
listing all twenty-three methods on `api` by hand, thirty lines apiece. Eight
of them pinned the shape with `satisfies Record<keyof typeof actual.api,
unknown>`, so forgetting a method was a compile error.

That guard covers one of the two ways such a mock goes wrong, and it is the
less likely one. A method that is missing from the list is `undefined`. A
`vi.fn()` the test never stubbed **returns** `undefined`. The store chains
`.catch` onto several of its api calls, so both land the same way:

```ts
api.patchSettings({ map_hide_ended: String(hideEnded) }).catch((err) => { … })
```

`undefined.catch` throws, outside React's dispatch and therefore outside the
test's assertions — the test passes, and the run fails afterwards on an
unhandled error pointing at a line the test never meant to exercise. That is
exactly what [[full-run-leaks-an-unmocked-patchsettings]] turned out to be:
the key was present, the `satisfies` clause was present, and the method was
simply never given a resolved value.

Types cannot close the second hole. `vi.fn()` is `Mock<any>`, assignable to
any signature, so no clause tight enough to be worth writing will notice that
the thing it returns is not a promise.

## The decision

One helper, `web/src/test/apiMock.ts`, builds the mock module from the real
one's own keys and gives every method a `vi.fn().mockResolvedValue(undefined)`.
Every test file's factory is now the same line:

```ts
vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())
```

Nothing can be missing, because the keys come from `api` itself. Nothing
returns a non-promise, because the default does not. The rest of the module
is spread through untouched, which keeps `ApiError` identical to the one the
store's `instanceof` checks see. Tests override what they care about exactly
as before, with `vi.mocked(api.listSessions).mockResolvedValue([…])`.

It removed 270 lines and added 23.

## What we gave up

Adding a method to `api` used to break the test build loudly, in eight places,
which forced whoever added it to think about stubbing it. Now the new method
appears in every mock on its own with a resolving default and nothing
complains.

That is the trade we wanted. The loud break was a chore paid on every api
addition to catch a mistake that had never actually happened, while the quiet
one it could not catch had happened and cost an afternoon. A test that needs
the new method to resolve to something real will fail on the value, which is
a better failure than the one we removed: it points at the test that cares
rather than at eight that do not.

The default resolves to `undefined`, not to an empty array or object. A guess
at the shape would be wrong more often than it was right, and a caller that
does `(await api.listSessions()).map(…)` should fail in its own code rather
than silently see nothing — the same as it did before this change.
