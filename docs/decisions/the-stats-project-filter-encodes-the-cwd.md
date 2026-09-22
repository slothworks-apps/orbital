---
id: the-stats-project-filter-encodes-the-cwd
title: The stats project filter encodes the cwd
type: adr
status: in-force
domain: stats
related:
  - 2026-09-20-session-stats-design
---

# The stats project filter encodes the cwd

`GET /api/stats/overview?project=` filters on `sessions.project_dir` — the name
of the transcript directory under `~/.claude/projects`, which the indexer takes
from the directory it read. The only project list the web app has,
`GET /api/projects`, returns `cwd`s: readable paths, taken from the transcripts
themselves. The dashboard's project filter has to show one and send the other.

`web/src/stats/projects.ts` bridges the two with the CLI's own encoding — every
character that is not a letter or a digit becomes a dash — so
`/Users/t/Projects/slothworks.io` addresses
`-Users-t-Projects-slothworks-io`. Finding cards go the other way by matching:
a `project_dir` is turned back into a path by finding the cwd that encodes to
it, never by decoding, because the encoding is lossy (a dash and a slash arrive
identical).

## Why not change the endpoint

Filtering on `cwd` would have been the honest fix, and it is still the better
one. It was not taken here because the endpoint and its route tests had already
landed in an earlier task, and the dashboard needed a filter that worked
against what shipped. If the endpoint is ever revisited, have it accept a cwd
and delete this module: it is a workaround with a real failure mode.

## What breaks, and how it shows

The encoding is undocumented and belongs to a CLI that can change it under us
(the README's `~/.claude` caveats). If it does, the filter stops matching and
the dashboard reads as empty for the selected project — the wrong answer, but a
visibly wrong one, not a quietly mixed-up one. Nothing else on the page depends
on it: unfiltered views, tiles, charts and findings never encode anything.
