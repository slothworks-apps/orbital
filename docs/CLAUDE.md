<!-- atlas:begin 2026-09-11 -->
# Documentation in orbital

Every markdown file under `docs/` carries atlas frontmatter. A file
without it fails `atlas validate`, which runs in the PR gate.

`CLAUDE.md` and `AGENTS.md` are the exception. They are instructions for a tool,
not documents, and `atlas validate` skips them.

## Frontmatter

```yaml
---
id: my-document          # lowercase slug, same as the file name
title: My document       # one line, plain
type: plan               # see the table below
status: active           # see the list below
domain: billing          # optional, the part of the product this is about
related:                 # optional, ids of other documents
  - another-document
tags:                    # optional
  - onboarding
---
```

## Where a document goes

Never pick a path yourself. Each type has one directory:

| type | directory |
|---|---|
| `adr` | `decisions` |
| `spec` | `superpowers/specs` |
| `plan` | `superpowers/plans` |
| `idea` | `ideas` |
| `fix` | `fixes` |
| `chore` | `chores` |
| `domain` | `domains` |
| `audit` | `audits` |
| `runbook` | `ops` |
| `reference` | `.` |
| `session` | `sessions` |

Paths are relative to `docs/`.

## Statuses

- `backlog`
- `draft`
- `active`
- `blocked`
- `done`
- `superseded`
- `archived`

A document starts at `draft` or `backlog`, moves to `active` while it is being
worked on, and ends at `done`, `superseded` or `archived`. Do not delete a
document that is finished. Set its status.

## Before you commit

```bash
atlas validate
```

It reports every document whose frontmatter is missing or wrong.
<!-- atlas:end -->
