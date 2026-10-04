---
id: restoreallmocks-strips-the-api-mock-defaults
title: A test file using restoreAllMocks loses the api mock's resolving defaults
status: done
type: fix
domain: web
related:
  - test-api-mocks-derive-from-the-real-module
  - full-run-leaks-an-unmocked-patchsettings
tags:
  - tests
  - web
---
# A test file using restoreAllMocks loses the api mock's resolving defaults

## What happened

`web/src/test/apiMock.ts` gives every method on `api` a resolving default so
that a call a test never stubbed still returns a promise — that is the whole
point of [[test-api-mocks-derive-from-the-real-module]], and the bug it closes
is [[full-run-leaks-an-unmocked-patchsettings]].

It installed that default *after* making the mock:

```ts
vi.fn().mockResolvedValue(undefined)
```

`vi.restoreAllMocks()` strips an implementation installed that way. A file
that calls it in `afterEach` therefore ran its second and every later test
against bare `vi.fn()`s, which return `undefined` again, and the class of bug
the helper was built to close was live again inside that file.

`apperrors.test.tsx` and `errorboundary.test.tsx` both restore mocks (they spy
on `console.error`), and both had a hand-written `beforeEach` re-stubbing
`reportErrorToServer` to stay green, because `ErrorBoundary.componentDidCatch`
chains `.catch` onto that call.

## What vitest 3.2.7 actually does

Measured, not remembered — a throwaway spec calling each of the three reset
functions on both spellings of a `vi.fn`:

| | `vi.fn().mockResolvedValue(undefined)` | `vi.fn(async () => undefined)` |
|---|---|---|
| `mockClear()` | survives | survives |
| `mockReset()` | **stripped**, returns `undefined` | survives |
| `mockRestore()` | **stripped**, returns `undefined` | survives |
| `vi.restoreAllMocks()` | **stripped**, returns `undefined` | survives |

An implementation passed to `vi.fn` as its ARGUMENT is the mock's original
implementation, and all three resets fall back to it rather than past it. One
installed afterwards is just the current implementation, and reset throws it
away. `restoreAllMocks` does this to a plain `vi.fn`, not only to a
`vi.spyOn` — there is no "it only touches spies" escape.

The two behaviours compose exactly the way a test wants: a test's own
`vi.mocked(api.x).mockResolvedValue(…)` override is still undone by the
restore, and what it lands back on is the resolving default.

One trap in the measurement: after a restore, `getMockImplementation()`
returns `undefined` on the argument-form mock even though calling it still
runs the argument implementation. The fallback is held separately. Assert on
the call's return value, never on `getMockImplementation()`.

## The fix

`apiMock.ts` now builds each method as `vi.fn(async () => undefined)`. That is
the whole change; the defaults are now immune to all three resets, so no file
can lose them, whatever it does in `afterEach`.

This is the first of the three options this doc originally proposed, but not
in the shape it proposed them. "Re-apply the defaults in a shared `afterEach`"
is unnecessary — nothing needs re-applying if nothing can strip them — and it
would have been the weaker fix, since it only covers files that opt into the
shared hook. Option two (move the two files off `restoreAllMocks`) was left
alone: it fixes two files and not the next one.

`web/src/test/apimock.test.ts` is new and is the part that stops this coming
back. It mocks `api` through the helper, calls `vi.restoreAllMocks()` in
`afterEach`, and from the second test on asserts that an unstubbed method
still returns a promise and that the previous test's override is gone. Against
the old helper it fails on two of its three tests with `expected undefined to
be an instance of Promise`.

With the defaults surviving, the hand-written `reportErrorToServer` re-stubs
in `apperrors.test.tsx` and `errorboundary.test.tsx` were only working around
this bug and are removed, along with `errorboundary.test.tsx`'s `recorded`
fixture. Nothing read the resolved value: `componentDidCatch` does `void
api.reportErrorToServer(…).catch(…)` and discards the row. The one stub kept
is the `mockRejectedValue` in "does not report its own failed report", which
is the thing that test is about.

`npm run test:run -w web` exits 0 with no "Errors" line, `npm run typecheck -w
web` is clean.

## Since vitest 5: reset first, then restore

vitest 4 narrowed `vi.restoreAllMocks()` to spies made with `vi.spyOn`; a plain
`vi.fn` is no longer touched by it. Measured on vitest 5.0.3, a mock that
was given an override with `.mockReturnValue('override')`:

| | `vi.fn().mockReturnValue(…)` | `vi.fn(impl)` + override |
|---|---|---|
| `mockClear()` | survives | override survives |
| `mockReset()` | stripped | back to `impl` |
| `mockRestore()` | stripped | back to `impl` |
| `vi.restoreAllMocks()` | survives | **override survives** |
| `vi.resetAllMocks()` | stripped | back to `impl` |

The defaults are still safe — nothing strips an argument implementation — but
a restore no longer undoes a test's own override, so in `errorboundary.test.tsx`
the `mockRejectedValue` of "does not report its own failed report" would leak
into every later test. `apimock.test.ts`, `errorboundary.test.tsx` and
`errorlog.test.tsx` now call `vi.resetAllMocks()` before
`vi.restoreAllMocks()` in `afterEach`: the reset rolls the overrides back to
the defaults, the restore takes the `console.error` spies off. Together they do
what `restoreAllMocks` alone did on vitest 3.
