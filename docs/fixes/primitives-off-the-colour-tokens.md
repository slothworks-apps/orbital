---
id: primitives-off-the-colour-tokens
title: UI primitives and panels that miss the colour tokens or read poorly in a light theme
type: fix
status: backlog
domain: web
related:
  - 2026-11-09-design-system-and-storybook-design
  - 2026-10-29-colour-tokens-design
tags:
  - web
  - theme
---

# UI primitives and panels that miss the colour tokens or read poorly in a light theme

Found while writing the first stories for `web/src/ui` and `web/src/panels`
and paging through them in each colour theme. None of them is fixed yet.

## Literal colours no theme can reach

`web/CLAUDE.md` → Colours are tokens, never literals. These stay the same colour
in Albedo and Solar Light:

- `Button.tsx`, the `danger` variant: `text-red-400`, `border-red-400/40`,
  `hover:bg-red-400/10`. `danger-soft` beside it already uses `danger-pale`.
- `Input.tsx`, the invalid state: `ring-red-400/70`, `border-red-400/60`.
- `CustomModelField.tsx`, the error line: `text-red-300`.
- `Badge.tsx`, FAILED: fixed-lightness `oklch(72% .17 25 …)` and
  `oklch(78% .16 25)`. In Albedo it is pale red on pale red and barely
  readable.
- `FeedbackNotice.tsx`, the failure dot: `bg-[oklch(66%_.2_25)]`.
- `StopDialog.tsx`, the running label: `text-amber-400`, yellow on a
  near-white panel in Albedo. `RewindDialog` uses `text-warning` for the same.
- `lib/diff.ts`, `DIFF_REMOVED_INK_CLASS`: `text-[oklch(72%_.15_22)]`.
- `McpjsonQuestion.tsx` and `CompactionMark.tsx` (`FAILED_RULE`,
  `FAILED_BORDER`): literal oklch. They still read in Albedo.

Each goes to the nearest token: a red to `danger`, the way `Select`'s branch
variant already shows an error with `danger-pale`; an amber to `warning`.

## Code stays dark in a light theme

`lib/highlight.ts` fixes Shiki to `github-dark-default`. In Albedo the
tokens of a diff (`DiffView`, an Edit in `PermissionCard` and `ToolRow`)
nearly vanish into the light band, and the diff's line inks
(`text-ink-50`, `text-ink-900/56`) come out near-white. `MessageView`'s code
blocks stay a dark block, which may be meant; the diff is not.

## Weak in a light theme, or in every theme

- `Checkbox.tsx`: the unchecked default box, and an off `Toggle`'s track,
  are close to invisible in Albedo.
- `Input.tsx`: a disabled field looks exactly like an enabled one.
- `Select.tsx`: the chip, ghost, branch, device, model, tag and pill
  triggers have no `focus:outline-none`, so a focused trigger shows the
  browser's blue outline; the field and swatch triggers suppress it.
- `Select.tsx`: the placeholder is drawn in the same ink as a chosen value.
- `MediaParts.tsx`: the gallery time in `text-ink-500/60` over a PDF's white
  first page is hard to read in Deep Field.

## Unused

- `StatusDot.tsx` is imported nowhere; every state surface draws `StateDot`.
  Delete it.

## How to check a fix

`npm run storybook -w web`, the story of the primitive, and the Colours
switch in the toolbar.
