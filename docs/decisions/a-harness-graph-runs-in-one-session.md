---
id: a-harness-graph-runs-in-one-session
title: A harness's steps form a dependency graph that one session works through
type: adr
status: in-force
domain: sessions
related:
  - 2026-10-06-harness-graph-and-proposals-design
  - 2026-09-30-session-harness-design
tags:
  - harness
---
# A harness's steps form a dependency graph that one session works through

## Context

A harness was a flat list: one active step at a time, and a waiting gate
stopped everything after it. Real work branches — independent parts can go
on while one part waits for the user. Three models were drawn on one
example (a new component, 2026-10-06): a general graph with `dependsOn` per
step, lanes joined by a join step, and phases of unordered steps.

## Decision

- Steps carry `dependsOn`; absent means the step before, so existing
  templates and harnesses keep their meaning. Any step whose dependencies
  are done is active; a gate holds back only its descendants.
- The graph is logical. **One session** works it, ticking steps one after
  another. Branches are not spawned as sessions or worktrees — the original
  spec's reason holds: the steps lean on each other's context.
- The rule "only the first unfinished step can be ticked" is dropped in
  favour of "any active step".

## Ruled out

- **Lanes + join**: a join waits for whole lanes, so a step that needs one
  step of a lane waits on the rest of it (and on any gate in it).
- **Phases**: a step waits for every step of the phase before, related or
  not.
- **A session per branch**: real parallelism, but separate contexts,
  merges between worktrees and an orchestrator — the thing the first
  harness spec ruled out.

## Consequences

- The panel needs to show a graph; it keeps the list and draws the graph
  in the gutter, like `git log --graph`.
- "The active step" is gone from the code; everything that read it reads
  the set of active steps.
- Parallel here means "open at the same time", not "running at the same
  time". If one session proves too slow, spawning branches is a later,
  separate decision.
