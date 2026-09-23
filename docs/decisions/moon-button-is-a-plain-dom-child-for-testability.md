---
id: moon-button-is-a-plain-dom-child-for-testability
title: The moon's interactive layer is a store-free DOM child, not JSX inlined into Moon
type: adr
status: in-force
domain: subagents
related:
  - 2026-09-22-subagent-transcript-panel-design
  - counter-zoom-inflates-the-whole-moon-system
  - separation-follows-the-counter-zoom-curve
tags:
  - web
  - map
  - subagents
  - testing
---

# The moon's interactive layer is a store-free DOM child, not JSX inlined into `Moon`

## The problem

Task 9 (`.superpowers/sdd/2026-09-22-subagent-transcript-panel-design/task-9-brief.md`)
turns openable moons into buttons and asks for tests: clicking an openable
moon calls `openSubagent`, an inert moon (no `toolUseId`) takes no pointer
and no tab stop, the active moon renders corner brackets/ring/tether, and
`↵`/`⎋` behave.

The natural first attempt is a `<Html>` block inlined into `Moon.tsx`
(`web/src/map/Moon.tsx`), the same way `Planet.tsx`'s `CompactBadge` and
`StatePill` already do it — real DOM elements portalled into the page by
drei's `<Html>`.

That block cannot be exercised by this repo's test suite at all. Confirmed
empirically: a scratch test rendering `<Canvas><Html center><button
aria-label="scratch button">hi</button></Html></Canvas>` under
`web/src/test/setup.ts`'s jsdom environment produces a `<canvas>` element and
NOTHING else — no button, no accessible role, nothing `screen.getByRole`
can find. `web/vitest.config.ts` installs no WebGL mock (no
`jest-canvas-mock`, no `vitest-webgl-canvas`, no `@react-three/test-renderer`
dependency at all), so `HTMLCanvasElement.getContext('webgl2')` returns
`null` in jsdom, `Canvas` never reaches the point where it mounts its
children into the fiber tree, and `<Html>`'s portal never fires. This is not
new to task 9: it is why NO existing test in this repo ever queries
`CompactBadge`, `StatePill`, or the `Hole`'s own `<Html center>` "N
sessions · click to browse" label — every one of `spacemap.test.tsx`'s
`describe('SpaceMap ...')` blocks that click a real button does so on a DOM
overlay rendered OUTSIDE `<Canvas>` (the zoom controls, the aggregate
readout), never on portalled content inside it.

## What was decided

The interactive layer — the hit-area button, the hover halo, the active
brackets/ring/tether, the hover label — is its own exported component,
`MoonControl` (`web/src/map/Moon.tsx`), with no `@react-three/fiber` or
`three` imports of its own. `Moon` decides WHETHER to mount it (`openable`,
from a new pure `moonInteraction` function, also exported) and wraps it in
`<Html center>` purely for 3D positioning; `MoonControl` itself is plain
React + DOM, renderable with a bare `render(<MoonControl ... />)` — no
`<Canvas>`, no WebGL, no drei.

### Corrected: the affordance is sized in DESIGN px and scaled per frame

The first version of this file argued the layer could be "sized in CSS px
because the moon's apparent screen size is already held constant by the
parent group's counter-zoom (`bodyZoomFactor`)". **That premise is false**,
and this repo's own
[[counter-zoom-inflates-the-whole-moon-system]] says so in its first
sentence: `bodyZoomFactor` is `clamp((60 / zoom) ** 0.5, 1, FACTOR_MAX)` —
one-sided, clamped to 1 from below. It slows the shrink on the way out and
does *nothing at all* at or above the default zoom, where a body's screen
size grows linearly with `zoom`. Nothing anywhere holds a moon's apparent
size constant.

The arithmetic, now stated once in `bodyDesignPxToScreenPx` (`camera.ts`)
and unit-tested: one design px of a body is
`bodyZoomFactor(zoom) * bodyScale * zoom / 100` CSS px. Over the map's
5–400 zoom range that spans roughly 0.17 to 4.0 — a 23× swing. A `working`
moon (13 design-px radius) draws about 2 CSS px across at zoom 5, 16 at the
default 60 and 104 at 400, against an affordance that was always 40 px with
brackets always 19 px out. Zoomed out, a 40 px button surrounded a 4 px dot
and swallowed the map's own drag pointerdowns; zoomed in, the halo and
brackets sat INSIDE the disc they were supposed to ring.

So `MoonControl` takes a `scale` prop — design px → CSS px, defaulting to 1
so a bare `render()` still draws the canvas's own geometry — and multiplies
every offset by it. `Moon`'s frame loop computes it from the live camera and
pushes it through React state only when it moves by more than 1%, so an
eased zoom costs a bounded handful of re-renders per moon rather than one
per frame. The hit area alone is floored at 22 CSS px (`UtilityButton`'s
smallest box), because a faithfully-scaled 40 design-px target is 7 px at
the bottom of the range — smaller than the pointer using it. The
decorations are not floored: they describe the moon, and a halo that refused
to shrink would sit visibly off the thing it rings.

