---
id: web-composer-intake-test-fails-on-main
title: web composerintake test raises an unhandled error and fails the root test run
status: done
type: fix
domain: web
tags:
  - web
  - tests
  - flaky
---
# web composerintake test raises an unhandled error and fails the root test run

## What happens

`web/src/test/composerintake.test.tsx` passes all 28 of its own
assertions but leaves one unhandled exception behind, which vitest
counts as a failure for the file. A root `npm run test` therefore exits
non-zero even though nothing in this test actually failed:

```
⎯⎯⎯⎯⎯ Uncaught Exception ⎯⎯⎯⎯⎯
TypeError: clipboardData.getData is not a function
 ❯ getText ../node_modules/prosemirror-view/dist/index.js:3787:30
 ❯ editHandlers.paste ../node_modules/prosemirror-view/dist/index.js:3803:31
...
 Test Files  1 passed (1)
      Tests  28 passed (28)
     Errors  1 error
```

The error is attributed to "ignores a paste that carries no image at all
— that is just text", but the message notes it may have been thrown
after that test completed — it is an unhandled exception, not a thrown
assertion, so vitest can only report where it landed, not necessarily
where it originated.

Reproduce with:

```bash
npm run test:run -w web -- composerintake
```

## Why, as far as this looked

ProseMirror's paste handler calls `clipboardData.getData(...)`. The test
fires a paste event whose `clipboardData` is a plain object good enough
for the test's own assertions (it reads `files` / `items`), but it is
not a real `DataTransfer` and has no `getData` method. jsdom does not
implement `DataTransfer.getData` either, so the usual browser stub would
not help without some polyfill or a more complete fake.

## Not investigated

Which exact paste fixture is missing `getData`, and whether the right
fix is a fuller `DataTransfer` fake in the test's harness or catching
this at the ProseMirror integration layer. Left for whoever picks this
up.

## Why not fixed now

This branch (`2026-10-01-mobile-remote-backend`) does not touch `web/`
at all — the failure is pre-existing on `main`, just surfaced here
because the task ran the full root `npm run test` as part of closing out
the branch.

## Fixed

`e49d4a34` gave the test's fake clipboard data a `getData`, which
ProseMirror's paste handler calls. The file now passes with no unhandled
error.
