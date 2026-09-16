<!-- atlas:begin 2026-09-16 -->
# Documentation in orbital

Every markdown file under `docs/` carries atlas frontmatter. A file
without it fails `atlas validate`, which runs in the PR gate.

`CLAUDE.md` and `AGENTS.md` are the exception. They are instructions for a tool,
not documents, and `atlas validate` skips them.

## Write the document, do not just answer

Writing these documents is part of the work, not extra work. Do not wait to be
asked for one. When the middle column below matches what just happened, write
the document in the same change, before you report the work as done. An answer
that lives only in the chat is gone when the session ends.

Check first whether the document already exists, and update that one instead of
writing a second.

## Which document, and where it goes

Never pick a path yourself. Each type has one directory:

| type | write one when | directory |
|---|---|---|
| `adr` | you chose one way over another, or ruled one out | `decisions` |
| `spec` | you agreed how something should work before it is built | `superpowers/specs` |
| `plan` | the work needs more than a few steps | `superpowers/plans` |
| `idea` | something is worth doing and nobody has picked it up | `ideas` |
| `fix` | you found a bug you are not fixing now | `fixes` |
| `chore` | a small maintenance job is waiting | `chores` |
| `domain` | you worked out how a part of the product behaves today | `domains` |
| `audit` | you reviewed something that already exists | `audits` |
| `runbook` | you worked out the steps to run or repair something | `ops` |
| `reference` | you collected facts that stay true | `.` |
| `session` | you want the record of one working session | `sessions` |

Paths are relative to `docs/`.

## Frontmatter

```yaml
---
id: my-document          # lowercase slug, same as the file name
title: My document       # one line, plain
type: plan               # see the table above
status: active           # see the list below
domain: billing          # optional, the part of the product this is about
related:                 # optional, ids of other documents
  - another-document
tags:                    # optional
  - onboarding
---
```

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
