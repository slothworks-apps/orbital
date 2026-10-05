# Contributing to Orbital

Bug reports and ideas are welcome — open an issue.

Pull requests:

- **Small fixes** — a bug, a typo, a broken edge case — go straight to a PR.
- **Anything bigger** — a feature, a new setting, a change to how something
  looks or behaves — starts as an issue. Wait for a yes before you write the
  code. The visual design is maintained outside this repository, and every
  feature is weighed against [`docs/why-orbital.md`](docs/why-orbital.md), so
  a change that is fine as code can still be the wrong change.

Two things that will be declined, so you do not spend time on them:

- **Driving terminal sessions.** Orbital shows sessions you run in a terminal
  read-only, on purpose. Features may exist only for the sessions Orbital
  starts itself.
- **Anything that pulls for attention** — blinking, alarm colours, sound or
  badges that are on before the user chose them. `docs/why-orbital.md` says
  why.

## Setting up

The README covers the prerequisites (Node.js 24+, the Claude Code CLI logged
in), installing and running. In short:

```bash
npm install
npm run dev
```

`npm install` also points git at the hooks in `.githooks/`: no commit or push
straight to `main`, no AI attribution in a commit message, and every commit
is scanned by
[gitleaks](https://github.com/gitleaks/gitleaks) first (`brew install
gitleaks`; without it the hook warns and lets the commit through). Made-up
secrets that tests need are allowed by value in `.gitleaks.toml`.

## Before you open a PR

```bash
npm run typecheck
npm run lint
npm test
```

CI runs the same checks and `atlas validate` on every PR.

**Tests.** Add one where it can catch a real regression — parsing, path and
URL handling, server routes, persistence, logic that is hard to eyeball. Do
not test that a component renders its props or that a style has a given
value. A server test that needs a temporary directory or database takes it
from `server/test/tmp.ts` (`makeTmpDir`, `openTmpDb`), never from
`mkdtempSync` directly: those are removed after the test, and a bare
`mkdtemp` is left in `$TMPDIR` on every run.

**Documents.** Decisions, specs and known bugs are written down in `docs/`,
and every file there has frontmatter. [`docs/CLAUDE.md`](docs/CLAUDE.md) has
the rules, including which kind of document goes where. If your PR makes a
decision worth recording, add the document in the same PR. To check the
frontmatter locally (needs [bun](https://bun.sh)):

```bash
bunx @slothworks/atlas validate
```

**Commits** follow the style already in the history: `feat(web): …`,
`fix(server): …`, `docs: …`.

## Working with an AI agent

`CLAUDE.md` holds the instructions Claude Code reads in this repository. It
is written for agents, but it is also the shortest summary of how the
project is run.
