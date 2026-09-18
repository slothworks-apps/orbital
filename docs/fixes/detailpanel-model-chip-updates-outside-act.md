---
id: detailpanel-model-chip-updates-outside-act
title: Nine DetailPanel model-chip tests update state outside act
status: done
type: fix
domain: web
related:
  - full-run-leaks-an-unmocked-patchsettings
tags:
  - tests
  - web
  - detail-panel
---
# Nine DetailPanel model-chip tests update state outside act

## What happened

`vitest run src/test/detail.test.tsx` printed nine copies of

```
An update to DetailPanel inside a test was not wrapped in act(...)
```

one for each test under `describe('DetailPanel model chip')`. Every test
still passed and the run still exited 0 — React logs this to `stderr` and
does not fail anything.

## What was actually settling

The lineage fetch, and nothing else.

`DetailPanel` has exactly one piece of async work at mount (`DetailPanel.tsx`,
the `lineageCache` effect): it calls `api.getSession(id)` and writes the
returned chain into component state.

```ts
api.getSession(id).then(({ lineage }) => {
  if (!cancelled) setLineageCache((cache) => ({ ...cache, [id]: lineage }))
})
```

Nothing else in the mounted tree is waiting on anything. The model catalog and
the session's resolved model — the obvious suspects, and the ones this doc
originally pointed at — are both read straight out of the store, which the
test seeds synchronously before rendering; `matchModel` and `contextWindowFor`
are pure. `Transcript` fetches nothing on mount, and `usePresence` resolves to
`entered` inside the same render pass.

`render()` runs the effect inside `act`, so `api.getSession` is *called* inside
it, but the mock's `.then` is queued as a microtask and that act scope has
already closed by the time it runs. The nine tests asserted synchronously and
returned, so the `setLineageCache` landed after the test had ended — outside
any act, hence the warning, and one render later than everything the test had
just asserted against.

Two tests in the same block never warned, and both say why:

- **`switches the model`** ends on `await waitFor(…)`. RTL runs `waitFor`
  inside an async `act`, which drains the microtask queue — so the lineage
  write happened to land inside act there, by accident of the assertion.
- **`closes the popover when the selected session changes underneath it`**
  renders `ModelSwitcher` directly, never `DetailPanel`, so no fetch is
  started at all.

Ten tests, minus those two, is nine. The same reasoning explains why the
`DetailPanel header` tests above were already quiet: every one of them opens
with `await waitFor(() => expect(api.getSession).toHaveBeenCalled())`.

## The fix

All ten model-chip tests mount through one shared helper, `renderDetail`, so
there was one place to change rather than nine. It is now `async` and awaits
the fetch the panel is waiting for before handing the tree back:

```ts
const result = render(<DetailPanel />)
await waitFor(() => expect(api.getSession).toHaveBeenCalledWith(session.id))
```

Its nine callers became `async` and `await` it. That is the whole change —
`DetailPanel.tsx` is untouched; the warning was the tests' fault, not the
panel's.

Deliberately *not* wrapping the `render` in `act(…)`: that spelling silences
the message while leaving the assertions where they were, one render early.
The helper's doc comment says so, so the next person does not shorten it back.

No assertion changed meaning. The fixture resolves `lineage: []`, and the
panel only draws lineage dots for a non-empty chain, so the settled tree is
DOM-identical to the one these tests used to pin — they now simply prove it
about the tree the panel finished with instead of one it was passing through.
The two lineage-dot tests in the header block already cover the rendered
chain, empty and non-empty.

## One left, elsewhere

`npm run test:run -w web` still prints a single copy of the same warning, from
`src/test/app.test.tsx > App: keyboard > Esc deselects the session once no
dialog is open` — same cause, a different file, and out of scope for this
change. It is exactly the tenth warning this doc was written about hiding.

`npx vitest run src/test/detail.test.tsx 2>&1 | grep -c "not wrapped in act"`
prints 0. `npm run test:run -w web` exits 0 with no "Errors" line (25 files,
686 tests), and `npm run typecheck -w web` is clean.

## The tenth, too

The one remaining copy in `app.test.tsx` — "Esc deselects the session once no
dialog is open" — was fixed in the same change rather than left as a follow-up.
Same cause exactly: the test sets `selectedId` directly, which mounts
`DetailPanel` and starts the lineage fetch, then asserts synchronously. It now
awaits `api.getSession` before pressing Escape. The test after it never warned
only because its own `waitFor(api.listProjects)` drains the same microtask by
accident, which is worth knowing the next time one of these appears quiet.

`npm run test:run -w web` now prints no copies of the warning at all. Leaving
exactly one standing would have rebuilt the thing this doc is about: a warning
nobody acts on, hiding the next one.
