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

A custom control has to earn the native one's behaviour back, so whatever
lands in `ui/Select` must keep: full keyboard operation (arrows, Home/End,
Enter/Escape, type-ahead), correct `role`/`aria-*` wiring, focus returning
to the trigger on close, and closing on outside click and on Escape. A
prettier control that a keyboard user cannot operate is a regression, not
a fix.

## Design values come from the export, never from the eye

`design/Orbital_ celestial agent dashboard/Orbital.dc.html` carries literal
inline CSS for every artboard. Read the value out of it — paddings, radii,
sizes, durations, easings, colours. "Looks about right" drifts, and the
drift compounds across screens.

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
- Tests do not compile CSS. After introducing an unusual utility, confirm it
  is actually emitted by a real `vite build`.

## A `<span>` does not have a size

`display: inline` ignores width and height. A sized box that "works" today
may only be working because it happens to be a flex item — wrap it in
anything else and it collapses. Give sized elements their own `block` /
`inline-block` / `flex` / `grid`. jsdom measures nothing, so no unit test
will catch this; only the browser will.
