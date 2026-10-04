# UI conventions (web)

Rules for everything under `web/src`. Add to this file as conventions get
decided — one short section per rule, with the reason, because a rule
without a reason gets "optimised" away by the next person.

## No native form popups

**Never use `<select>`, and never build a control on top of one.** That
includes reaching for a bare `<select>` inside a panel because the shared
component felt like a detour.

The native popup is drawn by the OS. It ignores the app's typography,
spacing, colours and dark theme, it cannot be animated, and it looks
different on every platform — so one native control is enough to make a
carefully matched screen look unfinished. This is a standing instruction
from Tomin, not a per-case judgement call.

Use `ui/Select`, which owns the custom listbox. If it is missing something
you need, extend it — do not work around it locally.

A custom control has to earn the native one's behaviour back where it
matters: correct `role`/`aria-*` wiring, closing on outside click and on
Escape, and moving through the options with the arrow keys (with Enter,
Home/End and type-ahead alongside). Arrow navigation in a dropdown is
wanted — it is the exception to the next section.

## Keyboard-only operation is nice to have, not a requirement

Orbital is a local tool its owner drives with a mouse and a handful of
shortcuts. Being able to do *everything* from the keyboard — Tab order,
focus landing in the right field and returning where it came from, arrow
keys and type-ahead in lists, Escape peeling one layer at a time — is
welcome when it comes cheap, but never a condition for a change being done,
and not a reason to reject a design.

So do not add tests for it. A test that pins focus management or keyboard
navigation of something that is operated with the mouse fails for timing
reasons in jsdom far more often than for a real regression; such tests were
removed on 2026-09-28.

This is about keyboard-*only* operation. The keyboard as an input the owner
actually uses is a feature and stays tested: app shortcuts, ⏎ / ⇧⏎ in the
composer, the composer's completion list, Escape closing a dialog or panel,
and arrow navigation in dropdowns — `ui/Select` and the menus.

## Page zoom is disabled, deliberately

Pinch is the space map's gesture; the browser zooming the document underneath
it makes the map unusable. So `index.html` ships `user-scalable=no`, and
`main.tsx` swallows `ctrl`+wheel (how a trackpad pinch arrives on desktop).

This is a real accessibility trade-off — browser zoom is how low-vision users
read text (WCAG 1.4.4). Tomin accepted it for a tool he runs locally and does
not distribute. **Revisit it before this ships to anyone else**, and prefer
scoping the gesture to the map surface over disabling zoom document-wide.

Note for anyone adding wheel handling: React attaches `wheel` (and
`touchstart`/`touchmove`) as PASSIVE listeners, so `preventDefault()` inside
an `onWheel` prop silently does nothing. Attach manually with
`{ passive: false }`.

## Design values come from the canvas, never from the eye

`Orbital.dc.html` carries literal inline CSS for every artboard. Read the
value out of it — paddings, radii, sizes, durations, easings, colours.
"Looks about right" drifts, and the drift compounds across screens.

Fetch it through the `DesignSync` MCP; the root `CLAUDE.md` has the project id
and the details. **Never read an export committed under `design/`** — new
artboards get added to the canvas and the export is not regenerated, so it is
both stale and missing whole sections.

When a value comes from an artboard, name the artboard in the comment (`canvas
2b`, `artboard 1f`) so the next person can find the source rather than
re-deriving it.

Colours in the export are `oklch(...)`. Where a literal is needed (Tailwind
alpha modifiers, three.js materials), precompute the sRGB value and note the
oklch source next to it, the way `theme.css` does.

## `className` on a UI primitive is layout-only

`Button`, `Panel`, `Input`, `Select` and friends take `className` for
placement — margin, grid area, width. Never to override fill, border,
radius or typography. A variant that does not exist yet should be added to
the component as a variant, so every caller gets it and it stays testable.

## Tailwind v4 footguns

- A **decimal** arbitrary opacity modifier silently emits nothing:
  `bg-accent/[0.06]` produces no rule at all, `bg-accent/6` works. Nothing
  warns you — it just renders untinted.
- Same-property utilities are resolved by stylesheet order, not by the order
  they appear in the `class` string. Two sources both setting a radius (a
  variant and a size, say) pick a winner arbitrarily — resolve it in the
  component instead of concatenating both.
- A background with both an image and a colour cannot go in one arbitrary
  value: `bg-[linear-gradient(…),#070b16]` is emitted as `background-color`
  and is invalid, so the element has no fill at all. Split it into
  `bg-[#070b16] bg-[image:linear-gradient(…)]`.
- Tests do not compile CSS. After introducing an unusual utility, confirm it
  is actually emitted by a real `vite build`.

## A `<span>` does not have a size

`display: inline` ignores width and height. A sized box that "works" today
may only be working because it happens to be a flex item — wrap it in
anything else and it collapses. Give sized elements their own `block` /
`inline-block` / `flex` / `grid`. jsdom measures nothing, so no unit test
will catch this; only the browser will.

## An overlay dies inside an `overflow: hidden`

Tooltips, popovers and dropdowns are positioned outside the box they hang
off. Any ancestor between the overlay and the panel that clips its overflow
cuts the overlay away — and the row underneath goes on looking perfectly
correct, so the only symptom is that hovering does nothing.

Before adding `overflow-hidden` to a row, ask what hangs off it. Put the clip
on the specific child that can outgrow its share — usually the one piece of
elastic text — rather than on the whole row.

jsdom lays nothing out and clips nothing, so a unit test will happily assert
that the overlay is in the DOM while the real app shows empty space. Verify
an overlay in a real browser, and guard the invariant structurally: assert
that no ancestor of the overlay carries the clip.

## Version

`web/` has no version of its own. A fix or a feature here bumps `version`
in `desktop/package.json`, since the DMG bundles the web app; one that
reaches `web/src/mobile` (or a component it imports) bumps the Android
app's `versionName` in `mobile/android/app/build.gradle` too. Propose
patch, minor or major and ask, as the root `CLAUDE.md` → Versions says.
