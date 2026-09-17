---
id: toggle-switch-role-and-checkbox-generated-checkmark
title: Give Toggle an explicit switch role and move Checkbox's check mark to
  generated content
status: in-force
type: adr
related:
  - 2026-09-16-agent-model-design
tags:
  - accessibility
  - ui
---
# Give `Toggle` an explicit switch role and move `Checkbox`'s check mark to generated content

## The problem

Task 12 (Settings rows for canvas 4c) added a verbatim test —
`screen.getByRole('switch', { name: /Model name under planet label/ })` — and
a verbatim assertion — `screen.getByLabelText('Remember last model per
project')` — against `web/src/ui/Checkbox.tsx`'s two exports, `Toggle` and
`Checkbox`. Both failed against the components as they stood, for two
unrelated reasons that both trace back to the same file.

**`Toggle` had no explicit role.** It renders a bare
`<input type="checkbox">`; the browser's implicit role for that element is
`checkbox`, never `switch` — `aria-query`'s `elementRoleMap` has no native
element/attribute combination that maps to `switch` at all. It exists only as
a role you can assert explicitly. `Toggle`'s own doc comment already called
it "a themed on/off switch," so the component's accessible role had quietly
never matched what it claimed to be.

**`Checkbox`'s check mark leaked into `getByLabelText`'s match.** The visible
box was `<span aria-hidden>{checked ? '✓' : ''}</span>`, a sibling of the
label text inside the wrapping `<label>`. `aria-hidden` removes an element
from the *accessibility tree* — it does nothing to `element.textContent`.
`dom-testing-library`'s label-wrapping match
(`getLabelContent`/`getTextContent` in `label-helpers.js`) walks raw
`textContent`, not the accessible name, so a **checked** box's label text was
`"✓Remember last model per project"` — never an exact match against the
visible copy. This is real for any future `getByLabelText` call against a
checked `Checkbox`, not an artifact of this one test: `getByRole('checkbox',
{ name })` would have sidestepped it, because the accessible-name algorithm
*does* exclude `aria-hidden` content — but that alternative was rejected here
because it fixes the assertion, not the defect. The underlying mismatch
between what the DOM says (`textContent`) and what a user perceives (a bare
label, no check mark) would still be there for the next label-text query.

## What was decided

**`Toggle`'s input now carries `role="switch"`.** This is a correctness fix,
not new behavior — it makes the accessible role match what the component
already claimed to be. It is cross-cutting: every screen that renders a
`Toggle` now exposes it as a switch. The only place in the codebase that
queried a `Toggle` by role was `web/src/test/settings.test.tsx`'s
"confirm-before-clear" test, updated alongside this decision from
`getByRole('checkbox', …)` to `getByRole('switch', …)`. The other `Toggle`
call site, `TagsRules.tsx`'s per-rule enable switch, is queried in its tests
by `getByLabelText`, which is role-independent and unaffected.

**`Checkbox`'s check mark moved from a text child to CSS generated content**
(`after:content-['✓']` on the same `aria-hidden` box, rather than a `'✓'`
string in the JSX tree). Generated content never enters `textContent`, so it
cannot leak into a `textContent`-based match again, for this test or any
later one. Verified empirically: a real `vite build` emits
`.after\:content-\[\'✓\'\]:after{--tw-content:"✓";content:var(--tw-content)}`,
so the glyph still renders — this was not a silent Tailwind arbitrary-value
miss.

## What follows from it

A `Toggle` is queryable by `getByRole('switch', …)` anywhere in the app going
forward. A `Checkbox`'s visible label text is exactly its `label` prop's
text — checked or not — for any query that reads `textContent`, not just the
accessible-name algorithm.
