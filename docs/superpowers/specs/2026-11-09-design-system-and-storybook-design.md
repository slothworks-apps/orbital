---
id: 2026-11-09-design-system-and-storybook-design
title: Design system — a Storybook catalogue of the UI primitives, and the real components inside the design canvas
type: spec
status: active
domain: web
related:
  - 2026-10-29-colour-tokens-design
tags:
  - web
  - design
---

# Design system and Storybook

Orbital already has most of a design system, without a name for it: the
tokens in `web/src/theme.css` (every chrome colour, overridden by a colour
theme, see [[2026-10-29-colour-tokens-design]]) and about fifty primitives in
`web/src/ui` (`Button`, `Select`, `Dialog`, `Menu`, `Panel`, `Badge`,
`Tooltip`…). What it lacks:

- **A catalogue.** A primitive's variants and states can only be seen by
  finding a screen that happens to use them. `web/src/sandbox` is a
  workbench for planet transitions, not a catalogue.
- **Usage notes.** When to reach for `Chip` over `Badge`, or `UtilityButton`
  over `Button`, lives in the heads of whoever wrote them.
- **A way back into the design.** A feature is drawn in the canvas from
  lookalikes, then rebuilt from the primitives, then checked against the
  canvas by hand. The drawing and the code drift apart, and every fidelity
  pass pays for it.

The goal is that every new feature is designed from and built from the same
components.

## 1. Prior art: Questo

`slothworks/questo` does this in the opposite direction. Its design system was
drawn first, as the Claude Design project "Questo Design System"; the `ui`
workspace is a React port of it (tokens, CSS and components 1:1, a
`.stories.tsx` and a `.md` of usage notes per component). `.ds-sync` then
builds a bundle from that Storybook (a JS and CSS bundle, a screenshot and a
prompt per component) and uploads it back to Claude Design, so new screens
are composed there from the components the apps ship.

Orbital's code exists already, so it starts from the code: Storybook over
`web/src/ui`, and the bundle from that.

## 2. What gets built

### Phase 1 — the catalogue

- Storybook (`@storybook/react-vite`, the version Questo uses) inside the
  `web` workspace, reusing its Vite and Tailwind config. No new workspace: a
  separate package earns its place only once something other than `web` and
  `site` (which already imports from `web/src`) needs the primitives.
- One `<Name>.stories.tsx` next to each primitive in `web/src/ui`, titled
  `UI/<Name>`, showing its variants and states. Panels from `web/src/panels`
  follow as `Panels/<Name>` where they render without the store or a server.
- A toolbar switch for the colour theme (Deep Field, Albedo and the rest of
  `COLOUR_THEMES`), applied with the app's own `applyColourTheme`, so every
  story is seen in each. The map theme (Planets, Desk) changes how the map is
  drawn, not the primitives, so it has no switch.
- A short `<Name>.md` next to a primitive only where the choice between it and
  a neighbour is not obvious. Not a page per component by reflex.
- `npm run storybook -w web`; a step of the `check (web)` CI job builds it, so a story
  broken by a refactor fails the PR.
- The rule in `web/CLAUDE.md`: a new primitive, or a new variant of one, comes
  with its story; a feature uses the primitives in the catalogue and adds to
  them rather than styling its own.

The map (react-three-fiber) stays out: it needs a canvas, a camera and live
layout, and `web/src/sandbox` already serves it.

### Phase 2 — the components inside the design canvas

Build the bundle from the Storybook and make it available to the canvas, so a
new artboard is composed from the real `Button`, `Select` and `Panel`.

This is blocked on one question, which Phase 1 does not depend on: Questo's
`.ds-sync` uploads through Claude Design's design-system sync, and the
Orbital canvas has moved to a claude.ai artifact (standalone Claude Design
closes 2026-12-14). Whether an artifact can take a design-system bundle, and
how, is not known yet. Find that out before porting `.ds-sync`; if artifacts
cannot take one, Phase 2 ends at a written finding and the catalogue stands
alone.

## 3. Tests

No tests for the stories themselves and no visual snapshots: they would pin
styling values (root `CLAUDE.md` → Tests). The CI build is the check that the
stories still render. Behaviour tests of the primitives stay where they are.

## 4. Scope

- **For whom:** whoever builds and designs Orbital — the maintainer and the
  agents working on it. Nobody using the app.
- **Where it lives:** a dev tool in the `web` workspace; nothing ships in the
  DMG, the relay image or the phone bundle.
- **What someone using Orbital notices after updating:** nothing.
- **What can be set:** nothing.

No version bump and no changelog line: nothing that ships changes.

## 5. Phone

Left out on purpose: the catalogue changes nothing the phone runs. The phone
screens under `web/src/mobile` use the same primitives, so they gain from the
catalogue without work. Stories for the phone-only components
(`web/src/mobile`) at a phone viewport are worth adding once Phase 1 stands.

## 6. Open questions

- Can a claude.ai artifact take a design-system bundle (Phase 2)?
- Which panels render without the store; do the rest need a small fixture
  store, or are they left out?