**This was reasoned from the camera maths, not seen.** There is no browser
tooling in the environment it was fixed in. What is verified is the
arithmetic (`bodyDesignPxToScreenPx` against `bodyZoomFactor` and the 0.01
units-per-design-px conversion in `visuals.ts`) and the proportionality it
gives `MoonControl`; what is not verified is how any of it looks.

`web/src/test/moon.test.tsx` renders `MoonControl` directly and asserts the
real things: `userEvent.click` calls `onOpen`, `userEvent.tab()` +
`{Enter}` opens it (the native `<button>` contract — no key handler needed),
hovering shows the halo ring and the task label and mirrors the change
outward via `onHoverChange`, and the `active` prop toggles the four corner
brackets, the accent ring and the dashed tether. `moonInteraction` itself is
tested as a pure function: openable+toolUseId, inert+no-toolUseId (pinned to
`effectiveState: 'ended'` even while genuinely `working` — the brief's own
named trap), and unwired (sandbox fixtures with no `toolUseId` must render
exactly as before this task, not as INERT).

## What was rejected

**Adding a WebGL mock (`jest-canvas-mock`, `vitest-webgl-canvas`,
`@react-three/test-renderer`) to make `<Canvas>` mount for real under
jsdom.** Would have let `Moon` itself be tested end-to-end, including the
`openable`/`active` wiring this ADR's split still leaves untested at the
`Moon` level. Rejected as a new dependency and a change to shared test
infrastructure for one task, when the actual thing worth testing — the
interaction logic — does not need a 3D scene at all once it is factored out
of one.

**Testing only through `SpaceMap`**, the way `Planet`'s own click-to-select
(`handleSelect`) is — which is to say, not tested via simulated pointer
interaction at all; `buildSceneModel`'s pure derivation is the only coverage
`Planet` selection has ever had in this repo. Consistent with that
precedent, but it would have left every one of the brief's explicitly
requested behavioural tests (click, inert, active, `↵`) unwritten, which the
brief does not accept.

**A ref-callback or portal-less positioning trick to make the button
observable without `<Html>`.** Solves the wrong problem: `<Html>` itself
mounting is not what needed fixing — the CONTENT inside it does not care
whether it is ever actually positioned in 3D space to be clickable,
focusable and correctly labelled. Splitting the content out is strictly
simpler than making the positioning layer testable.

**Moving the rings, brackets and tether into three.js and keeping only the
button in DOM** — which is what `Planet.tsx` already does for its own
selection brackets (three.js `Line`s, which scale correctly for free), and
which would end the split idiom between two sibling components. Rejected
for this pass, not on the merits: it is a rewrite of four animated
decorations into materials and crossfades, in a repo where none of it can be
rendered under jsdom and there is no browser available to look at the
result. Scaling the existing DOM is the change whose correctness can be
argued from the maths alone. The idiom split survives, and is worth
revisiting the next time the moon's visuals are opened on purpose.

**Writing the scale straight onto the DOM node from the frame loop** (a CSS
custom property, or `style.width` through a ref), avoiding React re-renders
entirely. Faster, and it would keep `MoonControl` free of a prop that only
`Moon` can supply — but it would put the geometry in two places, half of it
unreachable from `render(<MoonControl …/>)`, which is the thing this whole
ADR exists to protect. The 1% quantisation buys back most of the cost.

## Consequences

- `Moon`'s own gating (`openable && <Html>...`) and the exact
  `onOpen={() => onOpen?.(sessionId, subagent)}` binding stay untested by
  automated means, same as `Planet`'s `onClick={onClick ? handleClick :
  undefined}` always has been — trusted as glue, verified by inspection and
  in the browser (the `/sandbox` route, or the real map).
- Any future moon-adjacent interactive affordance (a right-click menu, a
  second control) should default to the same shape: a plain-DOM child
  component, mounted conditionally by `Moon`, tested directly and never
  through a rendered `<Canvas>` — **and it must take a `scale`, not fixed
  CSS px.** An earlier version of this line told the next reader to "default
  to the same shape" while that shape included the sizing bug; anything
  drawn in DOM on top of a body has to be converted through
  `bodyDesignPxToScreenPx`, because `<Html>` inherits no world scale and the
  body it decorates changes size by 23× across the zoom range.
- Text is the exception and the reason the mistake was plausible:
  `StatePill` and `CompactBadge` are LABELS, and a label legitimately holds
  a constant screen size. `MoonControl`'s own hover label keeps fixed
  typography for the same reason; only its OFFSET scales. Geometry that
  describes a body must track the body; type that names one must not.
- If this repo ever adds a real WebGL mock for other reasons, `Moon`-level
  wiring tests become straightforward to add on top of — nothing here
  forecloses that, it just does not spend this task's budget building it.
