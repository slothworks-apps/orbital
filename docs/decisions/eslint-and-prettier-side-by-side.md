---
id: eslint-and-prettier-side-by-side
title: ESLint lints, Prettier formats, and neither runs the other
status: in-force
type: adr
tags:
  - tooling
  - lint
---

# ESLint lints, Prettier formats, and neither runs the other

The repository had no linter and no formatter. Adding both raises three
questions that are easy to answer badly, so they are answered here.

## One flat config at the root, not three

`eslint.config.js` in the root covers all three workspaces. The workspaces
differ only in their globals and their React rules, and those are blocks
inside the one file. Three configs would have to repeat the type-aware
setup and would drift apart the first time one of them was tuned.

`npx eslint` therefore runs from the root; there is no `lint` script in
`server/`, `web/` or `desktop/`.

The config ignores `.claude/` and `.worktrees/`. A git worktree under
either holds a second copy of the whole repository, and linting it reports
every problem twice.

## Prettier formats; it is not an ESLint rule

`eslint-config-prettier` is the last entry in the config, so ESLint's
formatting rules are off. Prettier runs on its own through
`npm run format`. The alternative — `eslint-plugin-prettier`, which
reports every formatting deviation as a lint error — was rejected: it
makes `npm run lint` output mostly whitespace complaints, which is how
people learn to stop reading lint output.

`.prettierrc` sets `semi: false`, which the codebase does not follow yet.
Formatting the repository was deliberately deferred, so `npm run format:check`
fails today. It becomes meaningful after one `npm run format` commit.

## Type-aware, minus the rules this codebase argues with

`typescript-eslint`'s `recommendedTypeChecked` is on: floating promises and
bad awaits are the class of bug worth a slower lint. Four groups are off,
each for a reason that is a property of this codebase rather than taste:

- **`no-explicit-any` and the `no-unsafe-*` family.** The server parses the
  CLI's undocumented transcript JSON. `any` at that boundary is the honest
  type, and the unsafe-* rules fire on every line that touches it.
- **The React Compiler rules** now shipped by `eslint-plugin-react-hooks`
  (`refs`, `immutability`, `purity`, `set-state-in-effect`). They assume a
  pure-render codebase. The map initialises refs lazily during render, holds
  an outgoing target while a panel animates out, and mutates three.js objects
  from a frame loop on purpose — 138 errors, none of them a bug.
  `rules-of-hooks`, `exhaustive-deps` and `set-state-in-render` stay on.
- **`unbound-method` in `web/`.** A store action read through a selector
  (`useOrbital((s) => s.load)`) trips it, and no store method uses `this`.
- **`require-yield`.** The model-catalog probe parks the CLI on stdin with an
  `async function*` that never yields, so no turn is billed.

## `eslint-plugin-react` is absent, and the disable comments it owned are gone

Five `// eslint-disable-next-line react/no-danger` and
`react/no-array-index-key` comments predated any lint setup. The plugin that
defines those rules does not yet support ESLint 10 (`npm i` fails on
`ERESOLVE`), and ESLint treats a directive naming an unknown rule as an
error. The comments were rewritten as plain comments, keeping the reasoning
and dropping the directive. Adding the plugin later is a small change:
register it and re-add the two rules.

## The adoption pass ended at zero errors

The first run reported 66 errors after the config was tuned; `--fix` took 45
of them (all `no-unnecessary-type-assertion`) and the remaining 21 were fixed
by hand. Two findings were bugs rather than noise:

- `no-base-to-string` on `String(block.name ?? '')` in the transcript parser.
  A tool name that arrived as an object would have reached the UI as the
  literal string `[object Object]`; it now reads as absent.
- `void-use-memo` on the map's simulation reconcile, a `useMemo` that returned
  nothing and was doing its work for the timing alone.

Three deliberate suppressions remain, each with the reason next to it:
`require-await` on `Runner.start` and `Runner.end` (`Promise<void>` is their
published shape, awaited by the routes) and `exhaustive-deps` on
`DetailPanel`'s draft reset. Note that `eslint-disable-next-line` covers only
the line immediately below it — a wrapped explanation on the directive's own
line silently disables nothing, which is how the pre-existing directives in
this repository had been failing.

## `eslint-plugin-react-refresh` is not installed

It reported eighteen files, all of them a component file that also exports a
constant or a helper. Tomin's position is that a component file may export
whatever it needs to as long as the component is what it is for; clearing the
rule would mean splitting those files, and it buys finer fast refresh and
nothing else. The plugin ships exactly one rule, so it was removed outright
rather than declared and switched off.
