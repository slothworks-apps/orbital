---
id: 2026-10-01-going-public
title: Going public — what is left before the repository's visibility flips
status: active
type: plan
related:
  - orbital-is-mit-licensed
tags:
  - release
---
# Going public — what is left before the repository's visibility flips

`slothworks-apps/orbital` is private and is going to be made public. Done on
2026-10-01:

- `LICENSE` (MIT, SlothWorks s.r.o.) and `"license"` in the root `package.json`.
- The Claude Design section moved from `CLAUDE.md` to the git-ignored
  `CLAUDE.local.md`; it only works with the maintainer's Claude Design account.
- Names the maintainer does not want published removed from the working
  tree (docs and tests now say `acme`).
- `gitleaks git` over the whole history: two findings, both the RFC 6455
  sample WebSocket key in `server/test/security.test.ts`. No real secrets.

## 1. Rewrite the history

Two things are still in every past commit, and only a rewrite removes them:

- The removed names are still in older commits.
- Every commit's author is the maintainer's personal e-mail. Replace it with
  the GitHub `…@users.noreply.github.com` address, and set that address in
  the repository's git config so new commits use it too.

What to replace with what is deliberately not written here: anything
committed would put it back into the history the rewrite cleans. The inputs
live untracked in the main checkout's `.git/going-public/`, all filled in
on 2026-10-04:

- `replacements.txt` for `--replace-text` — the removed names, and the
  maintainer's e-mail, which a recorded CLI transcript in
  `server/test/fixtures/` carries in its session context.
- `messages.txt` for `--replace-message` — `--replace-text` does not touch
  commit messages, and squash merges carry a contributor's personal e-mail
  in their `Co-authored-by:` trailer.
- `mailmap` for `--mailmap` — both authors' personal addresses mapped to
  their GitHub noreply addresses.

A dry run on a `git clone --no-local` copy in `/tmp` came out clean: only
noreply addresses as authors and no removed term in files or messages.

`ergaily` and the `/Users/tomin/...` paths in tests and docs stay; they are
fine to publish.

Do it in one `git filter-repo` pass (`brew install git-filter-repo`) with
those three files, right before the visibility flips. Every commit hash
changes, so the rewrite needs a force push, and every other branch and
worktree stops sharing history with `main`. Finish or drop open branches and
worktrees first, and make sure no other session is working in the checkout.
Afterwards, confirm with `git log --all -S <each replaced term> -i` and
`git log --all --format=%ae | sort -u`.

Write the commit messages of this work without the removed names too —
`--replace-text` rewrites file contents, not messages.

**Done 2026-10-04.** A force push alone would not have been enough:
GitHub keeps `refs/pull/<n>/head` of every pull request pointing at the old
commits, they stay fetchable and browsable once the repository is public,
and only GitHub Support can delete them. Archiving the pull requests hides
them from the list but leaves the refs. So the old repository was renamed
to `slothworks-apps/orbital-private` and stays private, and the rewritten
`main` went into a new, empty `slothworks-apps/orbital` — no pull requests,
no tags. Releases, the Actions secrets of `release-mac.yml` and the GHCR
package's Actions access stayed with the old repository and have to be set
up again in the new one. The pre-rewrite history is bundled in
`~/orbital-pre-rewrite-backup/` on the maintainer's Mac. `gitleaks git`
over the rewritten history finds only the test values already known.

## 2. A screenshot with invented content

The README still has a placeholder where the screenshot belongs, and a
screenshot of the real map would show the maintainer's own projects.

Do not build a separate fake page. Write a script that generates a
`~/.claude`-shaped directory of invented transcripts — a few projects, a
session with subagents, one waiting for input, one ended — and run the real
app on it with `ORBITAL_CLAUDE_DIR` and `ORBITAL_DATA_DIR` pointing at it.
The screenshot then always matches the real app, and the same data can
later record a GIF.

## 3. After the flip

Turn on secret scanning with push protection and Dependabot in the GitHub
repository settings, and private vulnerability reporting — `SECURITY.md`
sends reports there, and the link is dead until it is on.

These can go on before the flip too, in the new repository: the Actions
secrets `release-mac.yml` reads, the GHCR package's Actions access for
`relay-image.yml`, the collaborators, and a release with the current DMG.
