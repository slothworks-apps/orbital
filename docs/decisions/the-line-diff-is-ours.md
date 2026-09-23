---
id: the-line-diff-is-ours
title: The line diff is ours, not jsdiff's
type: adr
status: in-force
domain: web
related:
  - 2026-09-23-edit-diffs-in-the-transcript
  - custom-spring-sim-over-d3-force
  - stay-on-sqlite
tags:
  - transcript
  - dependencies
---
# The line diff is ours, not jsdiff's

## The problem

[[2026-09-23-edit-diffs-in-the-transcript]] needs a line diff of two
strings. The obvious move is `npm i diff` — jsdiff is the default answer,
it is correct, it is well tested and it has been maintained for a decade.
Writing a diff by hand is the kind of thing that reads as ego.

## The decision

`web/src/lib/diff.ts` implements Myers' greedy algorithm — common
prefix/suffix trim, an O((n+m)·d) walk with a recorded trace, a backtrack
that turns the distance into an edit script — in about a hundred and fifty
lines, with no dependency.

Three things decided it, and none of them is "it is only a hundred lines".

**The ceilings are the feature, not the diff.** The transcript animates its
own scroll on a `requestAnimationFrame` loop
([[the-transcript-scrolls-on-its-own-raf-loop]]) and re-reads
`scrollHeight` every frame while it follows a new message. What this
component has to guarantee is not "a correct diff" but "a bounded amount of
work and a bounded number of DOM nodes, always, including for a two
thousand line replacement". That means a cap on the input size, a cap on
the edit distance, a *graceful* degrade when either is hit (the changed
region collapses to all-removed-then-all-added, with exact counts and a
note), and a cap on rendered rows with the remainder stated. jsdiff offers
a `timeout` option, which is a different shape of answer: it fails, rather
than degrading, and it fails on wall-clock time, which is not reproducible
and so cannot be tested. Every one of our four ceilings is a named constant
a test asserts against.

**The output shape is ours anyway.** jsdiff returns changes, not hunks. The
context window, the merging of hunks that touch, the counted gaps between
them, the truncation, and the per-side trailing-newline flags are all logic
we would write on top of it — which is most of the code in the file. The
dependency would have carried the well-understood part and left us the part
with the edge cases.

**Myers is the settled part of the problem.** It is a published algorithm
from 1986 with a canonical implementation shape. It is not a moving target,
it has no security surface, and it has no platform dependencies. A
dependency earns its place by absorbing change or complexity we would
otherwise track; this one would absorb neither.

The house precedent points the same way:
[[custom-spring-sim-over-d3-force]] kept a small simulation in-repo for the
same reason — the library's shape was not the shape of the requirement.

## What it costs

A hand-written Myers is a real correctness risk, and the failure mode is
subtle: a diff that is *valid* but not minimal looks fine until you read
it. The mitigation is that the algorithm is pure and fully exercised —
`web/src/test/diff.test.ts` pins the exact row sequence for insertions,
deletions, replacements and first/last-line changes, not just the counts —
and that `coarse` gives the whole thing a floor: when the walk is refused,
the output is still correct, just less well aligned.

It also means we do not get the things jsdiff has that we have not needed
yet: word and character diffs, patch parsing, patch application. If a
future feature wants any of those — applying a patch, say, or highlighting
the changed span *within* a changed line — that is the point to revisit
this, and taking the dependency then would be the right call rather than
growing ours towards it.

## What was rejected

- **`diff` (jsdiff).** Above.
- **`fast-diff` / `diff-match-patch`.** Character-level by design. A line
  diff on top of them means the same hunking code plus a line-to-symbol
  mapping, for a worse fit.
- **Computing the diff on the server.** The SDK's `FileEditOutput` already
  carries a `structuredPatch`, so the server could forward it and no diff
  would be computed at all. Rejected for now because it is a wire change
  and a parser change for a benefit that only covers `Edit` and `Write`
  results — and it would not remove the algorithm anyway, since a running
  call has no result yet and must still render from its input. Worth
  reopening if the transcript ever needs the `originalFile` that payload
  also carries, which is the one thing that would let a `Write` become a
  real diff.
